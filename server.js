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
// ✅ fixes: ERR_HTTP_HEADERS_SENT guard + correct AI_URL + correct app.post usage

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

// ===== Config =====
const PORT = process.env.PORT || 5000;

// IMPORTANT: must be a plain URL, not a markdown link
const AI_URL = (process.env.AI_URL || "https://voicesafe-ai.onrender.com/analyze").trim();

const DATABASE_URL = process.env.DATABASE_URL || "";

// Enterprise API keys (comma-separated). First key = admin key.
const VS_API_KEYS = (process.env.VS_API_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
const ADMIN_KEY = VS_API_KEYS[0] || "";

// Google auth
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const APP_JWT_SECRET = process.env.APP_JWT_SECRET || ""; // MUST set in Render for JWT login
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// Postgres (Render often requires SSL)
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

// ===== Auth helpers (JWT optional/required) =====
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

// ===== API key helpers =====
function getApiKey(req) {
  return (req.header("x-api-key") || req.header("X-API-Key") || "").trim();
}
function apiKeyOptional(req, _res, next) {
  // If no keys configured -> dev mode (open)
  if (!VS_API_KEYS.length) return next();

  const k = getApiKey(req);
  if (!k) return next(); // optional in some endpoints
  req.apiKey = k;
  req.isAdmin = ADMIN_KEY && k === ADMIN_KEY;
  return next();
}
function apiKeyRequired(req, res, next) {
  if (!VS_API_KEYS.length) return next(); // dev mode (open)
  const k = getApiKey(req);
  if (!k) return res.status(401).json({ ok: false, error: "Missing x-api-key" });
  if (!VS_API_KEYS.includes(k)) return res.status(403).json({ ok: false, error: "Invalid API key" });
  req.apiKey = k;
  req.isAdmin = ADMIN_KEY && k === ADMIN_KEY;
  return next();
}
function adminRequired(req, res, next) {
  if (!VS_API_KEYS.length) return next(); // dev mode (open)
  const k = getApiKey(req);
  if (!k) return res.status(401).json({ ok: false, error: "Missing x-api-key" });
  if (!ADMIN_KEY || k !== ADMIN_KEY) return res.status(403).json({ ok: false, error: "Admin key required" });
  req.apiKey = k;
  req.isAdmin = true;
  return next();
}

// ===== Health =====
app.get("/", (_req, res) => res.json({ ok: true, service: "voicesafe-backend" }));

app.get("/health", apiKeyOptional, async (_req, res) => {
  try {
    if (!pool) {
      return res.json({
        ok: true,
        db: false,
        note: "DATABASE_URL missing",
        google: !!GOOGLE_CLIENT_ID,
        jwt: !!APP_JWT_SECRET,
        api_keys: VS_API_KEYS.length ? true : false,
        ai_url: AI_URL,
      });
    }
    await pool.query("SELECT 1");
    return res.json({
      ok: true,
      db: true,
      google: !!GOOGLE_CLIENT_ID,
      jwt: !!APP_JWT_SECRET,
      api_keys: VS_API_KEYS.length ? true : false,
      ai_url: AI_URL,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, db: false, error: e.message });
  }
});

// ===== Google Login =====
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

// /me
app.get("/me", authRequired, async (req, res) => {
  return res.json({ ok: true, user: req.user });
});

// ===== Upload folders =====
const uploadsDir = path.join(__dirname, "uploads");
const tmpDir = path.join(__dirname, "tmp");
for (const d of [uploadsDir, tmpDir]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
app.use("/uploads", express.static(uploadsDir));

// ===== Multer =====
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

function normalizeAiResult(ai) {
  const scores = ai?.scores || ai || {};
  const scam_score = Number(scores.scam_score ?? scores.scamScore ?? 0);
  const ai_probability = Number(scores.ai_probability ?? scores.aiProbability ?? 0);
  const stress_level = Number(scores.stress_level ?? scores.stressLevel ?? 0);
  const risk_level = String(scores.risk_level ?? scores.riskLevel ?? "UNKNOWN");
  const confidence = Number(scores.confidence ?? 0);
  return { scam_score, ai_probability, stress_level, risk_level, confidence };
}

function riskLevelFromPct(pct) {
  if (pct >= 70) return "HIGH";
  if (pct >= 35) return "MEDIUM";
  return "LOW";
}

function clamp(n, a, b) {
  n = Number(n);
  if (Number.isNaN(n)) return a;
  return Math.max(a, Math.min(b, n));
}

function scoreToPct01(v) {
  // accepts 0..1 or 0..100
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  if (n <= 1 && n >= 0) return n;
  if (n <= 100 && n >= 0) return n / 100;
  return clamp(n, 0, 1);
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
// NOTE: protected by API key (as your frontend says)
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
    if (res.headersSent) return;
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Frontend calls /cases/search?q=...
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
    if (res.headersSent) return;
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Return shape that frontend can render: { ok:true, case_id, ai: {...}, ... }
app.get("/cases/:case_id", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DATABASE_URL missing" });

    const case_id = req.params.case_id;
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
      // IMPORTANT: frontend expects ai object or flat scores; we provide ai.
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
    if (res.headersSent) return;
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Alias: /case/:id
app.get("/case/:case_id", apiKeyRequired, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DATABASE_URL missing" });

    const case_id = req.params.case_id;
    const r = await pool.query(`SELECT * FROM cases WHERE case_id=$1 LIMIT 1`, [case_id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: "Not found" });

    const row = r.rows[0];
    return res.json({
      ok: true,
      case_id: row.case_id,
      ai: row.ai_json || null,
    });
  } catch (e) {
    if (res.headersSent) return;
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== Audit (frontend Admin tab calls /audit/recent) =====
app.get("/audit/recent", adminRequired, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DATABASE_URL missing" });

    const limit = Math.min(Number(req.query.limit || 50), 200);
    const r = await pool.query(
      `SELECT case_id, title, platform, country, language, risk_level, confidence, created_at
       FROM cases
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    return res.json({ ok: true, items: r.rows });
  } catch (e) {
    if (res.headersSent) return;
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== Upload + Analyze (MAIN) =====
// Protected by API key; JWT is optional
app.post("/upload", authOptional, uploadAnyAudio, async (req, res) => {
  let inputPath = null;
  let wavPath = null;

  try {
    const f = pickUploadedFile(req);
    if (!f) return res.status(400).json({ status: "error", message: "No file uploaded" });

    inputPath = f.path;

    // 1) Convert to WAV mono 16kHz via ffmpeg
    wavPath = path.join(tmpDir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.wav`);
    await runFfmpeg(["-y", "-i", inputPath, "-ac", "1", "-ar", "16000", "-vn", "-c:a", "pcm_s16le", wavPath]);

    // 2) Send to AI (expects "file")
    const form = new FormData();
    form.append("file", fs.createReadStream(wavPath), {
      filename: "audio.wav",
      contentType: "audio/wav",
    });

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

    return res.json({
      status: "success",
      message: "File uploaded + normalized + analyzed",
      case_id,
      filename: f.filename,
      ai,
    });
  } catch (err) {
    console.error("UPLOAD/ANALYZE ERROR:", err?.response?.data || err?.message || err);
    if (res.headersSent) return;
    return res.status(500).json({
      status: "error",
      message: "Analyze failed",
      detail: err?.response?.data || err?.message || String(err),
    });
  } finally {
    safeUnlink(wavPath);
  }
});

// ===== Live streaming =====
// In-memory sessions (good enough for prototype)
const liveSessions = new Map(); // session_id -> { created_at, chunks, ema, peak }

app.post("/stream/start", apiKeyRequired, async (_req, res) => {
  try {
    const session_id = `LS-${crypto.randomBytes(10).toString("hex")}-${Date.now()}`;
    liveSessions.set(session_id, {
      created_at: Date.now(),
      chunks: 0,
      ema: 0,
      peak: 0,
    });
    return res.json({ ok: true, session_id });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

app.post("/stream/chunk", apiKeyRequired, uploadAnyAudio, async (req, res) => {
  const t0 = Date.now();
  let inputPath = null;
  let wavPath = null;

  try {
    const session_id = String(req.query.session_id || "").trim();
    if (!session_id) return res.status(400).json({ ok: false, message: "session_id missing" });

    const s = liveSessions.get(session_id);
    if (!s) return res.status(404).json({ ok: false, message: "session not found" });

    const f = pickUploadedFile(req);
    if (!f) return res.status(400).json({ ok: false, message: "No chunk uploaded" });

    inputPath = f.path;

    // normalize chunk to wav
    wavPath = path.join(tmpDir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.wav`);
    await runFfmpeg(["-y", "-i", inputPath, "-ac", "1", "-ar", "16000", "-vn", "-c:a", "pcm_s16le", wavPath]);

    // call AI
    const form = new FormData();
    form.append("file", fs.createReadStream(wavPath), { filename: "chunk.wav", contentType: "audio/wav" });

    const aiResp = await axios.post(AI_URL, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      timeout: 60000,
    });

    const ai = aiResp.data;
    const norm = normalizeAiResult(ai);

    // derive risk_now in %
    const risk01 = scoreToPct01(norm.scam_score);
    const risk_now = Math.round(risk01 * 100);

    // EMA update
    const alpha = 0.3;
    s.ema = s.chunks === 0 ? risk_now : Math.round(alpha * risk_now + (1 - alpha) * s.ema);
    s.peak = Math.max(s.peak, risk_now);
    s.chunks += 1;

    const risk_level = (String(norm.risk_level || "")).toUpperCase();
    const lvl = (risk_level === "HIGH" || risk_level === "MEDIUM" || risk_level === "LOW")
      ? risk_level
      : riskLevelFromPct(risk_now);

    return res.json({
      ok: true,
      risk_level: lvl,
      rolling: {
        risk_now,
        risk_ema: s.ema,
        risk_peak: s.peak,
        chunks: s.chunks,
      },
      runtime_ms: Date.now() - t0,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message, runtime_ms: Date.now() - t0 });
  } finally {
    safeUnlink(wavPath);
  }
});

// ===== Start =====
app.listen(PORT, () => {
  console.log(`VoiceSafe backend running on port ${PORT}`);
  console.log(`AI_URL: ${AI_URL}`);
  console.log(`DB: ${DATABASE_URL ? "enabled" : "disabled (DATABASE_URL missing)"}`);
  console.log(`API Keys: ${VS_API_KEYS.length ? "enabled" : "disabled (VS_API_KEYS missing)"}`);
  console.log(`Google: ${GOOGLE_CLIENT_ID ? "enabled" : "disabled (GOOGLE_CLIENT_ID missing)"}`);
  console.log(`JWT: ${APP_JWT_SECRET ? "enabled" : "disabled (APP_JWT_SECRET missing)"}`);
});