// backend/server.js
// VoiceSafe Backend — Enterprise (stable) + Google Login (GSI)
// ✅ audio + video upload
// ✅ normalize -> WAV mono 16kHz
// ✅ send to AI (/analyze)
// ✅ store case in Postgres (DATABASE_URL)
// ✅ endpoints: /health, /upload, /cases, /cases/:case_id, /cases/search, /audit/recent
// ✅ alias: /case/:case_id
// ✅ Google login: POST /auth/google (GSI id_token -> verify -> app JWT)
// ✅ /me returns JWT payload
// ✅ Live streaming: /stream/start, /stream/chunk (2s chunks)
// ✅ fixes: ERR_HTTP_HEADERS_SENT guard + correct AI_URL + remove broken OAuth redirect flow + no duplicate const

"use strict";

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
const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");

const app = express();

// ===========================
// Config
// ===========================
const PORT = process.env.PORT || 5000;

// IMPORTANT: plain URL, NOT markdown
const AI_URL = String(process.env.AI_URL || "https://voicesafe-ai.onrender.com/analyze").trim();

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();

// App JWT secret (MUST set on Render)
const APP_JWT_SECRET = String(process.env.APP_JWT_SECRET || "").trim();

// Frontend URL (optional info)
const FRONTEND_URL = String(process.env.FRONTEND_URL || "https://voicesafe.ai").trim();

// Google GSI client id
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || "").trim();
const GOOGLE_CLIENT_SECRET = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
const BACKEND_URL = String(process.env.BACKEND_URL || "https://voicesafe-backend-1.onrender.com").trim();
const googleOAuthClient =
  GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET
    ? new OAuth2Client(
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        `${BACKEND_URL}/auth/google/callback`
      )
    : null;

// Enterprise API keys (comma-separated). First key = admin key.
const VS_API_KEYS = String(process.env.VS_API_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ADMIN_KEY = VS_API_KEYS[0] || "";

const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// Postgres (Render often requires SSL)
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    })
  : null;

// ===========================
// CORS + JSON
// ===========================
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  })
);
app.use(express.json({ limit: "2mb" }));

// ===========================
// Helpers
// ===========================
function guardHeadersSent(res) {
  return !!res.headersSent;
}

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

function scoreTo01(v) {
  // accepts 0..1 or 0..100
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  if (n >= 0 && n <= 1) return n;
  if (n >= 0 && n <= 100) return n / 100;
  return clamp(n, 0, 1);
}

function normalizeAiResult(ai) {
  const scores = ai?.scores || ai || {};

  const scam_score = scoreTo01(
    scores.scam_score ?? scores.scamScore ?? scores.risk_score ?? scores.riskScore ?? 0
  );
  const ai_probability = scoreTo01(scores.ai_probability ?? scores.aiProbability ?? 0);
  const stress_level = scoreTo01(scores.stress_level ?? scores.stressLevel ?? 0);
  const risk_level = String(scores.risk_level ?? scores.riskLevel ?? scores.level ?? "UNKNOWN");
  const confidence = scoreTo01(scores.confidence ?? 0);

  return { scam_score, ai_probability, stress_level, risk_level, confidence };
}

// ===========================
// Auth helpers (JWT)
// ===========================
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

// ===========================
// API key helpers
// ===========================
function getApiKey(req) {
  return (req.header("x-api-key") || req.header("X-API-Key") || "").trim();
}

function apiKeyOptional(req, _res, next) {
  // dev mode if no keys configured
  if (!VS_API_KEYS.length) return next();
  const k = getApiKey(req);
  if (!k) return next();
  req.apiKey = k;
  req.isAdmin = ADMIN_KEY && k === ADMIN_KEY;
  return next();
}

function apiKeyRequired(req, res, next) {
  if (!VS_API_KEYS.length) return next(); // dev mode
  const k = getApiKey(req);
  if (!k) return res.status(401).json({ ok: false, error: "Missing x-api-key" });
  if (!VS_API_KEYS.includes(k)) return res.status(403).json({ ok: false, error: "Invalid API key" });
  req.apiKey = k;
  req.isAdmin = ADMIN_KEY && k === ADMIN_KEY;
  return next();
}

function adminRequired(req, res, next) {
  if (!VS_API_KEYS.length) return next(); // dev mode
  const k = getApiKey(req);
  if (!k) return res.status(401).json({ ok: false, error: "Missing x-api-key" });
  if (!ADMIN_KEY || k !== ADMIN_KEY) return res.status(403).json({ ok: false, error: "Admin key required" });
  req.apiKey = k;
  req.isAdmin = true;
  return next();
}

// ===========================
// Audit (DB table)
// ===========================
async function ensureAudit() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP DEFAULT NOW(),
      action TEXT,
      meta JSONB
    );
  `);
}
ensureAudit().catch((e) => console.warn("audit table init failed:", e.message));

async function audit(action, meta) {
  try {
    if (!pool) return;
    await pool.query(`INSERT INTO audit(action, meta) VALUES ($1, $2)`, [String(action || ""), meta || {}]);
  } catch (e) {
    console.warn("audit failed:", e.message);
  }
}

// ===========================
// Health
// ===========================
app.get("/", (_req, res) => res.json({ ok: true, service: "voicesafe-backend" }));

app.get("/health", apiKeyOptional, async (_req, res) => {
  try {
    let dbOk = false;
    if (pool) {
      await pool.query("SELECT 1");
      dbOk = true;
    }
    return res.json({
      ok: true,
      db: dbOk,
      ai_url: AI_URL,
      api_keys: VS_API_KEYS.length ? true : false,
      admin_key: !!ADMIN_KEY,
      google: !!GOOGLE_CLIENT_ID,
      jwt: !!APP_JWT_SECRET,
      frontend: FRONTEND_URL,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ===========================
// Google Login
// 1) GET /auth/google -> redirect OAuth (mobile friendly)
// 2) GET /auth/google/callback -> create app JWT
// 3) POST /auth/google -> GSI id_token -> create app JWT
// ===========================

// Mobile / redirect flow
app.get("/auth/google", (req, res) => {
  try {
    if (!googleOAuthClient) {
      return res.status(500).send("Google OAuth not configured");
    }

    const returnTo =
      typeof req.query.returnTo === "string" && req.query.returnTo.trim()
        ? req.query.returnTo.trim()
        : FRONTEND_URL;

    const state = Buffer.from(JSON.stringify({ returnTo })).toString("base64url");

    const url = googleOAuthClient.generateAuthUrl({
  access_type: "online",
  prompt: "select_account",
  scope: ["openid", "email", "profile"],
  redirect_uri: `${BACKEND_URL}/auth/google/callback`,
  state,
});

    return res.redirect(url);
  } catch (e) {
    console.error("GET /auth/google error:", e);
    return res.status(500).send("Google login start failed");
  }
});

// OAuth callback
app.get("/auth/google/callback", async (req, res) => {
  try {
    if (!googleOAuthClient) {
      return res.redirect(`${FRONTEND_URL}?login=error&reason=google_oauth_not_configured`);
    }
    if (!APP_JWT_SECRET) {
      return res.redirect(`${FRONTEND_URL}?login=error&reason=app_jwt_missing`);
    }

    const code = req.query.code;
    const stateRaw = typeof req.query.state === "string" ? req.query.state : "";
    const stateJson = stateRaw
      ? JSON.parse(Buffer.from(stateRaw, "base64url").toString("utf8"))
      : {};

    const returnTo = stateJson?.returnTo || FRONTEND_URL;

    if (!code || typeof code !== "string") {
      return res.redirect(`${FRONTEND_URL}?login=error&reason=missing_code`);
    }

    const { tokens } = await googleOAuthClient.getToken(code);
    const idToken = tokens?.id_token;

    if (!idToken) {
      return res.redirect(`${FRONTEND_URL}?login=error&reason=no_id_token`);
    }

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });

    const p = ticket.getPayload() || {};

    const user = {
      sub: String(p.sub || ""),
      email: String(p.email || ""),
      name: String(p.name || ""),
      picture: String(p.picture || ""),
    };

    if (!user.sub) {
      return res.redirect(`${FRONTEND_URL}?login=error&reason=invalid_google_token`);
    }

    const token = jwt.sign(user, APP_JWT_SECRET, { expiresIn: "30d" });

    await audit("login_google_oauth", { email: user.email, sub: user.sub });

    const glue = returnTo.includes("?") ? "&" : "?";
    return res.redirect(`${returnTo}${glue}token=${encodeURIComponent(token)}`);
  } catch (e) {
    console.error("Google callback error:", e);
    return res.redirect(`${FRONTEND_URL}?login=error&reason=callback_failed`);
  }
});

// Frontend GSI flow
app.post("/auth/google", async (req, res) => {
  try {
    if (!googleClient) {
      return res.status(500).json({ ok: false, error: "GOOGLE_CLIENT_ID missing" });
    }
    if (!APP_JWT_SECRET) {
      return res.status(500).json({ ok: false, error: "APP_JWT_SECRET missing" });
    }

    const { id_token } = req.body || {};
    if (!id_token) {
      return res.status(400).json({ ok: false, error: "id_token missing" });
    }

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

    if (!user.sub) {
      return res.status(401).json({ ok: false, error: "Invalid Google token" });
    }

    const token = jwt.sign(user, APP_JWT_SECRET, { expiresIn: "30d" });

    await audit("login_google_gsi", { email: user.email, sub: user.sub });

    return res.json({ ok: true, user, token });
  } catch (e) {
    return res.status(401).json({ ok: false, error: e.message });
  }
});

// /me
app.get("/me", authRequired, async (req, res) => {
  return res.json({ ok: true, user: req.user });
});

// ===========================
// Upload folders
// ===========================
const uploadsDir = path.join(__dirname, "uploads");
const tmpDir = path.join(__dirname, "tmp");
for (const d of [uploadsDir, tmpDir]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
app.use("/uploads", express.static(uploadsDir));

// ===========================
// Multer
// ===========================
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

// Accept BOTH field names: "audio" (frontend) and "file" (some tests)
const uploadAnyAudio = upload.fields([
  { name: "audio", maxCount: 1 },
  { name: "file", maxCount: 1 },
]);

function pickUploadedFile(req) {
  const a = req.files?.audio?.[0];
  const f = req.files?.file?.[0];
  return a || f || null;
}

// ===========================
// DB init (cases)
// ===========================
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

// ===========================
// Upload + Analyze (MAIN)
// ===========================
app.post("/upload", authOptional, uploadAnyAudio, async (req, res) => {
  let inputPath = null;
  let wavPath = null;

  try {
    const f = pickUploadedFile(req);
    if (!f) return res.status(400).json({ status: "error", message: "No file uploaded" });

    inputPath = f.path;

    // 1) Convert to WAV mono 16kHz
    wavPath = path.join(tmpDir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.wav`);
    await runFfmpeg(["-y", "-i", inputPath, "-ac", "1", "-ar", "16000", "-vn", "-c:a", "pcm_s16le", wavPath]);

    // 2) Send to AI
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

    // 3) Store case
    const case_id = makeCaseId();
    const ai_json = { ...ai, _user: req.user || null };

    if (pool) {
      await pool.query(
        `INSERT INTO cases
         (case_id, filename, mime, title, platform, country, language, tags, notes,
          scam_score, ai_probability, stress_level, risk_level, confidence, ai_json)
         VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
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
          normalized.scam_score,
          normalized.ai_probability,
          normalized.stress_level,
          normalized.risk_level,
          normalized.confidence,
          ai_json,
        ]
      );
    }

    await audit("upload_analyze", {
      case_id,
      filename: f.filename,
      mime: f.mimetype || "",
      user: req.user ? { sub: req.user.sub, email: req.user.email } : null,
      scores: normalized,
    });

    return res.json({
      status: "success",
      message: "File uploaded + normalized + analyzed",
      case_id,
      filename: f.filename,
      ai,
    });
  } catch (err) {
    console.error("UPLOAD/ANALYZE ERROR:", err?.response?.data || err.message);
    if (guardHeadersSent(res)) return;

    return res.status(500).json({
      status: "error",
      message: "Analyze failed",
      detail: err?.response?.data || err.message,
    });
  } finally {
    safeUnlink(wavPath);
  }
});

// ===========================
// Cases endpoints
// ===========================
app.get("/cases", apiKeyRequired, async (req, res) => {
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
    if (guardHeadersSent(res)) return;
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/cases/search", apiKeyRequired, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DATABASE_URL missing" });

    const q = String(req.query.q || "").trim();
    const limit = Math.min(Number(req.query.limit || 50), 200);
    if (!q) return res.json({ ok: true, items: [] });

    const r = await pool.query(
      `SELECT case_id, title, platform, country, language, risk_level, confidence, created_at
       FROM cases
       WHERE (title ILIKE $1 OR notes ILIKE $1 OR tags ILIKE $1 OR case_id ILIKE $1)
       ORDER BY created_at DESC
       LIMIT $2`,
      [`%${q}%`, limit]
    );

    return res.json({ ok: true, items: r.rows });
  } catch (e) {
    if (guardHeadersSent(res)) return;
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// public for share links
app.get("/cases/:case_id", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DATABASE_URL missing" });

    const case_id = String(req.params.case_id || "").trim();
    const r = await pool.query(`SELECT * FROM cases WHERE case_id=$1 LIMIT 1`, [case_id]);

    if (!r.rows.length) return res.status(404).json({ ok: false, error: "Not found" });

    const row = r.rows[0];

    return res.json({
      ok: true,
      case_id: row.case_id,
      filename: row.filename,
      title: row.title,
      platform: row.platform,
      country: row.country,
      language: row.language,
      tags: row.tags,
      notes: row.notes,
      created_at: row.created_at,
      ai: row.ai_json || {
        scores: {
          scam_score: row.scam_score,
          ai_probability: row.ai_probability,
          stress_level: row.stress_level,
          risk_level: row.risk_level,
          confidence: row.confidence,
        },
      },
    });
  } catch (e) {
    if (guardHeadersSent(res)) return;
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// alias
app.get("/case/:case_id", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DATABASE_URL missing" });

    const case_id = String(req.params.case_id || "").trim();
    const r = await pool.query(`SELECT * FROM cases WHERE case_id=$1 LIMIT 1`, [case_id]);

    if (!r.rows.length) return res.status(404).json({ ok: false, error: "Not found" });

    const row = r.rows[0];

    return res.json({
      ok: true,
      case_id: row.case_id,
      filename: row.filename,
      title: row.title,
      platform: row.platform,
      country: row.country,
      language: row.language,
      tags: row.tags,
      notes: row.notes,
      created_at: row.created_at,
      ai: row.ai_json || {
        scores: {
          scam_score: row.scam_score,
          ai_probability: row.ai_probability,
          stress_level: row.stress_level,
          risk_level: row.risk_level,
          confidence: row.confidence,
        },
      },
    });
  } catch (e) {
    if (guardHeadersSent(res)) return;
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ===========================
// Audit endpoint (admin only)
// ===========================
app.get("/audit/recent", adminRequired, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DATABASE_URL missing" });

    const limit = Math.min(Number(req.query.limit || 50), 200);
    const r = await pool.query(
      `SELECT id, ts, action, meta
       FROM audit
       ORDER BY ts DESC
       LIMIT $1`,
      [limit]
    );
    return res.json({ ok: true, items: r.rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ===========================
// Live streaming (2s chunks)
// ===========================
const STREAMS = new Map(); // stream_id -> { createdAt, chunks, lastAi, user, meta }

function makeStreamId() {
  return `ST-${crypto.randomBytes(8).toString("hex")}-${Date.now()}`;
}

app.post("/stream/start", authOptional, (req, res) => {
  const stream_id = makeStreamId();
  STREAMS.set(stream_id, {
    createdAt: Date.now(),
    chunks: [],
    lastAi: null,
    user: req.user || null,
    meta: { ...(req.body || {}) },
  });
  return res.json({ ok: true, stream_id });
});

const uploadChunk = upload.single("chunk");

app.post("/stream/chunk", authOptional, uploadChunk, async (req, res) => {
  let wavPath = null;

  try {
    const stream_id = String(req.body?.stream_id || "").trim();
    if (!stream_id) return res.status(400).json({ ok: false, error: "stream_id missing" });

    const session = STREAMS.get(stream_id);
    if (!session) return res.status(404).json({ ok: false, error: "Stream not found" });

    const f = req.file;
    if (!f) return res.status(400).json({ ok: false, error: "chunk missing" });

    // normalize chunk
    wavPath = path.join(tmpDir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.wav`);
    await runFfmpeg(["-y", "-i", f.path, "-ac", "1", "-ar", "16000", "-vn", "-c:a", "pcm_s16le", wavPath]);

    // send to AI
    const form = new FormData();
    form.append("file", fs.createReadStream(wavPath), { filename: "chunk.wav", contentType: "audio/wav" });

    const aiResp = await axios.post(AI_URL, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      timeout: 120000,
    });

    const ai = aiResp.data;
    session.lastAi = ai;
    session.chunks.push(f.path);

    await audit("stream_chunk", {
      stream_id,
      user: req.user ? { sub: req.user.sub, email: req.user.email } : null,
      size: f.size,
    });

    return res.json({ ok: true, stream_id, ai });
  } catch (e) {
    console.error("STREAM CHUNK ERROR:", e?.response?.data || e.message);
    if (guardHeadersSent(res)) return;
    return res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  } finally {
    safeUnlink(wavPath);
  }
});

app.post("/stream/end", authOptional, async (req, res) => {
  try {
    const stream_id = String(req.body?.stream_id || "").trim();
    if (!stream_id) return res.status(400).json({ ok: false, error: "stream_id missing" });

    const session = STREAMS.get(stream_id);
    if (!session) return res.status(404).json({ ok: false, error: "Stream not found" });

    for (const p of session.chunks) safeUnlink(p);
    STREAMS.delete(stream_id);

    await audit("stream_end", { stream_id });

    return res.json({ ok: true, stream_id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ===========================
// Start
// ===========================
app.listen(PORT, () => {
  console.log(`VoiceSafe backend running on port ${PORT}`);
  console.log(`AI_URL: ${AI_URL}`);
  console.log(`DB: ${DATABASE_URL ? "enabled" : "disabled (DATABASE_URL missing)"}`);
  console.log(`API keys: ${VS_API_KEYS.length ? "enabled" : "disabled (open dev mode)"}`);
  console.log(`Google (GSI): ${GOOGLE_CLIENT_ID ? "enabled" : "disabled (GOOGLE_CLIENT_ID missing)"}`);
  console.log(`JWT: ${APP_JWT_SECRET ? "enabled" : "disabled (APP_JWT_SECRET missing)"}`);
  console.log(`FRONTEND_URL: ${FRONTEND_URL}`);
});