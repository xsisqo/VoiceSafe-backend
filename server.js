// backend/server.js
// VoiceSafe Backend — PRO MAX (Google GSI -> JWT, /me, /my-cases, Public Case Page, Confidence Engine v1, Hardening)

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
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
const pino = require("pino");
const pinoHttp = require("pino-http");

const app = express();

// =========================
// Config
// =========================
const PORT = process.env.PORT || 5000;
const AI_URL = process.env.AI_URL || "https://voicesafe-ai.onrender.com/analyze";
const DATABASE_URL = process.env.DATABASE_URL;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const JWT_SECRET = process.env.JWT_SECRET || "";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

// Only production web origins
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "https://voicesafe.ai,https://www.voicesafe.ai")
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
// Logging + Security
// =========================
const logger = pino({ level: process.env.LOG_LEVEL || "info" });
app.use(pinoHttp({ logger }));

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use(
  cors({
    origin: (origin, cb) => {
      // allow server-to-server/no-origin
      if (!origin) return cb(null, true);
      if (CORS_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked: ${origin}`));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  })
);

app.use(express.json({ limit: "2mb" }));

// =========================
// Utils
// =========================
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
function makeCaseId() {
  return `VS-${crypto.randomBytes(6).toString("hex")}-${Date.now()}`;
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
function normalizeAiResult(ai) {
  const scores = ai?.scores || ai || {};
  const scam_score = Number(scores.scam_score ?? scores.scamScore ?? 0);
  const ai_probability = Number(scores.ai_probability ?? scores.aiProbability ?? 0);
  const stress_level = Number(scores.stress_level ?? scores.stressLevel ?? 0);
  const risk_level = String(scores.risk_level ?? scores.riskLevel ?? "UNKNOWN");
  const confidence = Number(scores.confidence ?? 0);
  return { scam_score, ai_probability, stress_level, risk_level, confidence };
}

// Confidence Engine v1
function computeConfidenceV1({ scam_score, stress_level, ai_probability }) {
  const scam = as01(scam_score);
  const stress = as01(stress_level);
  const aiP = as01(ai_probability);

  const s = scam ?? 0.5;
  const st = stress ?? 0.5;
  const a = aiP ?? 0.5;

  // More scam + more stress -> higher confidence, but penalize if AI prob is “low/uncertain”
  const raw = 0.18 + 0.58 * s + 0.22 * st + 0.02 * (1 - a);
  return clamp(raw, 0.05, 0.98);
}

function riskBucket(scam_score01) {
  const s = as01(scam_score01) ?? 0;
  if (s >= 0.7) return "HIGH";
  if (s >= 0.4) return "MEDIUM";
  return "LOW";
}

// =========================
// Auth (JWT)
// =========================
function signJwt(user) {
  if (!JWT_SECRET) throw new Error("JWT_SECRET missing");
  return jwt.sign(
    { sub: user.user_id, email: user.email, name: user.name, picture: user.picture },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function authOptional(req, _res, next) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return next();
  try {
    if (!JWT_SECRET) return next();
    const payload = jwt.verify(m[1], JWT_SECRET);
    req.user = {
      user_id: String(payload.sub || ""),
      email: payload.email || "",
      name: payload.name || "",
      picture: payload.picture || "",
    };
  } catch (_) {}
  return next();
}

function authRequired(req, res, next) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ ok: false, error: "Missing Bearer token" });
  try {
    if (!JWT_SECRET) return res.status(500).json({ ok: false, error: "JWT_SECRET missing" });
    const payload = jwt.verify(m[1], JWT_SECRET);
    req.user = {
      user_id: String(payload.sub || ""),
      email: payload.email || "",
      name: payload.name || "",
      picture: payload.picture || "",
    };
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}

// =========================
// Health
// =========================
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

// =========================
// Google Auth (GSI -> JWT)
// =========================
app.post("/auth/google", async (req, res) => {
  try {
    if (!googleClient) return res.status(500).json({ ok: false, error: "GOOGLE_CLIENT_ID missing" });
    if (!JWT_SECRET) return res.status(500).json({ ok: false, error: "JWT_SECRET missing" });

    const credential = String(req.body?.credential || "");
    if (!credential) return res.status(400).json({ ok: false, error: "Missing credential" });

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload?.sub) return res.status(401).json({ ok: false, error: "Invalid Google token" });

    const user = {
      user_id: payload.sub,
      email: payload.email || "",
      name: payload.name || payload.email || "User",
      picture: payload.picture || "",
    };

    const token = signJwt(user);

    return res.json({
      ok: true,
      token,
      user,
    });
  } catch (e) {
    req.log.error({ err: e }, "auth/google failed");
    return res.status(401).json({ ok: false, error: "Google auth failed", detail: e.message });
  }
});

app.get("/me", authRequired, async (req, res) => {
  return res.json({ ok: true, user: req.user });
});

// =========================
// Uploads + tmp
// =========================
const uploadsDir = path.join(__dirname, "uploads");
const tmpDir = path.join(__dirname, "tmp");
for (const d of [uploadsDir, tmpDir]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

app.use("/uploads", express.static(uploadsDir));

// Multer
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
// DB schema
// =========================
async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cases (
      id SERIAL PRIMARY KEY,
      case_id TEXT UNIQUE NOT NULL,
      user_id TEXT,
      user_email TEXT,
      user_name TEXT,
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
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cases_user_id ON cases(user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cases_created ON cases(created_at DESC);`);
}
ensureSchema().catch((e) => logger.error({ err: e }, "DB schema init failed"));

// =========================
// Cases endpoints
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
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// My Cases (BLOCK 2)
app.get("/my-cases", authRequired, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DATABASE_URL missing" });

    const limit = Math.min(Number(req.query.limit || 50), 200);
    const r = await pool.query(
      `SELECT case_id, title, platform, country, language, risk_level, confidence, created_at
       FROM cases
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [req.user.user_id, limit]
    );

    return res.json({ ok: true, items: r.rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Public case read
app.get("/cases/:case_id", async (req, res) => {
  try {
    const case_id = req.params.case_id;

    // INVESTOR-SAFE DEMO fallback: VS-DEMO-* always works (even without DB)
    if (case_id.startsWith("VS-DEMO")) {
      return res.json({
        ok: true,
        item: {
          case_id,
          title: "Investor Demo — Scam call analysis",
          platform: "WhatsApp",
          country: "SK",
          language: "sk",
          scam_score: 0.86,
          ai_probability: 0.91,
          stress_level: 0.62,
          risk_level: "HIGH",
          confidence: 0.92,
          ai_json: {
            scores: {
              scam_score: 0.86,
              ai_probability: 0.91,
              stress_level: 0.62,
              risk_level: "HIGH",
              confidence: 0.92
            },
            recommendations: [
              "Nezdieľaj žiadne kódy ani prístupové údaje.",
              "Over si číslo cez oficiálny kanál (web banky / zákaznícka linka).",
              "Ak už došlo k platbe, kontaktuj banku okamžite a zablokuj kartu."
            ],
            summary:
              "Vysoké riziko podvodu – hlas a obsah vykazuje typické znaky nátlaku a sociálneho inžinierstva."
          },
          created_at: new Date().toISOString()
        }
      });
    }

    if (!pool) return res.status(500).json({ ok: false, error: "DATABASE_URL missing" });

    const r = await pool.query(`SELECT * FROM cases WHERE case_id=$1 LIMIT 1`, [case_id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: "Not found" });

    return res.json({ ok: true, item: r.rows[0] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Alias endpoint
app.get("/case/:case_id", async (req, res) => {
  // keep compatibility
  req.url = `/cases/${req.params.case_id}`;
  return app._router.handle(req, res, () => {});
});

// Investor stats (optional)
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
      ok: true,
      total_cases: total.rows[0].c,
      high_risk_7d: high7d.rows[0].c,
      avg_confidence: avgConf.rows[0].v
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// =========================
// Upload + Analyze (BLOCK 1 + 4)
// - JWT optional: if present, attach case to user (My Cases)
// =========================
app.post("/upload", authOptional, uploadAnyAudio, async (req, res) => {
  let inputPath = null;
  let wavPath = null;

  try {
    const f = pickUploadedFile(req);
    if (!f) return res.status(400).json({ status: "error", message: "No file uploaded" });

    inputPath = f.path;

    wavPath = path.join(tmpDir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.wav`);
    await runFfmpeg(["-y", "-i", inputPath, "-ac", "1", "-ar", "16000", "-vn", "-c:a", "pcm_s16le", wavPath]);

    const form = new FormData();
    form.append("file", fs.createReadStream(wavPath), { filename: "audio.wav", contentType: "audio/wav" });

    const aiResp = await axios.post(AI_URL, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      timeout: 120000
    });

    const ai = aiResp.data;
    const normalized = normalizeAiResult(ai);

    let conf01 = as01(normalized.confidence);
    if (conf01 === null || conf01 === 0) conf01 = computeConfidenceV1(normalized);

    const scam01 = as01(normalized.scam_score) ?? 0;
    const rBucket = ["LOW", "MEDIUM", "HIGH"].includes(String(normalized.risk_level).toUpperCase())
      ? String(normalized.risk_level).toUpperCase()
      : riskBucket(scam01);

    const case_id = makeCaseId();

    if (pool) {
      await pool.query(
        `INSERT INTO cases
         (case_id, user_id, user_email, user_name, filename, mime,
          scam_score, ai_probability, stress_level, risk_level, confidence, ai_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          case_id,
          req.user?.user_id || null,
          req.user?.email || null,
          req.user?.name || null,
          f.filename,
          f.mimetype || "",
          normalized.scam_score,
          normalized.ai_probability,
          normalized.stress_level,
          rBucket,
          conf01,
          ai
        ]
      );
    }

    const out = {
      ...ai,
      scores: {
        ...(ai?.scores || {}),
        risk_level: rBucket,
        confidence: conf01
      }
    };

    return res.json({
      status: "success",
      message: "File uploaded + normalized + analyzed",
      case_id,
      filename: f.filename,
      ai: out
    });
  } catch (err) {
    req.log.error({ err: err?.response?.data || err.message }, "upload/analyze failed");
    return res.status(500).json({
      status: "error",
      message: "Analyze failed",
      detail: err?.response?.data || err.message
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
  console.log(`JWT_SECRET: ${JWT_SECRET ? "set" : "missing"}`);
});