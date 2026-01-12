const crypto = require("crypto");

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signJwtHs256({ apiKey, expSeconds }) {
  apiKey = (apiKey || "").trim();
  if (apiKey.toLowerCase().startsWith("bearer ")) apiKey = apiKey.slice(7).trim();
  if (!apiKey || typeof apiKey !== "string" || !apiKey.includes(".")) {
    throw new Error("Invalid ZHIPU_API_KEY, expected '{id}.{secret}'.");
  }
  const dot = apiKey.indexOf(".");
  const id = apiKey.slice(0, dot);
  const secret = apiKey.slice(dot + 1);
  if (!id || !secret) throw new Error("Invalid ZHIPU_API_KEY, expected '{id}.{secret}'.");

  const header = { alg: "HS256", sign_type: "SIGN" };
  const now = Date.now();
  const payload = {
    api_key: id,
    exp: now + expSeconds * 1000,
    timestamp: now,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const toSign = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.createHmac("sha256", secret).update(toSign).digest("base64");
  const encodedSignature = signature.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  return { token: `${toSign}.${encodedSignature}`, payload };
}

module.exports = (req, res) => {
  try {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const rawApiKey = process.env.ZHIPU_API_KEY || "";
    const apiKey = rawApiKey.trim();
    const dotCount = (apiKey.match(/\./g) || []).length;
    const diag = {
      hasEnv: !!apiKey,
      totalLen: apiKey.length,
      dotCount,
      hasEllipsis: apiKey.includes("...") || apiKey.includes("…"),
      startsWithBearer: /^bearer\s+/i.test(apiKey),
    };

    if (!apiKey) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.end(
        JSON.stringify({
          error:
            "ZHIPU_API_KEY 为空：请在 Vercel 项目 Settings → Environment Variables 配置 ZHIPU_API_KEY 后 Redeploy（注意选择对应环境：Production/Preview）。",
          diag,
        })
      );
      return;
    }
    if (diag.hasEllipsis) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.end(
        JSON.stringify({
          error: "ZHIPU_API_KEY 看起来是掩码（包含 ...），请使用控制台“复制”按钮获取完整的 {id}.{secret}。",
          diag,
        })
      );
      return;
    }
    if (diag.dotCount !== 1) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.end(
        JSON.stringify({
          error: "ZHIPU_API_KEY 格式不正确：必须是 {id}.{secret}（且只包含一个点）。",
          diag,
        })
      );
      return;
    }
    const expSecondsRaw = Array.isArray(req.query?.expSeconds) ? req.query.expSeconds[0] : req.query?.expSeconds;
    const expSeconds = Math.min(3600, Math.max(60, Number(expSecondsRaw || 600) || 600));

    const { token, payload } = signJwtHs256({ apiKey, expSeconds });
    const base = "wss://open.bigmodel.cn/api/paas/v4/realtime";
    const encodedToken = encodeURIComponent(token);
    const wsUrls = [
      `${base}?token=${encodedToken}`,
      `${base}?access_token=${encodedToken}`,
      `${base}?Authorization=${encodedToken}`,
      `${base}?token=${encodeURIComponent(`Bearer ${token}`)}`,
      `${base}?access_token=${encodeURIComponent(`Bearer ${token}`)}`,
    ];

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.end(
      JSON.stringify({
        token,
        expiresAtMs: payload.exp,
        wsUrl: wsUrls[0],
        wsUrls,
      })
    );
  } catch (err) {
    const message = err?.message || String(err);
    res.statusCode = /ZHIPU_API_KEY|apikey/i.test(message) ? 400 : 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.end(JSON.stringify({ error: message }));
  }
};
