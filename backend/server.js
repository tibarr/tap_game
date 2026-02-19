const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const dbPath = path.join(__dirname, 'leaderboard.db');
const db = new sqlite3.Database(dbPath);

db.run(`
    CREATE TABLE IF NOT EXISTS players (
        user_id TEXT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        score INTEGER DEFAULT 0,
        last_update INTEGER
    )
`);

db.run(`
    CREATE TABLE IF NOT EXISTS purchases (
        telegram_payment_charge_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        currency TEXT NOT NULL,
        total_amount INTEGER NOT NULL,
        air_amount INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    )
`);

app.get('/', (req, res) => {
    res.type('text').send('OK. Use /api/leaderboard');
});

app.get('/health', (req, res) => {
    res.json({ ok: true });
});

app.get('/api/leaderboard', (req, res) => {
    db.all(
        'SELECT user_id, username, first_name, score FROM players ORDER BY score DESC LIMIT 10',
        [],
        (err, rows) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ error: 'Database error' });
            }
            res.json(rows);
        }
    );
});

function getEnv(name) {
    const v = process.env[name];
    return (v && v.trim()) ? v.trim() : null;
}

const TELEGRAM_BOT_TOKEN = getEnv('TELEGRAM_BOT_TOKEN');
const TELEGRAM_WEBHOOK_SECRET = getEnv('TELEGRAM_WEBHOOK_SECRET'); // опционально

async function telegramApi(method, payload) {
    if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set');
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
        const desc = data?.description || `HTTP ${res.status}`;
        throw new Error(`Telegram API error: ${desc}`);
    }
    return data.result;
}

function incrementPlayerScore({ user_id, username, first_name, delta }) {
    return new Promise((resolve, reject) => {
        const last_update = Date.now();
        db.run(
            `INSERT INTO players (user_id, username, first_name, score, last_update)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET
                username = excluded.username,
                first_name = excluded.first_name,
                score = players.score + excluded.score,
                last_update = excluded.last_update`,
            [user_id, username || null, first_name || null, delta, last_update],
            function (err) {
                if (err) return reject(err);
                resolve();
            }
        );
    });
}

// Создать invoice link для Telegram Stars (10 ⭐ -> 1000 AIR)
app.post('/api/payments/stars/invoice-link', async (req, res) => {
    try {
        const { user_id } = req.body || {};
        if (!user_id) return res.status(400).json({ error: 'Missing user_id' });

        // Важно: для XTR provider_token должен быть пустой строкой,
        // а prices должен содержать ровно один элемент.
        const payload = JSON.stringify({
            kind: 'stars_pack',
            user_id: String(user_id),
            air_amount: 1000,
            stars_amount: 10
        });

        const invoiceLink = await telegramApi('createInvoiceLink', {
            title: 'AIR COIN',
            description: 'Покупка +1000 AIR за 10 ⭐',
            payload,
            provider_token: '',
            currency: 'XTR',
            prices: [{ label: '1000 AIR', amount: 10 }]
        });

        res.json({ invoice_link: invoiceLink });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: String(e?.message || e) });
    }
});

// Webhook для Telegram updates (successful_payment)
app.post('/telegram/webhook', async (req, res) => {
    try {
        if (TELEGRAM_WEBHOOK_SECRET) {
            const got = req.header('x-telegram-bot-api-secret-token');
            if (got !== TELEGRAM_WEBHOOK_SECRET) return res.status(401).send('bad secret');
        }

        const update = req.body || {};
        const msg = update.message;
        const sp = msg?.successful_payment;
        if (!sp) return res.json({ ok: true });

        // Stars payments приходят с currency = XTR
        if (sp.currency !== 'XTR') return res.json({ ok: true });

        const chargeId = sp.telegram_payment_charge_id;
        if (!chargeId) return res.json({ ok: true });

        // payload задавали как JSON
        let invoicePayload = null;
        try { invoicePayload = JSON.parse(sp.invoice_payload || '{}'); } catch { invoicePayload = {}; }
        const airAmount = Number(invoicePayload.air_amount || 0);
        if (!airAmount) return res.json({ ok: true });

        const userId = String(invoicePayload.user_id || msg?.from?.id || '');
        const username = msg?.from?.username || null;
        const firstName = msg?.from?.first_name || null;

        // Идемпотентность: не начислять дважды по одному charge id
        const now = Date.now();
        const inserted = await new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO purchases (telegram_payment_charge_id, user_id, currency, total_amount, air_amount, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [chargeId, userId, sp.currency, sp.total_amount || 0, airAmount, now],
                function (err) {
                    if (!err) return resolve(true);
                    // sqlite duplicate key
                    if (String(err?.message || '').includes('SQLITE_CONSTRAINT')) return resolve(false);
                    reject(err);
                }
            );
        });

        if (inserted) {
            await incrementPlayerScore({ user_id: userId, username, first_name: firstName, delta: airAmount });
            // Можно отправить подтверждение в чат
            try {
                await telegramApi('sendMessage', {
                    chat_id: msg.chat.id,
                    text: `✅ Оплата прошла! Начислено +${airAmount} AIR`
                });
            } catch (e) {
                console.error('sendMessage failed', e);
            }
        }

        res.json({ ok: true });
    } catch (e) {
        console.error(e);
        res.status(200).json({ ok: true });
    }
});

app.post('/api/update-score', (req, res) => {
    const { user_id, username, first_name, score } = req.body;
    
    if (!user_id || score === undefined) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const last_update = Date.now();

    db.run(
        `INSERT INTO players (user_id, username, first_name, score, last_update)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
            username = excluded.username,
            first_name = excluded.first_name,
            score = excluded.score,
            last_update = excluded.last_update`,
        [user_id, username || null, first_name || null, score, last_update],
        function(err) {
            if (err) {
                console.error(err);
                return res.status(500).json({ error: 'Database error' });
            }
            res.json({ success: true });
        }
    );
});

app.get('/api/player-rank/:user_id', (req, res) => {
    const userId = req.params.user_id;
    
    db.get('SELECT score FROM players WHERE user_id = ?', [userId], (err, player) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        if (!player) {
            return res.json({ rank: null, score: 0 });
        }
        
        db.get(
            'SELECT COUNT(*) as rank FROM players WHERE score > ?',
            [player.score],
            (err, result) => {
                if (err) {
                    console.error(err);
                    return res.status(500).json({ error: 'Database error' });
                }
                res.json({
                    rank: result.rank + 1,
                    score: player.score
                });
            }
        );
    });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`✅ Leaderboard API running on port ${PORT}`);
});