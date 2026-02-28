// file: backend/worker.js
"use strict";

const crypto = require("crypto");
const axios = require("axios");
const FormData = require("form-data");
const { Worker } = require("bullmq");
const { analyzeQueue, connection } = require("./queue");

// ========= ENV =========
const AI_URL = (process.env.AI_URL || "https://voicesafe-ai.onrender.com/analyze").replace(/\/+$/, "");
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 120000);

// ========= Helpers =========
function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function pickNumber(obj, keys, fallback = 0) {
  for (const k of keys) {
    if (!obj) continue;
    const v = obj[k];
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function pickText(obj, keys, fallback = "") {
  for (const k of keys) {
    if (!obj) continue;
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return fallback;
}

function normalizeFlags(flags) {
  if (!flags) return [];
  if (Array.isArray(flags)) return flags.filter(Boolean).slice(0, 12);
  if (typeof flags === "string") return flags.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 12);
  return [];
}

async function callAI({ rid, file, meta }) {
  const fd = new FormData();

  fd.append("file", Buffer.from(file.bufferBase64, "base64"), {
    filename: file.originalname || "upload.bin",
    contentType: file.mimetype || "application/octet-stream",
  });

  const metaKeys = ["title", "platform", "country", "language", "tags", "notes"];
  for (const k of metaKeys) {
    if (meta && meta[k] !== undefined) fd.append(k, String(meta[k]));
  }

  const resp = await axios.post(AI_URL, fd, {
    headers: { ...fd.getHeaders(), "x-request-id": rid },
    timeout: AI_TIMEOUT_MS,
    maxBodyLength: Infinity,
    validateStatus: () => true,
  });

  if (resp.status < 200 || resp.status >= 300) {
    const err = new Error(`AI_NON_2XX:${resp.status}`);
    err.status = resp.status;
    err.data = resp.data;
    throw err;
  }

  return resp.data || {};
}

// ========= Worker =========
const worker = new Worker(
  analyzeQueue.name,
  async (job) => {
    const rid = job.data?.rid || crypto.randomBytes(8).toString("hex");
    const file = job.data?.file;
    const meta = job.data?.meta || {};

    if (!file?.bufferBase64) {
      throw new Error("JOB_BAD_PAYLOAD: missing file.bufferBase64");
    }

    const fileHash = sha256(Buffer.from(file.bufferBase64, "base64"));

    const aiRaw = await callAI({ rid, file, meta });

    // Normalize to stable contract for frontend
    const aiResult = {
      summary: pickText(aiRaw, ["summary", "message", "explanation"], "Done."),
      ai_probability: pickNumber(aiRaw, ["ai_probability", "aiProb", "ai_voice_prob", "ai_voice_probability"], 0),
      stress_level: pickNumber(aiRaw, ["stress_level", "stressLevel", "stress", "stress_score"], 0),
      scam_score: pickNumber(aiRaw, ["scam_score", "scamScore", "risk", "risk_score"], 0),
      flags: normalizeFlags(aiRaw.flags || aiRaw.signals || aiRaw.red_flags || aiRaw.redFlags),
      voice_match: pickText(aiRaw, ["voice_match", "voiceMatch", "match"], "Unknown"),
      meta: aiRaw.meta || undefined,
    };

    return {
      ok: true,
      aiResult,
      debug: {
        fileName: file.originalname || "upload.bin",
        fileType: file.mimetype || "application/octet-stream",
        fileSize: Number(file.size || 0),
        fileHash,
        ai_keys: Object.keys(aiRaw || {}).slice(0, 60),
      },
    };
  },
  { connection, concurrency: Number(process.env.WORKER_CONCURRENCY || 2) }
);

worker.on("completed", (job) => {
  console.log(`[worker] completed job=${job.id}`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] failed job=${job?.id}`, err?.message || err);
});

console.log("✅ VoiceSafe worker started");
console.log("Queue:", analyzeQueue.name);
console.log("AI_URL:", AI_URL);