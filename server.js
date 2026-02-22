const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");

const app = express();

// --------------------
// BASIC MIDDLEWARE
// --------------------
app.use(cors());
app.use(express.json());

// --------------------
// CONFIG
// --------------------
// Cloud AI (Render) - FIXED URL
const AI_URL = process.env.AI_URL || "https://voicesafe-ai.onrender.com/analyze";

// Render uses dynamic PORT, local can use 10000
const PORT = process.env.PORT || 10000;

// Upload dir
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// --------------------
// MULTER (upload)
// --------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

// Accept up to 25MB (you can change)
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
});

// Accept BOTH field names (frontend sometimes sends file, old versions audio)
const uploadAny = upload.fields([
  { name: "file", maxCount: 1 },
  { name: "audio", maxCount: 1 },
]);

// --------------------
// ROUTES
// --------------------
app.get("/", (req, res) => {
  res.send("Backend OK ✅");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "voicesafe-backend",
    ai_url: AI_URL,
  });
});

// Upload + Analyze
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

    console.log("File uploaded:", {
      originalname: f.originalname,
      filename: f.filename,
      path: f.path,
      size: f.size,
      mimetype: f.mimetype,
    });

    // Send file to AI (Render)
    console.log("Sending file to AI:", f.path);
    console.log("AI_URL:", AI_URL);

    const form = new FormData();
    form.append("file", fs.createReadStream(f.path), f.originalname);

    const aiResp = await axios.post(AI_URL, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 120000,
    });

    // Make sure response is JSON
    const out = aiResp.data || {};
    if (!out.filename) out.filename = f.filename;

    return res.json(out);
  } catch (err) {
    console.error("UPLOAD/AI ERROR:", err?.message || err);

    // Axios extra detail
    const detail = err?.response?.data || null;
    const status = err?.response?.status || 500;

    return res.status(500).json({
      status: "error",
      message: "Analyze failed. Check Backend/AI logs.",
      ai_status: status,
      detail,
    });
  }
});

// --------------------
// START
// --------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`AI_URL = ${AI_URL}`);
});