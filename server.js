// backend/server.js

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();

const PORT = process.env.PORT || 5000;
const AI_URL =
  process.env.AI_URL ||
  "https://voicesafe-ai.onrender.com/analyze";

app.use(cors());
app.use(express.json());

// ================= UPLOAD MEMORY =================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ================= HEALTH =================
app.get("/", (req, res) => {
  res.json({ ok: true, service: "voicesafe-backend" });
});

app.get("/health", async (req, res) => {
  let ai_ok = false;

  try {
    const r = await axios.get(
      "https://voicesafe-ai.onrender.com/health",
      { timeout: 5000 }
    );
    ai_ok = r.data.ok === true;
  } catch {}

  res.json({
    ok: true,
    ai_url: AI_URL,
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

    // ✅ DB SAVE SKIPPED (MVP MODE)

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
    console.error("UPLOAD ERROR:", e.message);

    res.status(500).json({
      ok: false,
      message: "Analyze failed",
      error: String(e.message),
    });
  }
});

// ================= CASES (EMPTY MVP) =================
app.get("/cases", (req, res) => {
  res.json({ ok: true, items: [] });
});

app.post("/create-checkout-session", async (req, res) => {
  try {

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",

      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID, // ← sem dáme tvoje price id
          quantity: 1,
        },
      ],

      subscription_data: {
        trial_period_days: 7, // ⭐ TU JE TRIAL
      },

      success_url:
        "https://voicesafe-frontend.onrender.com/success",
      cancel_url:
        "https://voicesafe-frontend.onrender.com/",
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Stripe error" });
  }
});

// ================= STRIPE CHECKOUT =================

app.post("/create-checkout-session", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      success_url: "https://voicesafe-frontend.onrender.com/?success=true",
      cancel_url: "https://voicesafe-frontend.onrender.com/?canceled=true",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("STRIPE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// ================= START =================
app.listen(PORT, () => {
  console.log(`voicesafe-backend running on ${PORT}`);
});