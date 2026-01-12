/* eslint-disable no-console */
const WebSocket = require("ws");
const tokenHandler = require("../api/zhipu-token.js");
const fs = require("fs");
const path = require("path");

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

function callTokenHandler() {
  return new Promise((resolve, reject) => {
    const req = { method: "GET", query: { expSeconds: "600" } };
    const chunks = [];
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v;
      },
      end(body) {
        chunks.push(body || "");
        try {
          const text = chunks.join("");
          const json = JSON.parse(text);
          if (this.statusCode >= 400) reject(new Error(json.error || text));
          else resolve(json);
        } catch (e) {
          reject(e);
        }
      },
    };
    tokenHandler(req, res);
  });
}

async function connectOnce({ url, headers }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const t = setTimeout(() => {
      try {
        ws.terminate();
      } catch {}
      reject(new Error("timeout"));
    }, 6000);
    ws.on("open", () => {
      clearTimeout(t);
      resolve(ws);
    });
    ws.on("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
    ws.on("close", (code, reason) => {
      clearTimeout(t);
      reject(new Error(`closed code=${code} reason=${reason?.toString?.() || ""}`));
    });
  });
}

async function main() {
  const { token, wsUrl, wsUrls } = await callTokenHandler();
  const base = "wss://open.bigmodel.cn/api/paas/v4/realtime";
  const baseWithModel = `${base}?model=glm-realtime`;
  const apiKey = process.env.ZHIPU_API_KEY || "";

  const attempts = [
    { name: "header apikey (model)", url: baseWithModel, headers: { Authorization: apiKey } },
    { name: "header bearer apikey (model)", url: baseWithModel, headers: { Authorization: `Bearer ${apiKey}` } },
    { name: "header apikey", url: base, headers: { Authorization: apiKey } },
    { name: "header bearer apikey", url: base, headers: { Authorization: `Bearer ${apiKey}` } },
    { name: "header jwt", url: base, headers: { Authorization: token } },
    { name: "header bearer jwt", url: base, headers: { Authorization: `Bearer ${token}` } },
    { name: "header jwt (model)", url: baseWithModel, headers: { Authorization: token } },
    { name: "header bearer jwt (model)", url: baseWithModel, headers: { Authorization: `Bearer ${token}` } },
    { name: "query token", url: wsUrl, headers: {} },
    ...(wsUrls || []).map((u) => ({ name: "query alt", url: u, headers: {} })),
  ];

  for (const a of attempts) {
    try {
      console.log("try:", a.name, a.url);
      const ws = await connectOnce(a);
      console.log("OPEN:", a.name);
      ws.close();
      return;
    } catch (e) {
      console.log("FAIL:", a.name, e.message);
    }
  }

  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
