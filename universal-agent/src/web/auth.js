// Single-owner password login with a signed, HttpOnly session cookie, plus an
// optional API token (Authorization: Bearer ...) for bots and other programs.
import crypto from "node:crypto";

const COOKIE = "ofis_session";
const SESSION_DAYS = 14;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function createAuth({ password, secret = crypto.randomBytes(32).toString("hex"), apiToken = "" }) {
  if (!password) throw new Error("APP_PASSWORD is required");
  if (apiToken && apiToken.length < 32) throw new Error("OFIS_API_TOKEN must be at least 32 characters");
  const failures = new Map(); // ip -> { count, until }

  const sign = (payload) => b64url(crypto.createHmac("sha256", secret).update(payload).digest());

  function issue() {
    const payload = b64url(JSON.stringify({ exp: Date.now() + SESSION_DAYS * 86_400_000 }));
    return `${payload}.${sign(payload)}`;
  }

  function verify(token) {
    if (!token) return false;
    const [payload, signature] = token.split(".");
    if (!payload || !signature || !safeEqual(signature, sign(payload))) return false;
    try {
      return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now();
    } catch {
      return false;
    }
  }

  function setCookie(req, res, value, maxAgeSeconds) {
    const secure = req.secure ? "; Secure" : "";
    res.setHeader(
      "Set-Cookie",
      `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`,
    );
  }

  function bearerOk(req) {
    const header = req.headers.authorization ?? "";
    if (!apiToken || !header.startsWith("Bearer ")) return false;
    return safeEqual(header.slice(7).trim(), apiToken);
  }

  const authenticated = (req) => verify(readCookie(req, COOKIE)) || bearerOk(req);

  return {
    isAuthenticated: authenticated,

    login(req, res) {
      const ip = req.ip ?? "unknown";
      const record = failures.get(ip);
      if (record && record.count >= MAX_FAILURES && record.until > Date.now()) {
        return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
      }
      if (typeof req.body?.password !== "string" || !safeEqual(req.body.password, password)) {
        const count = record && record.until > Date.now() ? record.count + 1 : 1;
        failures.set(ip, { count, until: Date.now() + LOCKOUT_MS });
        return res.status(401).json({ error: "That password is not correct." });
      }
      failures.delete(ip);
      setCookie(req, res, issue(), SESSION_DAYS * 86_400);
      res.json({ ok: true });
    },

    logout(req, res) {
      setCookie(req, res, "", 0);
      res.json({ ok: true });
    },

    require(req, res, next) {
      if (authenticated(req)) return next();
      res.status(401).json({ error: "Sign in to continue." });
    },
  };
}
