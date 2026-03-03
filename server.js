// backend/server.js
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const FormData = require("form-data");

const app = express();
const PORT = process.env.PORT || 5000;

const AI_URL =
  process.env.AI_URL ||
  "https://voicesafe-ai-mmnf.onrender.com/analyze";

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "5mb" }));

// ===== HEALTH =====
app.get("/", (req, res) =>
  res.json({ ok: true, service: "voicesafe-backend" })
);

app.get("/health", (req, res) =>
  res.json({ ok: true, ai_url: AI_URL })
);

// ===== Upload folder =====
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

app.use("/uploads", express.static(uploadsDir));

// ===== Multer =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ===== MAIN ENDPOINT =====
app.post("/upload", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        status: "error",
        message: "No file uploaded",
      });
    }

    const filePath = req.file.path;

    const form = new FormData();
    form.append("file", fs.createReadStream(filePath), {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });

    const metaFields = [
      "title",
      "platform",
      "country",
      "language",
      "tags",
      "notes",
    ];

    for (const key of metaFields) {
      if (req.body[key]) {
        form.append(key, req.body[key]);
      }
    }

    const aiResp = await axios.post(AI_URL, form, {
      headers: form.getHeaders(),
      timeout: 120000,
      maxBodyLength: Infinity,
    });

    return res.json({
      ...aiResp.data,
      backend_processed: true,
      filename: req.file.filename,
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err?.response?.data || err.message);
    return res.status(500).json({
      status: "error",
      message: "Analyze failed",
      detail: err?.response?.data || err.message,
    });
  }
});

app.listen(PORT, () =>
  console.log(`VoiceSafe backend running on port ${PORT}`)
);