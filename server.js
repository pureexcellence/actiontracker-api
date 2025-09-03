import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pkg;

const app = express();
const port = process.env.PORT || 3000;

// Eigen simpele logger
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

app.use(cors({
  origin: process.env.FRONTEND_ORIGINS?.split(',') || '*'
}));
app.use(express.json());

// Database pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Query helper
async function query(sql, params = []) {
  try {
    console.log("SQL:", sql, "\nPARAMS:", params);
    const result = await pool.query(sql, params);
    return result;
  } catch (err) {
    console.error("DB ERROR:", err.message, "\nSQL:\n", sql, "\nPARAMS:", params);
    throw err;
  }
}

// Schema check
async function ensureSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS public.trackers (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log("✅ Schema ensured");
}

// Routes
app.get('/health', async (req, res) => {
  try {
    await query('SELECT 1 as ok');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/trackers', async (req, res) => {
  try {
    const result = await query('SELECT * FROM public.trackers ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/trackers', async (req, res) => {
  try {
    const { name } = req.body;
    const result = await query(
      'INSERT INTO public.trackers (name) VALUES ($1) RETURNING *',
      [name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(port, async () => {
  console.log(`✅ API running on http://localhost:${port}`);
  try {
    await ensureSchema();
  } catch (err) {
    console.error("❌ Failed to init schema:", err);
  }
});