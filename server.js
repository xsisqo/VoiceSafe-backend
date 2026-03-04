// backend/server.js
// VoiceSafe Backend — Enterprise PRO
// ✅ Google Login (GSI): POST /auth/google (id_token -> verify -> app JWT)
// ✅ /me (JWT payload)
// ✅ /upload (audio+video -> ffmpeg -> AI -> DB)
// ✅ /cases, /cases/:case_id, /case/:case_id
// ✅ /my-cases (JWT required, filter by user_sub)
// ✅ Confidence Engine v1 (computed if missing)
// ✅ CORS hardening + Helmet + Rate limit

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

const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");

const app = express();

// =========================
// Config
// =========================
const PORT = process.env.PORT || 5000;
const AI_URL = process.env.AI_URL || "https://voicesafe-ai.onrender.com/analyze";
const DATABASE_URL = process.env.DATABASE_URL;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const APP_JWT_SECRET = process.env.APP_JWT_SECRET || ""; // MUST set in Render

// comma-separated allowed origins
// default = production domains only
const CORS_ORIGINS = (process.env.CORS_ORIGINS ||
  "https://voicesafe.ai,https://www.voicesafe.ai")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// Postgres (Render SSL)
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    })
  : null;

// =========================
// Middleware
// =========================
app.use(
  cors({
    origin: function (origin, cb) {
      // allow server-to-server / curl (no origin)
      if (!origin) return cb(null, true);

      // strict allowlist
      if (CORS_ORIGINS.includes(origin)) return cb(null, true);

      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  })
);

app.use(helmet());
app.use(express.json({ limit: "2mb" }));

// rate limit (safe defaults)
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// =========================
// Auth helpers
// =========================
function getBearer(req) {
  const h = req.header("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

function authOptional(req, _res, next) {
  try {
    const token = getBearer(req);
    if (!token || !APP_JWT_SECRET) return next();
    req.user = jwt.verify(token, APP_JWT_SECRET);
    return next();
  } catch {
    return next();
  }
}

function authRequired(req, res, next) {
  const token = getBearer(req);
  if (!token) return res.status(401).json({ ok: false, error: "Missing token" });
  if (!APP_JWT_SECRET) return res.status(500).json({ ok: false, error: "APP_JWT_SECRET missing" });

  try {
    req.user = jwt.verify(token, APP_JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}

// =========================
// Health
// =========================
app.get("/", (req, res) => res.json({ ok: true, service: "voicesafe-backend" }));

app.get("/health", async (req, res) => {
  try {
    if (!pool) {
      return res.json({
        ok: true,
        db: false,
        note: "DATABASE_URL missing",
        google: !!GOOGLE_CLIENT_ID,
        jwt: !!APP_JWT_SECRET,
        cors_origins: CORS_ORIGINS,
      });
    }
    await pool.query("SELECT 1");
    return res.json({
      ok: true,
      db: true,
      google: !!GOOGLE_CLIENT_ID,
      jwt: !!APP_JWT_SECRET,
      cors_origins: CORS_ORIGINS,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, db: false, error: e.message });
  }
});

// =========================
// Google Login (GSI)
// =========================
// Frontend sends: { id_token: <GSI response.credential> }
app.post("/auth/google", async (req, res) => {
  try {
    if (!googleClient) return res.status(500).json({ ok: false, error: "GOOGLE_CLIENT_ID missing" });
    if (!APP_JWT_SECRET) return res.status(500).json({ ok: false, error: "APP_JWT_SECRET missing" });

    const { id_token } = req.body || {};
    if (!id_token) return res.status(400).json({ ok: false, error: "id_token missing" });

    const ticket = await googleClient.verifyIdToken({
      idToken: id_token,
      audience: GOOGLE_CLIENT_ID,
    });

    const p = ticket.getPayload() || {};
    const user = {
      sub: String(p.sub || ""),
      email: String(p.email || ""),
      name: String(p.name || ""),
      picture: String(p.picture || ""),
    };

    if (!user.sub) return res.status(401).json({ ok: false, error: "Invalid Google token" });

    const token = jwt.sign(user, APP_JWT_SECRET, { expiresIn: "30d" });
    return res.json({ ok: true, user, token });
  } catch (e) {
    return res.status(401).json({ ok: false, error: e.message });
  }
});

app.get("/me", authRequired, async (req, res) => {
  return res.json({ ok: true, user: req.user });
});

// =========================
// Upload folders
// =========================
const uploadsDir = path.join(__dirname, "uploads");
const tmpDir = path.join(__dirname, "tmp");
for (const d of [uploadsDir, tmpDir]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
app.use("/uploads", express.static(uploadsDir));

// =========================
// Multer
// =========================
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

// =========================
// Helpers
// =========================
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

// Confidence Engine v1 (stable, monotonic-ish)
function computeConfidenceV1({ scam_score, stress_level, ai_probability }) {
  const scam = as01(scam_score) ?? 0.5;
  const stress = as01(stress_level) ?? 0.5;
  const aiP = as01(ai_probability) ?? 0.5;

  // weighted + bounded
  const raw = 0.18 + 0.58 * scam + 0.22 * stress + 0.02 * (1 - aiP);
  return clamp(raw, 0.06, 0.98);
}

// =========================
// DB schema (with user columns)
// =========================
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

      user_sub TEXT,
      user_email TEXT,

      scam_score REAL,
      ai_probability REAL,
      stress_level REAL,
      risk_level TEXT,
      confidence REAL,
      ai_json JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // safe “migrations”
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS user_sub TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS user_email TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cases_user_sub ON cases(user_sub);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cases_created_at ON cases(created_at DESC);`);
}
ensureSchema().catch((e) => console.error("DB schema init failed:", e.message));

// =========================
// Cases endpoints (public)
// =========================
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

// Alias
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

// =========================
// My Cases (BLOCK 2) — JWT required
// =========================
app.get("/my-cases", authRequired, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DATABASE_URL missing" });

    const limit = Math.min(Number(req.query.limit || 50), 200);
    const user_sub = String(req.user?.sub || "");
    if (!user_sub) return res.status(401).json({ ok: false, error: "Invalid user" });

    const r = await pool.query(
      `SELECT case_id, title, platform, country, language, risk_level, confidence, created_at
       FROM cases
       WHERE user_sub = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [user_sub, limit]
    );

    return res.json({ ok: true, items: r.rows });
  } catch (e) {
    if (res.headersSent) return;
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// =========================
// Upload + Analyze
// =========================
app.post("/upload", authOptional, uploadAnyAudio, async (req, res) => {
  let wavPath = null;

  try {
    const f = pickUploadedFile(req);
    if (!f) return res.status(400).json({ status: "error", message: "No file uploaded" });

    // Convert to WAV mono 16kHz
    wavPath = path.join(tmpDir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.wav`);
    await runFfmpeg(["-y", "-i", f.path, "-ac", "1", "-ar", "16000", "-vn", "-c:a", "pcm_s16le", wavPath]);

    // Send to AI
    const form = new FormData();
    form.append("file", fs.createReadStream(wavPath), { filename: "audio.wav", contentType: "audio/wav" });

    const fields = ["title", "platform", "country", "language", "tags", "notes"];
    for (const k of fields) {
      if (req.body && typeof req.body[k] === "string" && req.body[k].trim()) {
        form.append(k, req.body[k].trim());
      }
    }

    const aiResp = await axios.post(AI_URL, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      timeout: 120000,
    });

    const ai = aiResp.data;
    const normalized = normalizeAiResult(ai);

    // confidence fallback
    let conf01 = as01(normalized.confidence);
    if (conf01 === null || conf01 <= 0) conf01 = computeConfidenceV1(normalized);

    const outAi = {
      ...ai,
      scores: {
        ...(ai?.scores || {}),
        confidence: conf01,
      },
    };

    // Store
    const case_id = makeCaseId();

    const user_sub = req.user?.sub ? String(req.user.sub) : null;
    const user_email = req.user?.email ? String(req.user.email) : null;

    if (pool) {
      await pool.query(
        `INSERT INTO cases
         (case_id, filename, mime, title, platform, country, language, tags, notes,
          user_sub, user_email,
          scam_score, ai_probability, stress_level, risk_level, confidence, ai_json)
         VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          case_id,
          f.filename,
          f.mimetype || "",
          (req.body?.title || "").trim(),
          (req.body?.platform || "").trim(),
          (req.body?.country || "").trim(),
          (req.body?.language || "").trim(),
          (req.body?.tags || "").trim(),
          (req.body?.notes || "").trim(),
          user_sub,
          user_email,
          normalized.scam_score,
          normalized.ai_probability,
          normalized.stress_level,
          normalized.risk_level,
          conf01,
          outAi,
        ]
      );
    }

    return res.json({
      status: "success",
      message: "File uploaded + normalized + analyzed",
      case_id,
      filename: f.filename,
      ai: outAi,
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

// =========================
// Start
// =========================
app.listen(PORT, () => {
  console.log(`VoiceSafe backend running on port ${PORT}`);
  console.log(`AI_URL: ${AI_URL}`);
  console.log(`DB: ${DATABASE_URL ? "enabled" : "disabled (DATABASE_URL missing)"}`);
  console.log(`CORS_ORIGINS: ${CORS_ORIGINS.join(", ")}`);
  console.log(`GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID ? "set" : "missing"}`);
  console.log(`APP_JWT_SECRET: ${APP_JWT_SECRET ? "set" : "missing"}`);
});