const path = require("path");
const Database = require("better-sqlite3");

const dbPath = path.join(__dirname, "voicesafe.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  title TEXT DEFAULT '',
  platform TEXT DEFAULT '',
  country TEXT DEFAULT '',
  language TEXT DEFAULT '',
  tags_text TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  meta_json TEXT NOT NULL,
  data_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cases_created_at ON cases(created_at);
CREATE INDEX IF NOT EXISTS idx_cases_tags_text ON cases(tags_text);
CREATE INDEX IF NOT EXISTS idx_cases_title ON cases(title);
`);

function nowISO() {
  return new Date().toISOString();
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map(t => (t || "").toString().trim()).filter(Boolean);
}

function tagsToText(tagsArr) {
  return normalizeTags(tagsArr).map(t => t.toLowerCase()).join(",");
}

function newId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

// CREATE
function createCase({ meta = {}, data = {} }) {
  const id = newId();
  const created_at = nowISO();
  const updated_at = created_at;

  const m = {
    title: meta.title || "",
    platform: meta.platform || "",
    country: meta.country || "",
    language: meta.language || "",
    tags: normalizeTags(meta.tags),
    notes: meta.notes || "",
  };

  const row = {
    id,
    created_at,
    updated_at,
    title: m.title,
    platform: m.platform,
    country: m.country,
    language: m.language,
    tags_text: tagsToText(m.tags),
    notes: m.notes,
    meta_json: JSON.stringify(m),
    data_json: JSON.stringify(data || {}),
  };

  const stmt = db.prepare(`
    INSERT INTO cases
    (id, created_at, updated_at, title, platform, country, language, tags_text, notes, meta_json, data_json)
    VALUES
    (@id, @created_at, @updated_at, @title, @platform, @country, @language, @tags_text, @notes, @meta_json, @data_json)
  `);

  stmt.run(row);
  return id;
}

// GET ONE
function getCase(id) {
  const row = db.prepare(`SELECT * FROM cases WHERE id = ?`).get(id);
  if (!row) return null;

  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    meta: JSON.parse(row.meta_json),
    data: JSON.parse(row.data_json),
  };
}

// LIST / SEARCH
function listCases({ q = "", tag = "" }) {
  q = (q || "").toString().trim().toLowerCase();
  tag = (tag || "").toString().trim().toLowerCase();

  let sql = `SELECT id, created_at, updated_at, meta_json, data_json FROM cases`;
  const where = [];
  const params = {};

  if (q) {
    where.push(`(
      lower(title) LIKE @q OR
      lower(platform) LIKE @q OR
      lower(country) LIKE @q OR
      lower(language) LIKE @q OR
      lower(notes) LIKE @q OR
      lower(tags_text) LIKE @q OR
      lower(id) LIKE @q
    )`);
    params.q = `%${q}%`;
  }

  if (tag) {
    // tags_text is like: "crypto,scam"
    where.push(`(',' || lower(tags_text) || ',') LIKE @tag`);
    params.tag = `%,${tag},%`;
  }

  if (where.length) sql += ` WHERE ` + where.join(" AND ");
  sql += ` ORDER BY created_at DESC LIMIT 200`;

  const rows = db.prepare(sql).all(params);

  const cases = rows.map(r => ({
    id: r.id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    meta: JSON.parse(r.meta_json),
    data: JSON.parse(r.data_json),
  }));

  return cases;
}

// UPDATE META
function updateCaseMeta(id, patchMeta = {}) {
  const existing = getCase(id);
  if (!existing) return null;

  const meta = existing.meta || {};
  const next = { ...meta, ...patchMeta };

  if (patchMeta.tags !== undefined) {
    next.tags = normalizeTags(patchMeta.tags);
  } else {
    next.tags = normalizeTags(next.tags);
  }

  const updated_at = nowISO();
  const tags_text = tagsToText(next.tags);

  db.prepare(`
    UPDATE cases SET
      updated_at = ?,
      title = ?,
      platform = ?,
      country = ?,
      language = ?,
      tags_text = ?,
      notes = ?,
      meta_json = ?
    WHERE id = ?
  `).run(
    updated_at,
    next.title || "",
    next.platform || "",
    next.country || "",
    next.language || "",
    tags_text,
    next.notes || "",
    JSON.stringify(next),
    id
  );

  return getCase(id);
}

// DELETE
function deleteCase(id) {
  const info = db.prepare(`DELETE FROM cases WHERE id = ?`).run(id);
  return info.changes > 0;
}

module.exports = {
  createCase,
  getCase,
  listCases,
  updateCaseMeta,
  deleteCase,
};