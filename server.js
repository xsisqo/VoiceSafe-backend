// ===============================
// VoiceSafe Backend — Enterprise Stable
// ===============================

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");
const crypto = require("crypto");
const Stripe = require("stripe");
const fs = require("fs");
const path = require("path");

// Optional routes (keep if you have them)
let shareRoutes = null;
try {
  // eslint-disable-next-line global-require
  shareRoutes = require("./routes/share");
} catch {
  shareRoutes = null;
}

const app = express();
const PORT = process.env.PORT || 5000;

// ===============================
// ENV / URLS
// ===============================
const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://voicesafe-frontend.onrender.com";

const AI_URL =
  process.env.AI_URL || "https://voicesafe-ai.onrender.com/analyze";

const AI_HEALTH_URL = AI_URL.replace(/\/analyze\/?$/i, "/health");

// ===============================
// CASE STORE (simple JSON DB)
// ===============================
const CASES_PATH = path.join(__dirname, "cases.json");

function readCasesSafe() {
  try {
    if (!fs.existsSync(CASES_PATH)) return {};
    const raw = fs.readFileSync(CASES_PATH, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeCasesSafe(data) {
  // atomic-ish write to avoid partial files on crash
  const tmp = `${CASES_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, CASES_PATH);
}

// ============================
// Case ID generator
// ============================
function generateCaseId() {
  // VS-2026-123456
  const year = new Date().getUTCFullYear();
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `VS-${year}-${rand}`;
}

// ===============================
// STRIPE
// ===============================
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || "";

const stripe =
  STRIPE_SECRET_KEY.trim().length > 0
    ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" })
    : null;

// ===============================
// STRIPE WEBHOOK (RAW BODY) — MUST BE BEFORE express.json()
// ===============================
app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    if (!stripe) return res.status(500).send("Stripe not configured");
    const sig = req.headers["stripe-signature"];

    try {
      const event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        STRIPE_WEBHOOK_SECRET
      );

      // You can extend these later
      if (event.type === "checkout.session.completed") {
        console.log("✅ STRIPE: checkout.session.completed");
      }

      res.json({ received: true });
    } catch (err) {
      console.log("Stripe webhook error:", err.message);
      res.sendStatus(400);
    }
  }
);

// ===============================
// CORS (enterprise-friendly)
// ===============================
const ALLOWED_ORIGINS = new Set([
  FRONTEND_URL,
  "https://voicesafe.ai",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

app.use(
  cors({
    origin: (origin, cb) => {
      // allow server-to-server / curl (no origin)
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked: ${origin}`), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-request-id"],
    exposedHeaders: ["x-request-id"],
    credentials: false,
  })
);

// preflight
app.options("*", cors());

// JSON body for normal routes (NOT webhook)
app.use(express.json({ limit: "2mb" }));

// ===============================
// REQUEST LOGGER + REQUEST ID
// ===============================
app.use((req, res, next) => {
  const rid = crypto.randomBytes(6).toString("hex");
  req._rid = rid;
  res.setHeader("x-request-id", rid);

  const start = Date.now();
  res.on("finish", () => {
    console.log(
      `[${rid}] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`
    );
  });

  next();
});

// Optional share routes
if (shareRoutes) app.use(shareRoutes);

// ===============================
// FILE UPLOAD
// ===============================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// ===============================
// HELPERS
// ===============================
const sha256 = (buf) =>
  crypto.createHash("sha256").update(buf).digest("hex");

function normalizeMeta(body) {
  // keep only expected fields (avoid huge junk)
  const meta = body || {};
  return {
    title: String(meta.title || "").slice(0, 180),
    platform: String(meta.platform || "").slice(0, 64),
    country: String(meta.country || "").slice(0, 64),
    language: String(meta.language || "").slice(0, 64),
    tags: String(meta.tags || "").slice(0, 220),
    notes: String(meta.notes || "").slice(0, 1500),
  };
}

function caseMatches(caseObj, q, tag) {
  const meta = caseObj?.meta || {};
  const hay = `${meta.title || ""} ${meta.notes || ""} ${meta.platform || ""} ${meta.tags || ""}`
    .toLowerCase()
    .trim();

  const qOk = !q || hay.includes(q.toLowerCase());
  const tagOk =
    !tag ||
    String(meta.tags || "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(tag.toLowerCase());

  return qOk && tagOk;
}

// ===============================
// ROUTES
// ===============================
app.get("/", (req, res) => {
  res.json({ ok: true, service: "voicesafe-backend" });
});

// HEALTH
app.get("/health", async (req, res) => {
  let ai_ok = false;
  let ai_status = "unknown";

  try {
    const r = await axios.get(AI_HEALTH_URL, { timeout: 5000 });
    ai_ok = r.status === 200;
    ai_status = ai_ok ? "ok" : `http_${r.status}`;
  } catch (e) {
    ai_ok = false;
    ai_status = "offline";
  }

  res.json({
    ok: true,
    ai_url: AI_URL,
    ai_health_url: AI_HEALTH_URL,
    ai_ok,
    ai_status,
  });
});

// GET ONE CASE
app.get("/case/:id", (req, res) => {
  const all = readCasesSafe();
  const c = all[req.params.id];
  if (!c) return res.status(404).json({ ok: false, message: "Case not found" });
  return res.json({ ok: true, case: c });
});

// SEARCH CASES (needed by frontend)
app.get("/cases", (req, res) => {
  const all = readCasesSafe();
  const q = String(req.query.q || "").trim();
  const tag = String(req.query.tag || "").trim();

  const items = Object.values(all)
    .filter((c) => caseMatches(c, q, tag))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 50)
    .map((c) => ({
      id: c.id,
      createdAt: c.createdAt,
      meta: c.meta || {},
    }));

  return res.json({ ok: true, cases: items });
});

// ===============================
// 🚀 UPLOAD + ANALYZE
// ===============================
app.post("/upload", upload.single("file"), async (req, res) => {
  const rid = req._rid;

  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: "Missing file" });
    }

    const fileHash = sha256(req.file.buffer);
    console.log(
      `[${rid}] Upload ${req.file.originalname} ${fileHash.slice(0, 8)} (${req.file.mimetype})`
    );

    const fd = new FormData();
    fd.append("file", req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });

    const aiResp = await axios.post(AI_URL, fd, {
      headers: fd.getHeaders(),
      timeout: 120000,
      maxBodyLength: Infinity,
      validateStatus: () => true,
    });

    if (aiResp.status >= 300) {
      console.error(`[${rid}] AI ERROR`, aiResp.status, aiResp.data);
      return res.status(502).json({
        ok: false,
        message: "AI analyze failed",
        ai_status: aiResp.status,
      });
    }

    const caseId = generateCaseId();

    const record = {
      id: caseId,
      createdAt: new Date().toISOString(),
      fileHash,
      meta: normalizeMeta(req.body),
      aiResult: aiResp.data,
    };

    const all = readCasesSafe();
    all[caseId] = record;
    writeCasesSafe(all);

    return res.json({
      ok: true,
      case_id: caseId,
      caseId, // frontend expects this too
      aiResult: aiResp.data,
      debug: { fileHash },
    });
  } catch (e) {
    console.error(`[${rid}] ERROR`, e?.message || e);
    return res.status(500).json({
      ok: false,
      message: "Analyze failed",
      error: e?.message || String(e),
    });
  }
});

// ===============================
// STRIPE: create checkout session (optional use)
// ===============================
app.post("/create-checkout-session", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok: false, message: "Stripe not configured" });
    if (!STRIPE_PRICE_ID) return res.status(500).json({ ok: false, message: "Missing STRIPE_PRICE_ID" });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${FRONTEND_URL}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/`,
    });

    res.json({ ok: true, url: session.url });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ===============================
// STRIPE: verify session (frontend uses this)
// ===============================
app.get("/verify-session", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok: false, message: "Stripe not configured" });

    const sessionId = String(req.query.session_id || "").trim();
    if (!sessionId) return res.status(400).json({ ok: false, message: "Missing session_id" });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const customerId = session.customer;

    // subscription can be on session.subscription
    const subscriptionId = session.subscription;

    let isPro = false;
    if (subscriptionId) {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      isPro = sub.status === "active" || sub.status === "trialing";
    }

    return res.json({
      ok: true,
      isPro,
      customerId: customerId || null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// ===============================
// STRIPE: billing portal (frontend uses this)
// ===============================
app.post("/create-portal-session", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok: false, message: "Stripe not configured" });

    const customerId = String(req.body?.customerId || "").trim();
    if (!customerId) return res.status(400).json({ ok: false, message: "Missing customerId" });

    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: FRONTEND_URL,
    });

    return res.json({ ok: true, url: portal.url });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// ===============================
// START
// ===============================
app.listen(PORT, () => {
  console.log(`🚀 VoiceSafe backend running on ${PORT}`);
  console.log("AI_URL:", AI_URL);
  console.log("FRONTEND_URL:", FRONTEND_URL);
});