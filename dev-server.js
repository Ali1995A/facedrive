const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

function loadDotEnv(filePath = path.join(process.cwd(), ".env")) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

const handleZhipuToken = require("./api/zhipu-token.js");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function send(res, statusCode, body, headers = {}) {
  res.statusCode = statusCode;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(body);
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  const filePath = path.join(process.cwd(), pathname.replace(/^\/+/, ""));
  if (!filePath.startsWith(process.cwd())) return send(res, 403, "Forbidden");

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, "Not found");
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    res.statusCode = 200;
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", ext === ".html" ? "no-store" : "no-cache");
    fs.createReadStream(filePath).pipe(res);
  });
}

function requestHandler(req, res) {
  const startedAt = Date.now();
  const ua = req.headers["user-agent"] || "";
  const originalEnd = res.end;
  res.end = function patchedEnd(...args) {
    try {
      const ms = Date.now() - startedAt;
      const line = `[${new Date().toISOString()}] "${req.method} ${req.url}" "${ua}" ${res.statusCode} ${ms}ms`;
      // eslint-disable-next-line no-console
      console.log(line);
    } catch {}
    return originalEnd.apply(this, args);
  };

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/zhipu-token" || url.pathname === "/api/zhipu-token/") {
    req.query = Object.fromEntries(url.searchParams.entries());
    return handleZhipuToken(req, res);
  }
  return serveStatic(req, res);
}

const explicitPort = process.env.PORT ? Number(process.env.PORT) : null;
const basePort = explicitPort || 5173;
const maxTries = explicitPort ? 1 : 20;

function listenWithFallback(tryIndex = 0) {
  const port = basePort + tryIndex;
  const server = http.createServer(requestHandler);
  const onError = (err) => {
    if (!explicitPort && err && err.code === "EADDRINUSE" && tryIndex + 1 < maxTries) {
      // eslint-disable-next-line no-console
      console.log(`[dev-server] port ${port} in use, trying ${port + 1}...`);
      listenWithFallback(tryIndex + 1);
      return;
    }
    // eslint-disable-next-line no-console
    console.error("[dev-server] error:", err && err.code ? err.code : err);
    process.exitCode = 1;
  };

  server.on("error", onError);
  server.listen(port, "0.0.0.0", () => {
    // eslint-disable-next-line no-console
    console.log(`[dev-server] http://localhost:${port}  (serves /api/zhipu-token + static)`);
  });
}

listenWithFallback();
