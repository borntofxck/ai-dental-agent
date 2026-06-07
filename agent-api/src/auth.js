import crypto from "node:crypto";
import { config } from "./config.js";

const COOKIE_NAME = "dc_admin_session";

// Если пароль не задан, работаем с дефолтным "admin", но громко предупреждаем.
const DEFAULT_PASSWORD = "admin";
const effectivePassword = config.adminPassword || DEFAULT_PASSWORD;

if (!config.adminPassword) {
  console.warn(
    "[auth] ADMIN_PASSWORD не задан — используется небезопасный пароль по умолчанию \"admin\". " +
      "Установите ADMIN_PASSWORD в .env перед использованием в проде."
  );
}

// Секрет для подписи сессии. Если не задан явно, выводим из пароля,
// чтобы токены оставались валидными между перезапусками без отдельной настройки.
const sessionSecret =
  config.adminSessionSecret ||
  crypto.createHash("sha256").update(`dc-admin-session::${effectivePassword}`).digest("hex");

const sessionTtlMs = Math.max(1, config.adminSessionTtlHours) * 60 * 60 * 1000;

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Сравниваем хэши одинаковой длины, чтобы не утекала длина и не падал timingSafeEqual.
    const hashA = crypto.createHash("sha256").update(bufA).digest();
    const hashB = crypto.createHash("sha256").update(bufB).digest();
    return crypto.timingSafeEqual(hashA, hashB);
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function verifyCredentials(username, password) {
  const userOk = safeEqual(String(username || ""), config.adminUsername);
  const passOk = safeEqual(String(password || ""), effectivePassword);
  return userOk && passOk;
}

export function createSessionToken(username) {
  const payload = { u: username, exp: Date.now() + sessionTtlMs };
  const body = base64url(JSON.stringify(payload));
  const sig = base64url(crypto.createHmac("sha256", sessionSecret).update(body).digest());
  return `${body}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expectedSig = base64url(crypto.createHmac("sha256", sessionSecret).update(body).digest());
  if (!safeEqual(sig, expectedSig)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers?.cookie;
  if (!header) return {};
  return header.split(";").reduce((acc, part) => {
    const index = part.indexOf("=");
    if (index === -1) return acc;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function cookieAttributes(maxAgeSeconds) {
  const attrs = [
    `Path=/`,
    `HttpOnly`,
    `SameSite=Strict`,
    `Max-Age=${maxAgeSeconds}`
  ];
  if (config.adminCookieSecure) attrs.push("Secure");
  return attrs.join("; ");
}

export function setSessionCookie(res, token) {
  res.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieAttributes(Math.floor(sessionTtlMs / 1000))}`
  );
}

export function clearSessionCookie(res) {
  res.append("Set-Cookie", `${COOKIE_NAME}=; ${cookieAttributes(0)}`);
}

export function getSession(req) {
  const cookies = parseCookies(req);
  return verifySessionToken(cookies[COOKIE_NAME]);
}

// Middleware для JSON-эндпоинтов админки: при отсутствии сессии возвращает 401.
export function requireAdminApi(req, res, next) {
  if (getSession(req)) return next();
  res.status(401).json({ error: "unauthorized" });
}

// Middleware для страницы /admin: при отсутствии сессии редиректит на логин.
export function requireAdminPage(req, res, next) {
  if (getSession(req)) return next();
  res.redirect("/admin/login");
}

// Опциональная защита служебных вебхуков (n8n, напоминания).
// Включается ТОЛЬКО если задан AGENT_API_KEY, иначе пропускает запросы как раньше.
export function requireApiKey(req, res, next) {
  if (!config.agentApiKey) return next();
  const provided =
    req.headers["x-api-key"] ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (provided && safeEqual(provided, config.agentApiKey)) return next();
  res.status(401).json({ error: "unauthorized" });
}
