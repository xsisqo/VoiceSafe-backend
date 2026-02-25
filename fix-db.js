// backend/fix-db.js
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL env.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  console.log("Connecting to DB...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      title TEXT,
      platform TEXT,
      country TEXT,
      language TEXT,
      tags TEXT,
      notes TEXT,

      original_name TEXT,
      mime TEXT,
      bytes BIGINT,

      summary TEXT,
      ai_probability INT,
      stress_level INT,
      scam_score INT,
      flags TEXT,
      voice_match TEXT
    );
  `);

  // If old schema exists without scam_score etc, try to add columns safely
  const safeAdds = [
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS scam_score INT;`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS ai_probability INT;`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS stress_level INT;`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS flags TEXT;`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS voice_match TEXT;`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS original_name TEXT;`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS mime TEXT;`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS bytes BIGINT;`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS notes TEXT;`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS tags TEXT;`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS language TEXT;`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS country TEXT;`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS platform TEXT;`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS title TEXT;`
  ];

  for (const q of safeAdds) {
    try {
      await pool.query(q);
    } catch (e) {
      // ignore
    }
  }

  console.log("Database updated successfully!");
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});