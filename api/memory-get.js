function safeKidId(kidId) {
  const s = String(kidId || "").trim();
  if (!s) return null;
  if (s.length > 80) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) return null;
  return s;
}

function sendJson(res, statusCode, obj) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });

    const baseUrl = String(process.env.MEMORY_API_URL || "")
      .trim()
      .replace(/\/+$/, "");
    const apiKey = String(process.env.MEMORY_API_KEY || "").trim();
    if (!baseUrl || !apiKey) {
      return sendJson(res, 200, {
        ok: false,
        kidId: null,
        memoryText: "",
        updatedAt: null,
        error: "Memory service not configured (MEMORY_API_URL/MEMORY_API_KEY).",
      });
    }

    const kidId = safeKidId(req.query?.kidId);
    if (!kidId) {
      return sendJson(res, 400, { error: "Invalid kidId" });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const upstream = await fetch(`${baseUrl}/v1/memory/${encodeURIComponent(kidId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    const text = await upstream.text();
    if (!upstream.ok) {
      return sendJson(res, 200, {
        ok: false,
        kidId,
        memoryText: "",
        updatedAt: null,
        error: `Upstream status ${upstream.status}`,
      });
    }

    let json = {};
    try {
      json = JSON.parse(text);
    } catch {}

    return sendJson(res, 200, {
      ok: true,
      kidId,
      memoryText: typeof json?.memoryText === "string" ? json.memoryText : "",
      updatedAt: typeof json?.updatedAt === "string" ? json.updatedAt : null,
    });
  } catch (err) {
    return sendJson(res, 200, {
      ok: false,
      kidId: null,
      memoryText: "",
      updatedAt: null,
      error: err?.name === "AbortError" ? "Timeout" : err?.message || String(err),
    });
  }
};

