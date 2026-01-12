/* eslint-disable no-console */
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

async function main() {
  let apiKey = process.env.ZHIPU_API_KEY || "";
  apiKey = apiKey.trim();
  if (apiKey.toLowerCase().startsWith("bearer ")) apiKey = apiKey.slice(7).trim();
  if (!apiKey.trim()) {
    console.error("ZHIPU_API_KEY is empty");
    process.exitCode = 1;
    return;
  }
  if (apiKey.includes("...") || apiKey.includes("…")) {
    console.error("ZHIPU_API_KEY looks truncated (contains '...'); copy the full key via the copy button in console.");
    process.exitCode = 1;
    return;
  }
  if (!apiKey.includes(".")) {
    console.error("ZHIPU_API_KEY format invalid; expected '{id}.{secret}'.");
    process.exitCode = 1;
    return;
  }
  const dotCount = (apiKey.match(/\./g) || []).length;
  const dot = apiKey.indexOf(".");
  const id = apiKey.slice(0, dot);
  const secret = apiKey.slice(dot + 1);
  console.log("key_info", {
    totalLen: apiKey.length,
    dotCount,
    idLen: id.length,
    secretLen: secret.length,
  });
  if (dotCount !== 1 || id.length < 6 || secret.length < 16) {
    console.error("ZHIPU_API_KEY looks abnormal: ensure you copied the full '{id}.{secret}' (not the masked display).");
    process.exitCode = 1;
    return;
  }

  const res = await fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "glm-4-air-250414", messages: [{ role: "user", content: "ping" }], stream: false }),
  });

  const text = await res.text();
  console.log("status", res.status);
  console.log("body_head", text.slice(0, 200));

  if (res.status !== 200) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
