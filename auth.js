// auth.js
const jwt = require("jsonwebtoken");

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    // aby to nepustilo "slabý" secret
    throw new Error("JWT_SECRET is missing or too short. Set a strong JWT_SECRET env var.");
  }
  return secret;
}

// Middleware: optional auth (nepovinné)
function authOptional(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const payload = jwt.verify(token, getJwtSecret());
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch (e) {
    req.user = null;
    return next();
  }
}

// Middleware: required auth (keď budeš chcieť chrániť endpointy neskôr)
function authRequired(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ status: "error", message: "Missing Bearer token" });

  try {
    const payload = jwt.verify(token, getJwtSecret());
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch (e) {
    return res.status(401).json({ status: "error", message: "Invalid token" });
  }
}

module.exports = { authOptional, authRequired, getJwtSecret };