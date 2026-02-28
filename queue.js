// file: backend/queue.js
"use strict";

const { Queue } = require("bullmq");

function mustEnv(name, fallback = "") {
  const v = (process.env[name] || fallback || "").trim();
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

// Prefer REDIS_URL (Upstash/Render/any). Example: rediss://:pass@host:port
const REDIS_URL = mustEnv("REDIS_URL");

function connectionFromUrl(url) {
  // BullMQ/ioredis accepts { host, port, username, password, tls }
  const u = new URL(url);
  const isTls = u.protocol === "rediss:";

  const username = decodeURIComponent(u.username || "");
  const password = decodeURIComponent(u.password || "");
  const host = u.hostname;
  const port = Number(u.port || (isTls ? 6380 : 6379));

  const conn = {
    host,
    port,
    maxRetriesPerRequest: null, // recommended for BullMQ
    enableReadyCheck: false,
  };

  if (username) conn.username = username;
  if (password) conn.password = password;
  if (isTls) conn.tls = {}; // enable TLS

  return conn;
}

const connection = connectionFromUrl(REDIS_URL);

const analyzeQueue = new Queue("voicesafe:analyze", {
  connection,
  defaultJobOptions: {
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
    attempts: Number(process.env.JOB_ATTEMPTS || 2),
    backoff: {
      type: "exponential",
      delay: Number(process.env.JOB_BACKOFF_MS || 2500),
    },
  },
});

module.exports = {
  analyzeQueue,
  connection,
};