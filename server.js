// backend/server.js
// VoiceSafe Backend — MAX (v3.1)
// ✅ API keys (multi-tenant)
// ✅ Rate limiting + Helmet
// ✅ Upload audio/video -> ffmpeg normalize to WAV mono 16kHz -> AI analyze
// ✅ Cases stored in Postgres + Audit logs
// ✅ Optional S3 (R2/S3/MinIO) storage for evidence
// ✅ Streaming prototype: /stream/start + /stream/chunk (2s chunks) + rolling risk
//
// ENV (required):
// - AI_URL
// - DATABASE_URL
// - VS_API_KEYS=key1,key2 (first key is admin)
// ENV (optional):
// - REQUIRE_API_KEY=1
// - PUBLIC_CASE_READ=0
// - CORS_ORIGINS=...
// - RATE_LIMIT_RPM=60
// - MAX_UPLOAD_MB=50
// - AI_TIMEOUT_MS=120000
// - AI_INTERNAL_KEY=... (shared secret to AI)
// - PG_SSL=1
// - S3_ENABLED=0 and S3_* vars

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const FormData = require("form-data");
const { spawn } = require("child_process");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const pinoHttp = require("pino-http");
const { Pool } = require("pg");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const app = express();

// ===========================
// Config
// ===========================
const PORT = process.env.PORT || 5000;
const AI_URL = process.env.AI_URL || "https://voicesafe-ai.onrender.com/analyze";

const VS_API_KEYS = (process.env.VS_API_KEYS || "").split(",").map(s=>s.trim()).filter(Boolean);
const REQUIRE_API_KEY = (process.env.REQUIRE_API_KEY || "1") === "1";
const PUBLIC_CASE_READ = (process.env.PUBLIC_CASE_READ || "0") === "1";

const CORS_ORIGINS = (process.env.CORS_ORIGINS || "https://voicesafe.ai,https://voicesafe-frontend.onrender.com")
  .split(",").map(s=>s.trim()).filter(Boolean);

const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || "50", 10);
const MAX_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const AI_TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || "120000", 10);

const DATABASE_URL = process.env.DATABASE_URL || "";
const PG_SSL = (process.env.PG_SSL || "1") === "1";

// S3 (optional)
const S3_ENABLED = (process.env.S3_ENABLED || "0") === "1";
const S3_ENDPOINT = process.env.S3_ENDPOINT || "";
const S3_REGION = process.env.S3_REGION || "auto";
const S3_BUCKET = process.env.S3_BUCKET || "";
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || "";
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || "";
const S3_FORCE_PATH_STYLE = (process.env.S3_FORCE_PATH_STYLE || "0") === "1";

const AI_INTERNAL_KEY = process.env.AI_INTERNAL_KEY || "";

const uploadsDir = path.join(__dirname, "uploads");
const workDir = path.join(__dirname, "work");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(workDir)) fs.mkdirSync(workDir);

// ===========================
// Logging + Security
// ===========================
app.use(pinoHttp({
  customLogLevel: function (res, err) {
    if (res.statusCode >= 500 || err) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  }
}));
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: "2mb" }));

app.use(cors({
  origin: function(origin, cb){
    if (!origin) return cb(null, true);
    if (CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("CORS not allowed"), false);
  },
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","x-request-id","x-api-key"],
  exposedHeaders: ["x-request-id","x-runtime-ms"]
}));

// Global RPM limiter (per IP)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: parseInt(process.env.RATE_LIMIT_RPM || "60", 10),
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// Request ID + runtime
app.use((req, res, next) => {
  const rid = req.header("x-request-id") || crypto.randomBytes(6).toString("hex");
  req.rid = rid;
  res.setHeader("x-request-id", rid);
  const t0 = Date.now();
  res.on("finish", () => res.setHeader("x-runtime-ms", String(Date.now() - t0)));
  next();
});

// ===========================
// Auth
// ===========================
function requireKey(req, res, next){
  if (!REQUIRE_API_KEY) return next();
  const key = req.header("x-api-key") || "";
  if (!key || !VS_API_KEYS.includes(key)){
    return res.status(401).json({ ok:false, status:"error", message:"Unauthorized (missing/invalid API key)" });
  }
  req.apiKey = key;
  next();
}
function requireKeyUnlessPublicRead(req, res, next){
  if (PUBLIC_CASE_READ) return next();
  return requireKey(req, res, next);
}
function requireAdmin(req, res, next){
  if (!VS_API_KEYS[0] || req.apiKey !== VS_API_KEYS[0]){
    return res.status(403).json({ ok:false, message:"Forbidden" });
  }
  next();
}

// ===========================
// Postgres
// ===========================
let pool = null;
async function initDb(){
  if (!DATABASE_URL) throw new Error("DATABASE_URL missing");
  pool = new Pool({ connectionString: DATABASE_URL, ssl: PG_SSL ? { rejectUnauthorized: false } : false });
  await pool.query("select 1");
}
async function db(sql, params){ return pool.query(sql, params); }

async function audit(event_type, data, req){
  try{
    await db(
      `insert into audit_logs(event_type, rid, ip, api_key, data) values ($1,$2,$3,$4,$5)`,
      [event_type, req?.rid || null, req?.ip || null, req?.apiKey || null, data || {}]
    );
  }catch(e){
    req?.log?.warn({err:e}, "audit_failed");
  }
}

// ===========================
// S3 (optional)
// ===========================
let s3 = null;
function initS3(){
  if (!S3_ENABLED) return;
  if (!S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) return;

  s3 = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT || undefined,
    forcePathStyle: S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY }
  });
}
async function s3Put(key, filePath, contentType){
  if (!s3) return null;
  const body = fs.createReadStream(filePath);
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType || "audio/wav",
  }));
  return { bucket: S3_BUCKET, key };
}

// ===========================
// Upload handling
// ===========================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, "_")}`),
});
const upload = multer({ storage, limits: { fileSize: MAX_BYTES } });

function isAudioOrVideo(mime=""){
  const m = String(mime).toLowerCase();
  return m.startsWith("audio/") || m.startsWith("video/") || m === "application/octet-stream";
}
function safeUnlink(p){ try{ if (p && fs.existsSync(p)) fs.unlinkSync(p); }catch{} }

function ffmpegToWav16kMono(inputPath, outputPath){
  return new Promise((resolve, reject)=>{
    const args = ["-y","-i", inputPath, "-ac","1","-ar","16000","-c:a","pcm_s16le", outputPath];
    const p = spawn("ffmpeg", args, { stdio:["ignore","pipe","pipe"] });
    let stderr="";
    p.stderr.on("data", d => stderr += d.toString());
    p.on("error", e => reject(new Error(`ffmpeg spawn failed: ${e.message}`)));
    p.on("close", code => code===0 ? resolve() : reject(new Error(`ffmpeg exit ${code}. ${stderr.slice(0,1800)}`)));
  });
}
function makeId(){ return crypto.randomBytes(9).toString("base64url"); }

// ===========================
// Streaming prototype (in-memory sessions)
// ===========================
const streams = new Map(); // sessionId -> { createdAt, ema, peak, lastUpdate, count }
function streamUpdate(sess, scam, ai, stress){
  const risk = Math.max(Number(scam)||0, Number(ai)||0, Number(stress)||0);
  const alpha = 0.35;
  sess.ema = sess.ema == null ? risk : (alpha*risk + (1-alpha)*sess.ema);
  sess.peak = Math.max(sess.peak||0, risk);
  sess.count = (sess.count||0) + 1;
  sess.lastUpdate = Date.now();
  return { risk_now: risk, risk_ema: Math.round(sess.ema), risk_peak: Math.round(sess.peak), chunks: sess.count };
}

// ===========================
// Routes
// ===========================
app.get("/", (req,res)=> res.json({ ok:true, service:"voicesafe-backend", version:"3.1.0", ai_url:AI_URL }));

app.get("/health", async (req,res)=>{
  let dbOk = false;
  try { await pool.query("select 1"); dbOk = true; } catch {}
  res.json({ ok:true, service:"voicesafe-backend", ai_url:AI_URL, db: dbOk, s3: !!s3, max_upload_mb: MAX_UPLOAD_MB });
});

// Upload+Analyze (store case)
app.post("/upload", requireKey, upload.single("audio"), async (req,res)=>{
  const t0 = Date.now();
  let wavPath = null;

  try{
    if (!req.file) return res.status(400).json({ status:"error", message:"No file uploaded" });
    if (!isAudioOrVideo(req.file.mimetype)) return res.status(400).json({ status:"error", message:`Unsupported type: ${req.file.mimetype||"unknown"}` });

    const caseId = makeId();
    wavPath = path.join(workDir, `${caseId}.wav`);
    await ffmpegToWav16kMono(req.file.path, wavPath);

    const form = new FormData();
    form.append("file", fs.createReadStream(wavPath), { filename:"input.wav", contentType:"audio/wav" });

    const fields = ["title","platform","country","language","tags","notes"];
    const meta = {};
    for (const k of fields){
      const v = (req.body && typeof req.body[k]==="string") ? req.body[k].slice(0,4000) : "";
      meta[k] = v;
      if (v) form.append(k, v);
    }

    const aiResp = await axios.post(AI_URL, form, {
      headers: { ...form.getHeaders(), "x-request-id": req.rid, "x-internal-auth": AI_INTERNAL_KEY },
      timeout: AI_TIMEOUT_MS,
      maxBodyLength: Infinity,
      validateStatus: () => true
    });

    const runtime_ms = Date.now() - t0;

    if (aiResp.status < 200 || aiResp.status >= 300){
      await audit("analyze_failed", { caseId, ai_status: aiResp.status, detail: aiResp.data }, req);
      return res.status(502).json({ status:"error", message:"AI analyze failed", ai_status: aiResp.status, detail: aiResp.data, runtime_ms });
    }

    const out = aiResp.data || {};
    const s3Info = S3_ENABLED ? await s3Put(`cases/${caseId}/input.wav`, wavPath, "audio/wav").catch(()=>null) : null;

    await db(
      `insert into cases(id, rid, api_key, original_filename, stored_filename, output_format, runtime_ms,
        title, platform, country, language, tags, notes,
        risk_level, confidence, scam_score, ai_probability, stress_level, summary,
        flags, transcript, features, file_hash, pipeline, storage)
       values ($1,$2,$3,$4,$5,$6,$7,
               $8,$9,$10,$11,$12,$13,
               $14,$15,$16,$17,$18,$19,
               $20,$21,$22,$23,$24,$25)`,
      [
        caseId, req.rid, req.apiKey, req.file.originalname, req.file.filename, "wav_16k_mono", runtime_ms,
        meta.title || null, meta.platform || null, meta.country || null, meta.language || null, meta.tags || null, meta.notes || null,
        out.risk_level || null, out.confidence ?? null, out.scam_score ?? null, out.ai_probability ?? null, out.stress_level ?? null,
        out.summary || null,
        out.flags ? JSON.stringify(out.flags) : JSON.stringify([]),
        out.transcript || null,
        out.features ? JSON.stringify(out.features) : null,
        out.file_hash || null,
        out.pipeline ? JSON.stringify(out.pipeline) : null,
        s3Info ? JSON.stringify(s3Info) : null
      ]
    );

    await audit("case_created", { caseId, risk_level: out.risk_level, runtime_ms }, req);

    return res.json({
      ...out,
      case_id: caseId,
      runtime_ms,
      output_format: "wav_16k_mono",
      original_filename: req.file.originalname
    });

  }catch(err){
    req.log.error({err}, "upload_analyze_error");
    await audit("upload_analyze_error", { detail: err?.message || String(err) }, req);
    return res.status(500).json({ status:"error", message:"Upload/convert/analyze failed", detail: err?.message || String(err) });
  }finally{
    safeUnlink(wavPath);
  }
});

// Streaming: start session
app.post("/stream/start", requireKey, async (req,res)=>{
  const session_id = makeId();
  streams.set(session_id, { createdAt: Date.now(), ema: null, peak: 0, lastUpdate: Date.now(), count: 0 });
  await audit("stream_start", { session_id }, req);
  res.json({ ok:true, session_id });
});

// Streaming: chunk analyze
app.post("/stream/chunk", requireKey, upload.single("audio"), async (req,res)=>{
  const t0 = Date.now();
  let wavPath = null;

  try{
    const session_id = String(req.query.session_id || req.body.session_id || "");
    if (!session_id || !streams.has(session_id)) return res.status(400).json({ ok:false, message:"Invalid session_id" });
    if (!req.file) return res.status(400).json({ ok:false, message:"No chunk uploaded" });

    const sess = streams.get(session_id);

    wavPath = path.join(workDir, `${session_id}-${Date.now()}.wav`);
    await ffmpegToWav16kMono(req.file.path, wavPath);

    const form = new FormData();
    form.append("file", fs.createReadStream(wavPath), { filename:"chunk.wav", contentType:"audio/wav" });

    const aiResp = await axios.post(AI_URL, form, {
      headers: { ...form.getHeaders(), "x-request-id": req.rid, "x-internal-auth": AI_INTERNAL_KEY },
      timeout: AI_TIMEOUT_MS,
      maxBodyLength: Infinity,
      validateStatus: () => true
    });

    const runtime_ms = Date.now() - t0;
    if (aiResp.status < 200 || aiResp.status >= 300){
      await audit("stream_chunk_failed", { session_id, ai_status: aiResp.status }, req);
      return res.status(502).json({ ok:false, message:"AI analyze failed", ai_status: aiResp.status, detail: aiResp.data, runtime_ms });
    }

    const out = aiResp.data || {};
    const scam = Number(out.scam_score ?? 0);
    const ai = Number(out.ai_probability ?? 0);
    const stress = Number(out.stress_level ?? 0);
    const scamPct = scam <= 1 ? scam*100 : scam;
    const aiPct = ai <= 1 ? ai*100 : ai;
    const stressPct = stress <= 1 ? stress*100 : stress;

    const upd = streamUpdate(sess, scamPct, aiPct, stressPct);
    await audit("stream_chunk", { session_id, ...upd, risk_level: out.risk_level }, req);

    return res.json({
      ok: true,
      session_id,
      runtime_ms,
      rolling: upd,
      risk_level: out.risk_level,
      confidence: out.confidence,
      scam_score: out.scam_score,
      ai_probability: out.ai_probability,
      stress_level: out.stress_level,
      flags: out.flags || []
    });

  }catch(err){
    req.log.error({err}, "stream_chunk_error");
    await audit("stream_chunk_error", { detail: err?.message || String(err) }, req);
    return res.status(500).json({ ok:false, message:"Stream chunk failed", detail: err?.message || String(err) });
  }finally{
    safeUnlink(wavPath);
  }
});

// Cases read
app.get("/cases/:id", requireKeyUnlessPublicRead, async (req,res)=>{
  try{
    const id = req.params.id;
    const r = await db("select * from cases where id=$1", [id]);
    if (!r.rowCount) return res.status(404).json({ ok:false, message:"Case not found" });
    const c = r.rows[0];
    await audit("case_read", { id }, req);
    return res.json({
      id: c.id,
      case_id: c.id,
      created_at: c.created_at,
      summary: c.summary,
      risk_level: c.risk_level,
      confidence: c.confidence,
      scam_score: c.scam_score,
      ai_probability: c.ai_probability,
      stress_level: c.stress_level,
      flags: c.flags || [],
      transcript: c.transcript,
      features: c.features,
      file_hash: c.file_hash,
      pipeline: c.pipeline,
      runtime_ms: c.runtime_ms,
      title: c.title,
      platform: c.platform,
      country: c.country,
      language: c.language,
      tags: c.tags,
      notes: c.notes,
      storage: c.storage
    });
  }catch(err){
    req.log.error({err}, "case_read_error");
    return res.status(500).json({ ok:false, message:"Case read failed" });
  }
});

app.get("/cases/search", requireKey, async (req,res)=>{
  try{
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ ok:true, items: [] });

    const r = await db(
      `select id, created_at, title, risk_level from cases
       where api_key=$1 and to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(notes,'') || ' ' || coalesce(tags,''))
             @@ plainto_tsquery('simple', $2)
       order by created_at desc limit 50`,
      [req.apiKey, q]
    );

    await audit("case_search", { q }, req);
    return res.json({ ok:true, items: r.rows });
  }catch(err){
    req.log.error({err}, "case_search_error");
    return res.status(500).json({ ok:false, message:"Search failed" });
  }
});

// Audit logs (admin)
app.get("/audit/recent", requireKey, requireAdmin, async (req,res)=>{
  try{
    const r = await db(`select id, created_at, event_type, rid, ip, api_key, data from audit_logs order by created_at desc limit 100`, []);
    return res.json({ ok:true, items: r.rows });
  }catch(err){
    req.log.error({err}, "audit_recent_error");
    return res.status(500).json({ ok:false, message:"Audit read failed" });
  }
});

// Boot
(async ()=>{
  try{
    await initDb();
    initS3();
    console.log("DB connected");
  }catch(e){
    console.error("INIT ERROR:", e.message);
  }
  app.listen(PORT, ()=> console.log(`VoiceSafe backend v3.1 on ${PORT}`));
})();
