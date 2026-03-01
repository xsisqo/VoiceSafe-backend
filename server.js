// ===============================================
// VoiceSafe Backend — GLOBAL ENTERPRISE EDITION
// ===============================================

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
ffmpeg.setFfmpegPath(ffmpegPath);

// ===============================
// AUDIO NORMALIZATION (GLOBAL FORMAT SUPPORT)
// ===============================
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

ffmpeg.setFfmpegPath(ffmpegPath);

// ===============================
// INIT
// ===============================

const app = express();
const PORT = process.env.PORT || 5000;

const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://voicesafe.ai";

const AI_URL =
  process.env.AI_URL || "https://voicesafe-ai.onrender.com/analyze";

const AI_HEALTH_URL = AI_URL.replace(/\/analyze\/?$/i, "/health");

// ===============================
// SECURITY LAYER
// ===============================

app.use(helmet());

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ===============================
// CORS
// ===============================

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
  })
);

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
      `[${rid}] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`
    );
  });

  next();
});

// ===============================
// FILE UPLOAD (STRICT VALIDATION)
// ===============================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024 }, // 80MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      "audio/",
      "video/"
    ];

    if (allowed.some((type) => file.mimetype.startsWith(type))) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported file type"), false);
    }
  },
});

// ===============================
// HELPERS
// ===============================

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function convertToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioChannels(1)
      .audioFrequency(16000)
      .format("wav")
      .on("end", resolve)
      .on("error", reject)
      .save(outputPath);
  });
}

async function safeUnlink(file) {
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}
}

// Convert ANY audio → WAV (AI safe)
async function normalizeAudio(buffer) {
  const input = path.join(__dirname, "tmp_in_" + Date.now());
  const output = path.join(__dirname, "tmp_out_" + Date.now() + ".wav");

  fs.writeFileSync(input, buffer);

  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .audioChannels(1)
      .audioFrequency(16000)
      .format("wav")
      .on("end", () => {
        const data = fs.readFileSync(output);
        fs.unlinkSync(input);
        fs.unlinkSync(output);
        resolve(data);
      })
      .on("error", (err) => {
        fs.unlinkSync(input);
        reject(err);
      })
      .save(output);
  });
}

// ===============================
// ROUTES
// ===============================

app.get("/", (req, res) => {
  res.json({ ok: true, service: "voicesafe-enterprise" });
});

app.get("/health", async (req, res) => {
  let ai_ok = false;
  try {
    const r = await axios.get(AI_HEALTH_URL, { timeout: 4000 });
    ai_ok = r.status === 200;
  } catch {}
  res.json({ ok: true, ai_ok });
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

// Accept ANY audio/video container from mobile apps
if (!req.file.mimetype.includes("audio") &&
    !req.file.mimetype.includes("video")) {
  return res.status(400).json({
    ok:false,
    message:"Unsupported file type"
  });
}

    const fileHash = sha256(req.file.buffer);

    console.log(
      `[${rid}] FILE ${req.file.originalname} (${req.file.mimetype}) HASH ${fileHash.slice(
        0,
        12
      )}`
    );

    const baseTmp = path.join(
      os.tmpdir(),
      `vs_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`
    );

    const inputPath = baseTmp;
const wavPath = baseTmp + ".wav";

// 🔍 DEBUG — zistíme čo mobil reálne posiela
console.log("MIME:", req.file.mimetype);
console.log("SIZE:", req.file.size);

fs.writeFileSync(inputPath, req.file.buffer);

await convertToWav(inputPath, wavPath);

    const fd = new FormData();
    fd.append("file", fs.createReadStream(wavPath), {
      filename: "audio.wav",
      contentType: "audio/wav",
    });

    const aiResp = await axios.post(AI_URL, fd, {
      headers: fd.getHeaders(),
      timeout: 120000,
      maxBodyLength: Infinity,
      validateStatus: () => true,
    });

    await safeUnlink(inputPath);
    await safeUnlink(wavPath);

    if (aiResp.status >= 300) {
      console.error(`[${rid}] AI ERROR`, aiResp.status);
      return res.status(502).json({
        ok: false,
        message: "AI analyze failed",
        ai_status: aiResp.status,
      });
    }

    return res.json({
      ok: true,
      aiResult: aiResp.data,
      debug: {
        fileHash,
      },
    });
  } catch (err) {
    console.error(`[${rid}] CRITICAL ERROR`, err.message);

    return res.status(500).json({
      ok: false,
      message: "Analyze failed",
      error: err.message,
    });
  }
});

// ===============================
// START
// ===============================

app.listen(PORT, () => {
  console.log(`🚀 VoiceSafe ENTERPRISE running on ${PORT}`);
});