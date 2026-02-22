const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const FormData = require("form-data");
const http = require("http");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const AI_URL = process.env.AI_URL || "https://voicesafe-ai.onrender.com/analyze";
const AI_BASE = AI_URL.replace(/\/analyze\/?$/, "");

const UPLOAD_DIR = path.join(__dirname, "uploads");
const DATA_DIR = path.join(__dirname, "data");
const CASES_FILE = path.join(DATA_DIR, "cases.json");

// ---- axios instance (keep-alive + higher timeouts) ----
const axiosAI = axios.create({
  timeout: 120000, // 120s
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true }),
  validateStatus: () => true
});

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

// Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

// ---------- Helpers: AI warmup + retry ----------
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function warmupAI() {
  // Skúsime /health, ak neexistuje, skúsime /
  const urls = [`${AI_BASE}/health`, `${AI_BASE}/`];
  for (const u of urls) {
    try {
      const r = await axiosAI.get(u);
      if (r.status >= 200 && r.status < 500) return { ok: true, url: u, status: r.status };
    } catch (_) {}
  }
  return { ok: false };
}

function isRetryable(err) {
  const msg = String(err?.message || "").toLowerCase();
  const code = String(err?.code || "").toUpperCase();
  return (
    msg.includes("stream has been aborted") ||
    msg.includes("socket hang up") ||
    msg.includes("econnreset") ||
    msg.includes("econnaborted") ||
    code === "ECONNRESET" ||
    code === "ECONNABORTED" ||
    code === "ETIMEDOUT"
  );
}

async function sendFileToAI(filePath, originalname) {
  // 3 pokusy: 0s, 2s, 5s
  const delays = [0, 2000, 5000];

  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) await sleep(delays[attempt]);

    // pred prvým pokusom sprav warmup
    if (attempt === 0) {
      const warm = await warmupAI();
      console.log("AI warmup:", warm);
    }

    try {
      const form = new FormData();
      form.append("file", fs.createReadStream(filePath), originalname);

      const resp = await axiosAI.post(AI_URL, form, {
        headers: form.getHeaders()
      });

      // ak AI vracia 200, je vybavené
      if (resp.status >= 200 && resp.status < 300) return resp;

      // AI odpovedalo chybou -> toto nie je "stream abort", ale reálna odpoveď AI
      const err = new Error(`AI returned HTTP ${resp.status}`);
      err.response = resp;
      throw err;

    } catch (err) {
      console.log(`AI attempt ${attempt + 1} failed:`, err?.message || err);

      // retry len na typické network abort/reset
      if (attempt < delays.length - 1 && isRetryable(err)) {
        console.log("Retrying AI request…");
        continue;
      }
      throw err;
    }
  }
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

// Upload + analyze
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ status: "error", message: "No file uploaded" });

    // meta môže prísť ako JSON string "meta"
    let meta = { title:"", platform:"", country:"", language:"", tags:[], notes:"" };
    if (req.body?.meta) {
      try {
        const parsed = JSON.parse(req.body.meta);
        meta = {
          title: parsed.title || "",
          platform: parsed.platform || "",
          country: parsed.country || "",
          language: parsed.language || "",
          tags: Array.isArray(parsed.tags) ? parsed.tags : [],
          notes: parsed.notes || ""
        };
      } catch {}
    }

    console.log("File uploaded:", {
      originalname: req.file.originalname,
      filename: req.file.filename,
      path: req.file.path,
      size: req.file.size,
      mimetype: req.file.mimetype
    });
    console.log("Sending file to AI:", req.file.path);
    console.log("AI_URL:", AI_URL);

    // 🔥 tu je fix: warmup + retry + vyšší timeout
    const aiResp = await sendFileToAI(req.file.path, req.file.originalname);

    const aiData = aiResp.data;

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

    res.json({ status: "success", case_id: id, case: newCase });

  } catch (err) {
    console.error("UPLOAD/AI ERROR:", err?.message || err);

    const aiStatus = err?.response?.status || null;
    const detail = err?.response?.data || null;

    res.status(500).json({
      status: "error",
      message: "Analyze failed. Check Backend/AI logs.",
      ai_status: aiStatus,
      detail,
      debug: {
        code: err?.code || null,
        error_message: err?.message || null,
        ai_url: AI_URL
      }
    });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));