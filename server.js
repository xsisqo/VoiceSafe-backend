const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");

const app = express();
app.use(cors());
app.use(express.json());

// ====== CONFIG
// Local default: Flask running on 127.0.0.1:5000/analyze
// Production: set AI_URL in Render env vars (example: https://your-ai.onrender.com/analyze)
const AI_URL =
  process.env.AI_URL ||
  "https://voicesafe-ai.onrender.com/analyze";

// IMPORTANT: Render gives PORT dynamically; local uses 10000
const PORT = process.env.PORT || 10000;

// ====== Upload folder
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ====== Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const upload = multer({ storage });

// Accept BOTH field names: "file" and "audio"
const uploadAny = upload.fields([
  { name: "file", maxCount: 1 },
  { name: "audio", maxCount: 1 },
]);

// ====== In-memory simple DB (if you already have your DB, keep your own version)
// This keeps compatibility: /cases, /case/:id, /case (POST)
let CASES = [];

// ====== Root
app.get("/", (req, res) => res.send("Backend OK ✅"));

// ====== Health
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "voicesafe-backend", ai_url: AI_URL });
});

// ====== Upload + Analyze
app.post("/upload", uploadAny, async (req, res) => {
  try {
    const f =
      (req.files && req.files.file && req.files.file[0]) ||
      (req.files && req.files.audio && req.files.audio[0]);

    if (!f) {
      return res.status(400).json({
        status: "error",
        message: "No file uploaded. Use form field name: file (or audio).",
      });
    }

    console.log("File uploaded:", f);

    // Send file to Flask AI
    const fullPath = f.path; // already absolute-ish on Windows
    console.log("Sending file to AI:", fullPath, "AI_URL:", AI_URL);

    const form = new FormData();
    form.append("file", fs.createReadStream(fullPath), f.originalname);

    const aiResp = await axios.post(AI_URL, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 120000,
    });

    // Ensure consistent payload for frontend
    const out = aiResp.data || {};
    out.filename = out.filename || f.filename;

    return res.json(out);
  } catch (err) {
    console.error("UPLOAD/AI ERROR:", err?.message || err);

    // If axios error, show helpful detail
    const detail = err?.response?.data || null;

    return res.status(500).json({
      status: "error",
      message: "Analyze failed. Check Backend/AI logs.",
      detail,
    });
  }
});

// ====== CASES API (simple version)
function makeId() {
  return (
    Date.now().toString(16) + Math.random().toString(16).slice(2, 10)
  ).replace(".", "");
}

app.get("/cases", (req, res) => {
  const q = (req.query.q || "").toLowerCase().trim();
  const tag = (req.query.tag || "").toLowerCase().trim();

  let items = [...CASES];

  if (q) {
    items = items.filter((c) => {
      const meta = c.meta || {};
      const data = c.data || {};
      const hay =
        `${meta.title || ""} ${meta.notes || ""} ${data.filename || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }

  if (tag) {
    items = items.filter((c) => {
      const tags = (c.meta?.tags || []).map((t) => String(t).toLowerCase());
      return tags.includes(tag);
    });
  }

  res.json({ status: "success", total: items.length, cases: items });
});

app.get("/case/:id", (req, res) => {
  const id = req.params.id;
  const item = CASES.find((c) => c.id === id);
  if (!item) return res.status(404).json({ status: "error", message: "Case not found" });
  res.json({ status: "success", case: item });
});

app.post("/case", (req, res) => {
  const meta = req.body?.meta || {};
  const data = req.body?.data || null;

  const id = makeId();
  const now = new Date().toISOString();

  const item = {
    id,
    created_at: now,
    meta: {
      title: meta.title || "",
      platform: meta.platform || "",
      country: meta.country || "",
      language: meta.language || "EN",
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      notes: meta.notes || "",
    },
    data,
  };

  CASES.unshift(item);
  res.json({ status: "success", caseId: id, case: item });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`AI_URL = ${AI_URL}`);
});