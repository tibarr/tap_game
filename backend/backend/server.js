const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================
// 1. ПОДКЛЮЧЕНИЕ К БАЗЕ ДАННЫХ
// ============================================
const dbPath = path.join(__dirname, 'leaderboard.db');
const db = new sqlite3.Database(dbPath);

// Создаём таблицу, если её нет
db.run(`
    CREATE TABLE IF NOT EXISTS players (
        user_id TEXT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        score INTEGER DEFAULT 0,
        last_update INTEGER
    )
`);

// ============================================
// 2. API: ПОЛУЧИТЬ ТОП-10
// ============================================
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

// ============================================
// 3. API: ОБНОВИТЬ/ДОБАВИТЬ СЧЁТ ИГРОКА
// ============================================
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

// ============================================
// 4. API: ПОЛУЧИТЬ МЕСТО ИГРОКА
// ============================================
app.get('/api/player-rank/:user_id', (req, res) => {
    const userId = req.params.user_id;
    
    // Получаем счёт игрока
    db.get('SELECT score FROM players WHERE user_id = ?', [userId], (err, player) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        if (!player) {
            return res.json({ rank: null, score: 0 });
        }
        
        // Считаем, сколько игроков имеют счёт больше
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