// backend/server.js
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const FormData = require("form-data");

const app = express();

// ===== Config =====
const PORT = process.env.PORT || 5000;

// AI endpoint (na Render si to nastavíš cez ENV AI_URL)
const AI_URL = process.env.AI_URL || "https://voicesafe-ai-mmnf.onrender.com/analyze";

// CORS (daj voľnejšie, nech to ide z voicesafe.ai aj render frontendu)
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "2mb" }));

// ===== Health =====
app.get("/", (req, res) => res.json({ ok: true, service: "voicesafe-backend" }));
app.get("/health", (req, res) => res.json({ ok: true }));

// ===== Uploads folder =====
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// (voliteľné) aby si vedel otvoriť uploadnutý súbor cez URL
app.use("/uploads", express.static(uploadsDir));

// ===== Multer =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const upload = multer({ storage });

// ===== Upload + Analyze (HLAVNÉ) =====
// Frontend posiela: form.append("audio", f)
app.post("/upload", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ status: "error", message: "No file uploaded" });
    }

    const filePath = req.file.path;
    const filename = req.file.filename;

    // 1) pošli súbor do AI
    const form = new FormData();
    form.append("audio", fs.createReadStream(filePath), {
      filename: req.file.originalname,
      contentType: req.file.mimetype || "audio/mpeg",
    });

    // ak posielaš aj meta polia z frontendu, prepošlime ich:
    // (nezabije to nič, len to AI môže ignorovať)
    const fields = ["title", "platform", "country", "language", "tags", "notes"];
    for (const k of fields) {
      if (req.body && typeof req.body[k] === "string") form.append(k, req.body[k]);
    }

    const aiResp = await axios.post(AI_URL, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      timeout: 120000, // 120s
    });

    // 2) vráť klientovi AI výsledok + filename
    return res.json({
      status: "success",
      message: "File uploaded + analyzed",
      filename,
      ai: aiResp.data,
    });
  } catch (err) {
    console.error("UPLOAD/ANALYZE ERROR:", err?.response?.data || err.message);
    return res.status(500).json({
      status: "error",
      message: "Analyze failed",
      detail: err?.response?.data || err.message,
    });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));