// ===============================
// VoiceSafe Backend — Enterprise Stable
// ===============================

const express = require("express");
const cors = require("cors");
const multer = require("multer");

// ============================
// Case ID generator
// ============================
function generateCaseId() {
  const year = new Date().getUTCFullYear();
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `VS-${year}-${rand}`;
}

const axios = require("axios");
const FormData = require("form-data");
const crypto = require("crypto");
const Stripe = require("stripe");
const shareRoutes = require("./routes/share");
const fs = require("fs");
const path = require("path");

const app = express();
const CASES_PATH = path.join(__dirname, "cases.json");

function readCases() {
  try {
    return JSON.parse(fs.readFileSync(CASES_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeCases(data) {
  fs.writeFileSync(CASES_PATH, JSON.stringify(data, null, 2), "utf8");
}
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
// STRIPE
// ===============================
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2024-06-20",
});

// ===============================
// STRIPE WEBHOOK (RAW BODY)
// ===============================
app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["stripe-signature"];

    try {
      const event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );

      if (event.type === "checkout.session.completed") {
        console.log("✅ PAYMENT SUCCESS");
      }

      res.json({ received: true });
    } catch (err) {
      console.log("Webhook error:", err.message);
      res.sendStatus(400);
    }
  }
);

// ===============================
// ✅ ENTERPRISE CORS FIX
// ===============================
app.use(
  cors({
    origin: [
      FRONTEND_URL,
      "https://voicesafe.ai",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-request-id"],
    exposedHeaders: ["x-request-id"],
    credentials: false,
  })
);

// ✅ preflight handler
app.options("*", cors());

app.use(express.json({ limit: "2mb" }));

// ===============================
// REQUEST LOGGER
// ===============================
app.use((req, res, next) => {
  const rid = crypto.randomBytes(6).toString("hex");
  req._rid = rid;
  res.setHeader("x-request-id", rid);

  const start = Date.now();

  res.on("finish", () => {
    console.log(
      `[${rid}] ${req.method} ${req.path} ${res.statusCode} ${
        Date.now() - start
      }ms`
    );
  });

  next();
});

app.use(shareRoutes);

// ===============================
// FILE UPLOAD
// ===============================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ===============================
// HELPERS
// ===============================
const sha256 = (buf) =>
  crypto.createHash("sha256").update(buf).digest("hex");

// ===============================
// ROUTES
// ===============================
app.get("/", (req, res) => {
  res.json({ ok: true, service: "voicesafe-backend" });
});

// ===============================
app.get("/health", async (req, res) => {
  let ai_ok = false;

  try {
    const r = await axios.get(AI_HEALTH_URL, { timeout: 5000 });
    ai_ok = r.status === 200;
  } catch {}

  res.json({
    ok: true,
    ai_url: AI_URL,
    ai_health_url: AI_HEALTH_URL,
    ai_ok,
  });
});

app.get("/case/:id", (req, res) => {
  const all = readCases();
  const c = all[req.params.id];
  if (!c) return res.status(404).json({ ok: false, message: "Case not found" });
  return res.json({ ok: true, case: c });
});

// ===============================
// 🚀 UPLOAD + ANALYZE
// ===============================
app.post("/upload", upload.single("file"), async (req, res) => {
  const rid = req._rid;

  try {
    if (!req.file)
      return res.status(400).json({ ok: false, message: "Missing file" });

    const fileHash = sha256(req.file.buffer);

    console.log(
      `[${rid}] Upload ${req.file.originalname} ${fileHash.slice(0, 8)}`
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
      console.error("AI ERROR:", aiResp.data);
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
  aiResult: aiResp.data,
  meta: req.body || {},
};

const all = readCases();
all[caseId] = record;
writeCases(all);

return res.json({
  ok: true,
  case_id: caseId,
  caseId, // ✅ toto potrebuje frontend
  aiResult: aiResp.data,
  debug: { fileHash },
});

} catch (e) {
  console.error(`[${rid}] ERROR`, e.message);

  return res.status(500).json({
    ok: false,
    message: "Analyze failed",
    error: e.message,
  });
}
});

// ===============================
// STRIPE CHECKOUT
// ===============================
app.post("/create-checkout-session", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        { price: process.env.STRIPE_PRICE_ID, quantity: 1 },
      ],
      success_url: `${FRONTEND_URL}/success`,
      cancel_url: `${FRONTEND_URL}/`,
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===============================
app.listen(PORT, () => {
  console.log(`🚀 VoiceSafe backend running on ${PORT}`);
  console.log("AI_URL:", AI_URL);
  console.log("FRONTEND_URL:", FRONTEND_URL);
});
