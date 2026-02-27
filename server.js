// backend/server.js

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");
const Stripe = require("stripe");

const app = express();

const PORT = process.env.PORT || 5000;

// --------------------
// URLs / ENV
// --------------------
const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://voicesafe-frontend.onrender.com";

// AI_URL musí byť analyze endpoint (POST)
const AI_URL =
  process.env.AI_URL || "https://voicesafe-ai.onrender.com/analyze";

// Z AI_URL si vyrátame health endpoint
const AI_HEALTH_URL = AI_URL.replace(/\/analyze\/?$/i, "/health");

// --------------------
// Stripe
// --------------------
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
      // TODO: uložiť PRO usera do DB
    }

    res.json({ received: true });
  }
);

// --------------------
// Middlewares
// --------------------
app.use(cors());
app.use(express.json());

// --------------------
// Upload (memory)
// --------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// --------------------
// Routes
// --------------------
app.get("/", (req, res) => {
  res.json({ ok: true, service: "voicesafe-backend" });
});

app.get("/health", async (req, res) => {
  let ai_ok = false;

  try {
    const r = await axios.get(AI_HEALTH_URL, { timeout: 7000 });
    const data = r.data || {};

    // AI môže vracať buď {status:"ok"} alebo {ok:true}
    ai_ok =
      (r.status === 200 &&
        (data.status === "ok" || data.ok === true)) ||
      false;
  } catch (e) {
    ai_ok = false;
  }

  res.json({
    ok: true,
    ai_url: AI_URL,
    ai_health_url: AI_HEALTH_URL,
    ai_ok,
    db_ok: false, // DB optional
  });
});

// ================= UPLOAD =================
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        message: "Missing file",
      });
    }

    const fd = new FormData();
    fd.append("file", req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });

    const aiResp = await axios.post(AI_URL, fd, {
      headers: fd.getHeaders(),
      maxBodyLength: Infinity,
      timeout: 120000,
    });

    const ai = aiResp.data || {};

    res.json({
      ok: true,
      caseId: null,
      aiResult: {
        summary: ai.summary || "",
        ai_probability: ai.ai_probability || 0,
        stress_level: ai.stress_level || 0,
        scam_score: ai.scam_score || 0,
        flags: ai.flags || [],
        voice_match: ai.voice_match || "Unknown",
      },
    });
  } catch (e) {
    // axios error detail
    const status = e?.response?.status;
    const data = e?.response?.data;

    console.error("UPLOAD ERROR:", e.message, status ? `status=${status}` : "");
    if (data) console.error("AI ERROR DATA:", data);

    res.status(500).json({
      ok: false,
      message: "Analyze failed",
      error: String(e.message),
      status: status || null,
    });
  }
});

// ================= CASES (EMPTY MVP) =================
app.get("/cases", (req, res) => {
  res.json({ ok: true, items: [] });
});

// ================= STRIPE CHECKOUT (SINGLE ROUTE) =================
app.post("/create-checkout-session", async (req, res) => {
  try {
    if (!process.env.STRIPE_PRICE_ID) {
      return res.status(500).json({ error: "Missing STRIPE_PRICE_ID" });
    }

    const trialDays = Number(process.env.STRIPE_TRIAL_DAYS || 7);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      // Trial (ak chceš vypnúť, daj STRIPE_TRIAL_DAYS=0)
      ...(trialDays > 0
        ? { subscription_data: { trial_period_days: trialDays } }
        : {}),

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
  console.log("AI_URL:", AI_URL);
  console.log("AI_HEALTH_URL:", AI_HEALTH_URL);
});