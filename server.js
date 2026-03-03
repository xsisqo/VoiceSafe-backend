// backend/server.js
// VoiceSafe Backend — Enterprise (stable + Confidence Engine v1 + optional stats)
// ✅ audio + video upload
// ✅ video -> extract audio (ffmpeg)
// ✅ normalize -> WAV mono 16kHz
// ✅ send to AI (/analyze)
// ✅ store case in Postgres (DATABASE_URL)
// ✅ basic endpoints: /health, /upload, /cases, /cases/:case_id
// ✅ alias endpoint: /case/:case_id
// ✅ Confidence Engine v1 computed from: scam_score, stress_level, ai_probability
// ✅ optional /stats for investor dashboard

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const FormData = require("form-data");
const { spawn } = require("child_process");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

// ===== Config =====
const PORT = process.env.PORT || 5000;
const AI_URL = process.env.AI_URL || "https://voicesafe-ai.onrender.com/analyze";
const DATABASE_URL = process.env.DATABASE_URL;

// On Render, you often need SSL for postgres
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    })
  : null;

// ===== CORS =====
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  })
);

app.use(express.json({ limit: "2mb" }));

// ===== Health =====
app.get("/", (req, res) => res.json({ ok: true, service: "voicesafe-backend" }));

app.get("/health", async (req, res) => {
  try {
    if (!pool) return res.json({ ok: true, db: false, note: "DATABASE_URL missing" });
    await pool.query("SELECT 1");
    return res.json({ ok: true, db: true });
  } catch (e) {
    return res.status(500).json({ ok: false, db: false, error: e.message });
  }
});

// ===== Uploads folder =====
const uploadsDir = path.join(__dirname, "uploads");
const tmpDir = path.join(__dirname, "tmp");

for (const d of [uploadsDir, tmpDir]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

app.use("/uploads", express.static(uploadsDir));

// ===== Multer =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

const uploadAnyAudio = upload.fields([
  { name: "audio", maxCount: 1 },
  { name: "file", maxCount: 1 },
]);

function pickUploadedFile(req) {
  const a = req.files?.audio?.[0];
  const f = req.files?.file?.[0];
  return a || f || null;
}

// ===== Helpers =====
function safeUnlink(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) {}
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    ff.stderr.on("data", (d) => (err += d.toString()));
    ff.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg failed (code ${code}): ${err.slice(-2000)}`));
    });
  });
}

function makeCaseId() {
  return `VS-${crypto.randomBytes(6).toString("hex")}-${Date.now()}`;
}

function clamp(n, a, b) {
  n = Number(n);
  if (Number.isNaN(n)) return a;
  return Math.max(a, Math.min(b, n));
}

function as01(x) {
  const n = Number(x);
  if (Number.isNaN(n)) return null;
  if (n <= 1) return clamp(n, 0, 1);
  return clamp(n / 100, 0, 1);
}

function normalizeAiResult(ai) {
  const scores = ai?.scores || ai || {};
  const scam_score = Number(scores.scam_score ?? scores.scamScore ?? 0);
  const ai_probability = Number(scores.ai_probability ?? scores.aiProbability ?? 0);
  const stress_level = Number(scores.stress_level ?? scores.stressLevel ?? 0);
  const risk_level = String(scores.risk_level ?? scores.riskLevel ?? "UNKNOWN");
  const confidence = Number(scores.confidence ?? 0);
  return { scam_score, ai_probability, stress_level, risk_level, confidence };
}

// ===== Confidence Engine v1 (BLOCK 4) =====
function computeConfidenceV1({ scam_score, stress_level, ai_probability }) {
  const scam = as01(scam_score);
  const stress = as01(stress_level);
  const aiP = as01(ai_probability);

  const s = scam ?? 0.5;
  const st = stress ?? 0.5;
  const a = aiP ?? 0.5;

  const raw = 0.15 + 0.55 * s + 0.25 * st + 0.05 * (1 - a);
  return clamp(raw, 0.05, 0.98);
}

// ===== DB init =====
async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cases (
      id SERIAL PRIMARY KEY,
      case_id TEXT UNIQUE NOT NULL,
      filename TEXT,
      mime TEXT,
      title TEXT,
      platform TEXT,
      country TEXT,
      language TEXT,
      tags TEXT,
      notes TEXT,
      scam_score REAL,
      ai_probability REAL,
      stress_level REAL,
      risk_level TEXT,
      confidence REAL,
      ai_json JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}
ensureSchema().catch((e) => console.error("DB schema init failed:", e.message));

// ===== Cases endpoints =====
app.get("/cases", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DATABASE_URL missing" });

    const q = String(req.query.q || "").trim();
    const limit = Math.min(Number(req.query.limit || 50), 200);

    let rows;
    if (q) {
      const r = await pool.query(
        `SELECT case_id, title, platform, country, language, risk_level, confidence, created_at
         FROM cases
         WHERE (title ILIKE $1 OR notes ILIKE $1 OR tags ILIKE $1 OR case_id ILIKE $1)
         ORDER BY created_at DESC
         LIMIT $2`,
        [`%${q}%`, limit]
      );
      rows = r.rows;
    } else {
      const r = await pool.query(
        `SELECT case_id, title, platform, country, language, risk_level, confidence, created_at
         FROM cases
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );
      rows = r.rows;
    }

    return res.json({ ok: true, items: rows });
  } catch (e) {
    if (res.headersSent) return;
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/cases/:case_id", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DATABASE_URL missing" });

    const case_id = req.params.case_id;
    const r = await pool.query(`SELECT * FROM cases WHERE case_id=$1 LIMIT 1`, [case_id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: "Not found" });

    return res.json({ ok: true, item: r.rows[0] });
  } catch (e) {
    if (res.headersSent) return;
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/case/:case_id", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DATABASE_URL missing" });

    const case_id = req.params.case_id;
    const r = await pool.query(`SELECT * FROM cases WHERE case_id=$1 LIMIT 1`, [case_id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: "Not found" });

    return res.json({ ok: true, item: r.rows[0] });
  } catch (e) {
    if (res.headersSent) return;
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== Optional /stats =====
app.get("/stats", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DATABASE_URL missing" });

    const total = await pool.query(`SELECT COUNT(*)::int AS c FROM cases`);
    const high7d = await pool.query(
      `SELECT COUNT(*)::int AS c FROM cases
       WHERE created_at >= NOW() - INTERVAL '7 days'
         AND (risk_level ILIKE 'HIGH' OR risk_level ILIKE 'H')`
    );
    const avgConf = await pool.query(`SELECT COALESCE(AVG(confidence), 0)::float AS v FROM cases`);
    return res.json({
      total_cases: total.rows[0].c,
      high_risk_7d: high7d.rows[0].c,
      avg_confidence: avgConf.rows[0].v,
      median_latency_ms: null,
    });
  } catch (e) {
    if (res.headersSent) return;
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== Upload + Analyze =====
app.post("/upload", uploadAnyAudio, async (req, res) => {
  let inputPath = null;
  let wavPath = null;

  try {
    const f = pickUploadedFile(req);
    if (!f) return res.status(400).json({ status: "error", message: "No file uploaded" });

    inputPath = f.path;

    wavPath = path.join(tmpDir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.wav`);
    await runFfmpeg(["-y", "-i", inputPath, "-ac", "1", "-ar", "16000", "-vn", "-c:a", "pcm_s16le", wavPath]);

    const form = new FormData();
    form.append("file", fs.createReadStream(wavPath), {
      filename: "audio.wav",
      contentType: "audio/wav",
    });

    const aiResp = await axios.post(AI_URL, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      timeout: 120000,
    });

    const ai = aiResp.data;
    const normalized = normalizeAiResult(ai);

    let conf01 = as01(normalized.confidence);
    if (conf01 === null || conf01 === 0) conf01 = computeConfidenceV1(normalized);

    const case_id = makeCaseId();

    if (pool) {
      await pool.query(
        `INSERT INTO cases
         (case_id, filename, mime,
          scam_score, ai_probability, stress_level, risk_level, confidence, ai_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          case_id,
          f.filename,
          f.mimetype || "",
          normalized.scam_score,
          normalized.ai_probability,
          normalized.stress_level,
          normalized.risk_level,
          conf01,
          ai,
        ]
      );
    }

    const out = {
      ...ai,
      scores: {
        ...(ai?.scores || {}),
        confidence: conf01,
      },
    };

    return res.json({
      status: "success",
      message: "File uploaded + normalized + analyzed",
      case_id,
      filename: f.filename,
      ai: out,
    });
  } catch (err) {
    console.error("UPLOAD/ANALYZE ERROR:", err?.response?.data || err.message);
    if (res.headersSent) return;
    return res.status(500).json({
      status: "error",
      message: "Analyze failed",
      detail: err?.response?.data || err.message,
    });
  } finally {
    safeUnlink(wavPath);
  }
});

app.listen(PORT, () => {
  console.log(`VoiceSafe backend running on port ${PORT}`);
  console.log(`AI_URL: ${AI_URL}`);
  console.log(`DB: ${DATABASE_URL ? "enabled" : "disabled (DATABASE_URL missing)"}`);
});