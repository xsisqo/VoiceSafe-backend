// backend/routes/share.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();

// data file: backend/data/shares.json
const dataDir = path.join(__dirname, "..", "data");
const dataFile = path.join(dataDir, "shares.json");

function ensureDataFile() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, JSON.stringify({}), "utf-8");
}

function readAll() {
  ensureDataFile();
  const raw = fs.readFileSync(dataFile, "utf-8");
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function writeAll(obj) {
  ensureDataFile();
  const tmp = dataFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8");
  fs.renameSync(tmp, dataFile);
}

function newId() {
  // short, url-safe
  return crypto.randomBytes(9).toString("base64url");
}

/**
 * POST /share
 * Body: { result: {...}, meta?: {...} }
 * Returns: { ok:true, share_id, share_url }
 */
router.post("/share", (req, res) => {
  try {
    const { result, meta } = req.body || {};
    if (!result || typeof result !== "object") {
      return res.status(400).json({ ok: false, error: "missing_result" });
    }

    const share_id = newId();
    const all = readAll();

    all[share_id] = {
      share_id,
      created_at: new Date().toISOString(),
      result,
      meta: meta && typeof meta === "object" ? meta : {},
    };

    writeAll(all);

    const base = `${req.protocol}://${req.get("host")}`;
    const share_url = `${base}/share/${share_id}`;

    return res.json({ ok: true, share_id, share_url });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "share_create_failed", message: String(e?.message || e) });
  }
});

/**
 * GET /share/:id
 * Returns stored share payload
 */
router.get("/share/:id", (req, res) => {
  try {
    const id = req.params.id;
    const all = readAll();
    const item = all[id];
    if (!item) return res.status(404).json({ ok: false, error: "not_found" });
    return res.json({ ok: true, share: item });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "share_read_failed", message: String(e?.message || e) });
  }
});

module.exports = router;