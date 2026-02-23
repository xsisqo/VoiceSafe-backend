const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const FormData = require("form-data");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const AI_URL = process.env.AI_URL || "https://voicesafe-ai.onrender.com/analyze";

const UPLOAD_DIR = path.join(__dirname, "uploads");
const DATA_DIR = path.join(__dirname, "data");
const CASES_FILE = path.join(DATA_DIR, "cases.json");

function ensureDirs() {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CASES_FILE)) fs.writeFileSync(CASES_FILE, JSON.stringify({ cases: [] }, null, 2));
}
ensureDirs();

async function readCases() {
  try {
    const raw = await fsp.readFile(CASES_FILE, "utf8");
    const obj = JSON.parse(raw || "{}");
    if (!obj.cases) obj.cases = [];
    return obj;
  } catch {
    return { cases: [] };
  }
}

async function writeCases(obj) {
  await fsp.writeFile(CASES_FILE, JSON.stringify(obj, null, 2), "utf8");
}

function makeId() {
  return crypto.randomBytes(12).toString("hex");
}

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function normalizeMeta(meta) {
  const m = meta || {};
  const tags =
    Array.isArray(m.tags) ? m.tags :
    typeof m.tags === "string" ? m.tags.split(",") :
    [];

  return {
    title: m.title || "",
    platform: m.platform || "",
    country: m.country || "",
    language: m.language || "",
    tags: tags.map(String).map(s => s.trim()).filter(Boolean),
    notes: m.notes || ""
  };
}

// Multer upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});

// Zvýšime limit pre upload na backend (napr. 30MB)
const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 } // 30MB
});

// Best-effort "wake" AI (free instance môže spať)
async function warmupAi() {
  const base = AI_URL.replace(/\/analyze$/i, "");
  try {
    await axios.get(base + "/", { timeout: 15000 });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// KĽÚČOVÝ FIX: form-data maxDataSize (default 2MB) -> Infinity
async function sendToAi(filePath, originalName) {
  const MAX_TRIES = 3;

  const warm = await warmupAi();
  console.log("AI warmup:", warm);

  let lastErr = null;

  for (let i = 1; i <= MAX_TRIES; i++) {
    // ✅ FIX: maxDataSize Infinity
    const form = new FormData({ maxDataSize: Infinity });
    form.append("file", fs.createReadStream(filePath), originalName);

    try {
      console.log("Sending file to AI:", filePath);
      console.log("AI_URL:", AI_URL);

      const aiResp = await axios.post(AI_URL, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120000 // 120s
      });

      return aiResp.data;
    } catch (err) {
      lastErr = err;
      console.log(`AI attempt ${i} failed:`, err?.message || err);

      // malá pauza pred retry
      if (i < MAX_TRIES) {
        console.log("Retrying AI request…");
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }

  throw lastErr;
}

// Routes
app.get("/", (req, res) => res.send("Backend OK ✅"));

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "voicesafe-backend", ai_url: AI_URL });
});

app.get("/cases", async (req, res) => {
  const { q = "", tag = "" } = req.query;
  const db = await readCases();
  let list = db.cases.slice().reverse();

  if (q) {
    const qq = String(q).toLowerCase();
    list = list.filter(c => {
      const meta = c.meta || {};
      const hay = `${meta.title || ""} ${meta.notes || ""} ${(meta.tags || []).join(" ")}`.toLowerCase();
      return hay.includes(qq);
    });
  }

  if (tag) {
    const tt = String(tag).toLowerCase();
    list = list.filter(c => (c.meta?.tags || []).some(t => String(t).toLowerCase() === tt));
  }

  res.json({ status: "success", total: list.length, cases: list });
});

app.get("/case/:id", async (req, res) => {
  const id = req.params.id;
  const db = await readCases();
  const found = db.cases.find(c => c.id === id);
  if (!found) return res.status(404).json({ status: "error", message: `Case not found: ${id}` });
  res.json({ status: "success", case: found });
});

// upload endpoint
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ status: "error", message: "No file uploaded (field must be 'file')" });
    }

    console.log("File uploaded:", req.file);

    const metaFromJson = req.body?.meta ? safeJsonParse(req.body.meta) : null;
    const meta = normalizeMeta(metaFromJson || req.body);

    const aiData = await sendToAi(req.file.path, req.file.originalname);

    const id = makeId();
    const now = new Date().toISOString();

    const newCase = {
      id,
      created_at: now,
      updated_at: now,
      meta,
      data: { ...aiData, filename: req.file.filename, uploaded_at: now }
    };

    const db = await readCases();
    db.cases.push(newCase);
    await writeCases(db);

    res.json({
      status: "success",
      case_id: id,
      ...aiData,
      filename: req.file.filename,
      uploaded_at: now
    });
  } catch (err) {
    const aiStatus = err?.response?.status || null;

    console.log("UPLOAD/AI ERROR:", err?.message || err);

    res.status(500).json({
      status: "error",
      message: "Analyze failed. Check Backend/AI logs.",
      ai_status: aiStatus,
      detail: err?.response?.data || null
    });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));