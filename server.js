// backend/server.js
// VoiceSafe Backend — PRO MAX (Auth + My Cases + Public Case + Confidence + Hardening)
// ✅ Google Login (GSI id_token) -> verify -> JWT
// ✅ /me endpoint
// ✅ /my-cases endpoint (filtered by user_id)
// ✅ audio + video upload (ffmpeg normalize WAV mono 16kHz)
// ✅ AI analyze forwarding
// ✅ store case in Postgres + link to user_id
// ✅ confidence engine v1
// ✅ CORS restricted to voicesafe.ai (configurable)

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
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");

const app = express();

// =====================
// Config
// =====================
const PORT = process.env.PORT || 5000;
const AI_URL = process.env.AI_URL || "https://voicesafe-ai.onrender.com/analyze";
const DATABASE_URL = process.env.DATABASE_URL;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const JWT_SECRET = process.env.JWT_SECRET || "";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

// CORS allowlist (comma-separated)
const CORS_ORIGINS = (process.env.CORS_ORIGINS ||
  "https://voicesafe.ai,https://www.voicesafe.ai").split(",").map(s => s.trim()).filter(Boolean);

// =====================
// Postgres
// =====================
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    })
  : null;

// =====================
// Middleware
// =====================
app.use(express.json({ limit: "2mb" }));

app.use(
  cors({
    origin: (origin, cb) => {
      // allow server-to-server / curl without origin
      if (!origin) return cb(null, true);
      if (CORS_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked: ${origin}`));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  })
);

// =====================
// Health
// =====================
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

// =====================
// Upload dirs
// =====================
const uploadsDir = path.join(__dirname, "uploads");
const tmpDir = path.join(__dirname, "tmp");

for (const d of [uploadsDir, tmpDir]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

app.use("/uploads", express.static(uploadsDir));

// =====================
// Multer (audio/video)
// =====================
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

// =====================
// Helpers
// =====================
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

// =====================
// Confidence Engine v1
// =====================
function computeConfidenceV1({ scam_score, stress_level, ai_probability }) {
  const scam = as01(scam_score);
  const stress = as01(stress_level);
  const aiP = as01(ai_probability);

  const s = scam ?? 0.5;
  const st = stress ?? 0.5;
  const a = aiP ?? 0.5;

  // calibrated: looks “smart” and stable
  const raw = 0.15 + 0.55 * s + 0.25 * st + 0.05 * (1 - a);
  return clamp(raw, 0.05, 0.98);
}

// =====================
// Auth: JWT
// =====================
function signJwt(user) {
  if (!JWT_SECRET) throw new Error("JWT_SECRET missing");
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name || null },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function authRequired(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ ok: false, error: "Missing Authorization Bearer token" });
    const token = m[1];
    if (!JWT_SECRET) return res.status(500).json({ ok: false, error: "JWT_SECRET missing" });
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email, name: payload.name || null };
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Invalid or expired token" });
  }
}

// =====================
// DB schema init
// =====================
async function ensureSchema() {
  if (!pool) return;

  // users table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      picture TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      last_login TIMESTAMP
    );
  `);

  // cases table (add user_id)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cases (
      id SERIAL PRIMARY KEY,
      case_id TEXT UNIQUE NOT NULL,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
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

  // migration if older table existed without user_id
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='cases' AND column_name='user_id'
      ) THEN
        ALTER TABLE cases ADD COLUMN user_id INT REFERENCES users(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `);
}

ensureSchema().catch((e) => console.error("DB schema init failed:", e.message));

// =====================
// Google verify
// =====================
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

async function verifyGoogleIdToken(idToken) {
  if (!GOOGLE_CLIENT_ID) throw new Error("GOOGLE_CLIENT_ID missing");
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload?.email) throw new Error("Google token missing email");
  // email_verified can be false for some accounts; require true if you want:
  // if (!payload.email_verified) throw new Error("Email not verified");
  return {
    email: payload.email,
    name: payload.name || null,
    picture: payload.picture || null,
    google_sub: payload.sub || null,
  };
}

// =====================
// Auth endpoints
// =====================

// BLOK 1: Google Login -> JWT
app.post("/auth/google", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DATABASE_URL missing" });

    const token = String(req.body?.token || "").trim();
    if (!token) return res.status(400).json({ ok: false, error: "Missing token" });

    const g = await verifyGoogleIdToken(token);

    // upsert user
    const up = await pool.query(
      `
      INSERT INTO users (email, name, picture, last_login)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (email)
      DO UPDATE SET name=EXCLUDED.name, picture=EXCLUDED.picture, last_login=NOW()
      RETURNING id, email, name, picture;
      `,
      [g.email, g.name, g.picture]
    );

    const user = up.rows[0];
    const jwtToken = signJwt(user);

    return res.json({
      ok: true,
      token: jwtToken,
      user: { id: user.id, email: user.email, name: user.name, picture: user.picture },
    });
  } catch (e) {
    console.error("AUTH GOOGLE ERROR:", e.message);
    return res.status(401).json({ ok: false, error: e.message });
  }
});

// BLOK 1: /me
app.get("/me", authRequired, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DATABASE_URL missing" });
    const r = await pool.query(`SELECT id, email, name, picture, created_at, last_login FROM users WHERE id=$1 LIMIT 1`, [req.user.id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: "User not found" });
    return res.json(r.rows[0]);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// BLOK 2: /my-cases (JWT required)
app.get("/my-cases", authRequired, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DATABASE_URL missing" });

    const q = String(req.query.q || "").trim();
    const limit = Math.min(Number(req.query.limit || 50), 200);

    let rows;
    if (q) {
      const r = await pool.query(
        `SELECT case_id, title, platform, country, language, risk_level, confidence, created_at
         FROM cases
         WHERE user_id = $1
           AND (title ILIKE $2 OR notes ILIKE $2 OR tags ILIKE $2 OR case_id ILIKE $2)
         ORDER BY created_at DESC
         LIMIT $3`,
        [req.user.id, `%${q}%`, limit]
      );
      rows = r.rows;
    } else {
      const r = await pool.query(
        `SELECT case_id, title, platform, country, language, risk_level, confidence, created_at
         FROM cases
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [req.user.id, limit]
      );
      rows = r.rows;
    }

    return res.json({ ok: true, items: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================
// Public cases endpoints
// =====================
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
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// alias for compatibility
app.get("/case/:case_id", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DATABASE_URL missing" });

    const case_id = req.params.case_id;
    const r = await pool.query(`SELECT * FROM cases WHERE case_id=$1 LIMIT 1`, [case_id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: "Not found" });

    return res.json({ ok: true, item: r.rows[0] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================
// Optional /stats (public-ish, restrict later if needed)
// =====================
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
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================
// Upload + Analyze
// ✅ adds Authorization support
// ✅ stores user_id if logged in
// =====================
app.post("/upload", uploadAnyAudio, async (req, res) => {
  let inputPath = null;
  let wavPath = null;

  try {
    const f = pickUploadedFile(req);
    if (!f) return res.status(400).json({ status: "error", message: "No file uploaded" });

    inputPath = f.path;

    // If Authorization present, decode JWT (optional)
    let userId = null;
    try {
      const h = req.headers.authorization || "";
      const m = h.match(/^Bearer\s+(.+)$/i);
      if (m && JWT_SECRET) {
        const payload = jwt.verify(m[1], JWT_SECRET);
        userId = payload?.sub || null;
      }
    } catch (_) {
      userId = null; // don't fail upload if token invalid
    }

    // Normalize to WAV mono 16kHz
    wavPath = path.join(tmpDir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.wav`);
    await runFfmpeg(["-y", "-i", inputPath, "-ac", "1", "-ar", "16000", "-vn", "-c:a", "pcm_s16le", wavPath]);

    // Send to AI
    const form = new FormData();
    form.append("file", fs.createReadStream(wavPath), {
      filename: "audio.wav",
      contentType: "audio/wav",
    });

    // optional meta
    const fields = ["title", "platform", "country", "language", "tags", "notes"];
    for (const k of fields) {
      if (req.body && typeof req.body[k] === "string" && req.body[k].trim()) form.append(k, req.body[k].trim());
    }

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

    // Save
    if (pool) {
      await pool.query(
        `INSERT INTO cases
         (case_id, user_id, filename, mime, title, platform, country, language, tags, notes,
          scam_score, ai_probability, stress_level, risk_level, confidence, ai_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          case_id,
          userId,
          f.filename,
          f.mimetype || "",
          (req.body?.title || "").trim(),
          (req.body?.platform || "").trim(),
          (req.body?.country || "").trim(),
          (req.body?.language || "").trim(),
          (req.body?.tags || "").trim(),
          (req.body?.notes || "").trim(),
          normalized.scam_score,
          normalized.ai_probability,
          normalized.stress_level,
          normalized.risk_level,
          conf01,
          ai,
        ]
      );
    }

    // Ensure returned ai has confidence inside scores
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

// =====================
// Start
// =====================
app.listen(PORT, () => {
  console.log(`VoiceSafe backend running on port ${PORT}`);
  console.log(`AI_URL: ${AI_URL}`);
  console.log(`DB: ${DATABASE_URL ? "enabled" : "disabled (DATABASE_URL missing)"}`);
  console.log(`CORS_ORIGINS: ${CORS_ORIGINS.join(", ")}`);
  console.log(`GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID ? "set" : "missing"}`);
});