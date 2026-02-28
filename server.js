// backend/server.js

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");
const crypto = require("crypto");
const Stripe = require("stripe");

const app = express();
const PORT = process.env.PORT || 5000;

// --------------------
// URLs / ENV
// --------------------
const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://voicesafe-frontend.onrender.com";

// AI_URL musí byť analyze endpoint (POST)
const AI_URL = process.env.AI_URL || "https://voicesafe-ai.onrender.com/analyze";

// Z AI_URL si vyrátame health endpointy
const AI_HEALTH_URL = AI_URL.replace(/\/analyze\/?$/i, "/health");
const AI_ROOT_URL = AI_URL.replace(/\/analyze\/?$/i, "/");

// --------------------
// Stripe
// --------------------
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2024-06-20",
});

// --------------------
// Stripe Webhook MUST be before express.json()
// --------------------
app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log("❌ Webhook signature failed:", err.message);
      return res.sendStatus(400);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      console.log("✅ PAYMENT SUCCESS:", session.customer_email || "(no email)");
      // TODO: persist PRO user / customer id
    }

    res.json({ received: true });
  }
);

// --------------------
// Middlewares
// --------------------
const allowedOrigins = new Set(
  [
    FRONTEND_URL,
    "https://voicesafe.ai",
    "https://www.voicesafe.ai",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ].filter(Boolean)
);

// CORS: povolíme explicitné originy + null (file://) + bez originu (server-to-server)
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl/postman/server-to-server
      if (origin === "null") return cb(null, true); // file://
      if (allowedOrigins.has(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-api-key"],
    credentials: false,
    maxAge: 86400,
  })
);

app.options("*", cors());

// Body JSON (after webhook)
app.use(express.json({ limit: "2mb" }));

// Simple request id logging
app.use((req, res, next) => {
  const rid = crypto.randomBytes(6).toString("hex");
  req._rid = rid;
  res.setHeader("x-request-id", rid);
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`[${rid}] ${req.method} ${req.path} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// --------------------
// Upload (memory)
// --------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// --------------------
// Helpers
// --------------------
function pickNumber(obj, keys, fallback = 0) {
  for (const k of keys) {
    if (!obj) continue;
    const v = obj[k];
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function pickText(obj, keys, fallback = "") {
  for (const k of keys) {
    if (!obj) continue;
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return fallback;
}

function normalizeFlags(flags) {
  if (!flags) return [];
  if (Array.isArray(flags)) return flags.filter(Boolean).slice(0, 12);
  if (typeof flags === "string") {
    return flags
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 12);
  }
  return [];
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function safeJson(x) {
  try {
    return typeof x === "string" ? JSON.parse(x) : x;
  } catch {
    return x;
  }
}

// --------------------
// Routes
// --------------------
app.get("/", (req, res) => {
  res.json({ ok: true, service: "voicesafe-backend" });
});

app.get("/health", async (req, res) => {
  let ai_ok = false;
  let ai_status = "unknown";
  let ai_health_payload = null;

  // 1) Skús AI /health
  try {
    const r = await axios.get(AI_HEALTH_URL, { timeout: 8000 });
    const data = r.data || {};
    ai_health_payload = data;

    // ak AI vracia {ok:true} alebo {status:"ok"}
    ai_ok = r.status === 200 && (data.ok === true || data.status === "ok");
    ai_status = ai_ok ? "ok" : "bad_response";
  } catch (e) {
    ai_ok = false;
    ai_status = e?.code || "health_error";
  }

  // 2) Fallback: ak /health nefunguje, skús root /
  if (!ai_ok) {
    try {
      const r2 = await axios.get(AI_ROOT_URL, { timeout: 8000 });
      const data2 = r2.data || {};
      ai_health_payload = ai_health_payload || data2;
      ai_ok = r2.status === 200 && (data2.ok === true || data2.status === "ok");
      ai_status = ai_ok ? "ok_root" : `root_bad_${r2.status}`;
    } catch (e2) {
      ai_status = `${ai_status}|root_${e2?.code || "error"}`;
    }
  }

  res.json({
    ok: true,
    ai_url: AI_URL,
    ai_health_url: AI_HEALTH_URL,
    ai_ok,
    ai_status,
    ai_payload: ai_health_payload,
    db_ok: false,
  });
});

// ================= UPLOAD =================
app.post("/upload", upload.single("file"), async (req, res) => {
  const rid = req._rid;

  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: "Missing file" });
    }

    const fileName = req.file.originalname || "upload.bin";
    const fileType = req.file.mimetype || "application/octet-stream";
    const fileSize = req.file.size || req.file.buffer?.length || 0;
    const fileHash = sha256(req.file.buffer);

    console.log(
      `[${rid}] upload file=${fileName} type=${fileType} size=${fileSize} sha256=${fileHash.slice(
        0,
        12
      )}...`
    );

    const fd = new FormData();
    fd.append("file", req.file.buffer, {
      filename: fileName,
      contentType: fileType,
    });

    // forward optional metadata
    const metaKeys = ["title", "platform", "country", "language", "tags", "notes"];
    for (const k of metaKeys) {
      if (req.body && req.body[k] !== undefined) fd.append(k, String(req.body[k]));
    }

    // IMPORTANT: axios needs correct headers + maxBodyLength
    const aiResp = await axios.post(AI_URL, fd, {
      headers: {
        ...fd.getHeaders(),
      },
      maxBodyLength: Infinity,
      timeout: 180000,
      validateStatus: () => true, // chceme dostať body aj pri erroroch
    });

    const aiStatus = aiResp.status;
    const aiRaw = safeJson(aiResp.data) || {};

    if (aiStatus < 200 || aiStatus >= 300) {
      console.error(`[${rid}] AI non-2xx status=${aiStatus}`, aiRaw);
      return res.status(502).json({
        ok: false,
        message: "AI analyze failed",
        ai_status: aiStatus,
        ai_error: aiRaw,
        debug: { fileName, fileType, fileSize, fileHash },
      });
    }

    // Normalize AI output for frontend
    const aiResult = {
      summary: pickText(aiRaw, ["summary", "message", "explanation"], ""),
      ai_probability: pickNumber(
        aiRaw,
        ["ai_probability", "aiProb", "ai_probability_pct", "ai_voice_probability"],
        0
      ),
      stress_level: pickNumber(aiRaw, ["stress_level", "stressLevel", "stress", "stress_score"], 0),
      scam_score: pickNumber(aiRaw, ["scam_score", "scamScore", "risk", "risk_score"], 0),
      flags: normalizeFlags(aiRaw.flags || aiRaw.signals || aiRaw.red_flags || aiRaw.redFlags),
      voice_match: pickText(aiRaw, ["voice_match", "voiceMatch", "match"], "Unknown"),
      raw_keys: Object.keys(aiRaw || {}).slice(0, 80),
    };

    res.json({
      ok: true,
      case_id: null,
      aiResult,
      debug: {
        fileName,
        fileType,
        fileSize,
        fileHash,
        ai_status: aiStatus,
      },
    });
  } catch (e) {
    const status = e?.response?.status || null;
    const data = e?.response?.data || null;

    console.error(`[${rid}] UPLOAD ERROR:`, e.message, status ? `status=${status}` : "");
    if (data) console.error(`[${rid}] AI ERROR DATA:`, data);

    res.status(500).json({
      ok: false,
      message: "Analyze failed",
      error: String(e.message),
      status,
      ai_error: data,
    });
  }
});

// ================= CASES (EMPTY MVP) =================
app.get("/cases", (req, res) => {
  res.json({ ok: true, items: [] });
});

// ================= STRIPE CHECKOUT =================
app.post("/create-checkout-session", async (req, res) => {
  try {
    if (!process.env.STRIPE_PRICE_ID) {
      return res.status(500).json({ error: "Missing STRIPE_PRICE_ID" });
    }

    const trialDays = Number(process.env.STRIPE_TRIAL_DAYS || 7);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      ...(trialDays > 0 ? { subscription_data: { trial_period_days: trialDays } } : {}),
      success_url: `${FRONTEND_URL}/success`,
      cancel_url: `${FRONTEND_URL}/`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("STRIPE ERROR:", err);
    res.status(500).json({ error: err.message || "Stripe error" });
  }
});

// ================= START =================
app.listen(PORT, () => {
  console.log(`voicesafe-backend running on ${PORT}`);
  console.log("FRONTEND_URL:", FRONTEND_URL);
  console.log("AI_URL:", AI_URL);
  console.log("AI_HEALTH_URL:", AI_HEALTH_URL);
});