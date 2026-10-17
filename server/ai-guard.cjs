'use strict';

// Best-effort warm-process protection only. See AI_SAFETY.md before relying on quotas.
const stateKey = Symbol.for('family-ai.guard.v1');
const state = globalThis[stateKey] || (globalThis[stateKey] = new Map());
class GuardError extends Error {
  constructor(status, code, message, retryAfter = 0) {
    super(message); this.status = status; this.code = code; this.retryAfter = retryAfter;
  }
}
function integerEnv(name, fallback, min = 1, max = 1000000) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new GuardError(503, 'INVALID_LIMIT_CONFIG', '服务配置需要家长检查，请稍后再试。');
  }
  return n;
}
function acquire(policy, now = Date.now()) {
  if (policy.paid !== false && process.env.AI_CALLS_ENABLED === 'false') {
    throw new GuardError(503, 'AI_PAUSED', '今天先休息一下，稍后再来玩吧。');
  }
  const prefix = policy.prefix || 'AI_GUARD';
  const minute = integerEnv(`${prefix}_PER_MINUTE`, policy.perMinute);
  const daily = integerEnv(`${prefix}_PER_DAY`, policy.perDay);
  const concurrent = integerEnv(`${prefix}_CONCURRENT`, policy.concurrent, 1, 100);
  const day = Math.floor(now / 86400000);
  let bucket = state.get(policy.scope);
  if (!bucket) { bucket = { day, used: 0, active: 0, times: [] }; state.set(policy.scope, bucket); }
  if (bucket.day !== day) { bucket.day = day; bucket.used = 0; }
  bucket.times = bucket.times.filter(t => t > now - 60000);
  if (bucket.used >= daily) throw new GuardError(429, 'DAILY_LIMIT', '今天已经玩了好多次，明天再来吧。', Math.ceil(((day + 1) * 86400000 - now) / 1000));
  if (bucket.times.length >= minute) throw new GuardError(429, 'RATE_LIMIT', '慢一点，等一小会儿再试。', Math.max(1, Math.ceil((bucket.times[0] + 60000 - now) / 1000)));
  if (bucket.active >= concurrent) throw new GuardError(429, 'BUSY', '正在准备中，等一小会儿再试。', 3);
  bucket.used++; bucket.times.push(now); bucket.active++;
  let released = false;
  return () => { if (!released) { bucket.active--; released = true; } };
}
async function readBytes(stream, limit, timeoutMs = 10000) {
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks = []; let size = 0;
  let timer; let timedOut = false;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new GuardError(408, 'READ_TIMEOUT', '读取时间有点长，请重试。')); reader.cancel().catch(() => {}); }, timeoutMs); });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (timedOut) throw new GuardError(408, 'READ_TIMEOUT', '读取时间有点长，请重试。');
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); throw new GuardError(413, 'TOO_LARGE', '内容有点大，请换一张小一点的图片或短一点的内容。'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
function objectBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GuardError(400, 'BAD_INPUT', '请重新试一次。');
  return value;
}
function parseBody(bytes) {
  try { return objectBody(JSON.parse(bytes.toString('utf8') || '{}')); }
  catch (e) { if (e instanceof GuardError) throw e; throw new GuardError(400, 'BAD_JSON', '请重新试一次。'); }
}
function textField(body, name, max, required = false) {
  const value = body[name];
  if (value === undefined || value === null) { if (required) throw new GuardError(400, 'BAD_INPUT', `Missing ${name}`); return; }
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new GuardError(400, 'BAD_INPUT', `Invalid ${name}`);
}
function imageField(body, name, required = false) {
  textField(body, name, 4 * 1024 * 1024, required);
  if (body[name] && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(body[name])) throw new GuardError(400, 'BAD_IMAGE', '请选择 PNG、JPEG 或 WebP 图片。');
}
function enumField(body, name, allowed) {
  if (body[name] !== undefined && !allowed.includes(body[name])) throw new GuardError(400, 'BAD_INPUT', `Invalid ${name}`);
}
function errorResult(error) {
  const e = error instanceof GuardError ? error : new GuardError(500, 'SERVER_ERROR', '暂时没准备好，请稍后再试。');
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (e.retryAfter) headers['Retry-After'] = String(e.retryAfter);
  return { status: e.status, headers, body: JSON.stringify({ ok: false, error: e.message, code: e.code }) };
}
async function withWebGuard(req, policy, handler) {
  let release;
  try {
    let body = {};
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Count bytes actually read, never trust Content-Length.
      const bytes = await readBytes(req.body, policy.maxBodyBytes);
      body = parseBody(bytes);
    } else if (req.url.length > 8192) throw new GuardError(413, 'TOO_LARGE', '内容太长了。');
    if (policy.validate) policy.validate(body, req);
    const effective = policy.select ? policy.select(body) : policy;
    release = acquire(effective);
    const safeRequest = req.method === 'GET' || req.method === 'HEAD' ? req : new Request(req.url, { method: req.method, headers: req.headers, body: JSON.stringify(body), signal: req.signal });
    return await handler(safeRequest);
  } catch (e) { const out = errorResult(e); return new Response(out.body, { status: out.status, headers: out.headers }); }
  finally { if (release) release(); }
}
async function withNodeGuard(req, res, policy, handler) {
  let release;
  try {
    let body = {};
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.body !== undefined) {
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
        if (raw.length > policy.maxBodyBytes) throw new GuardError(413, 'TOO_LARGE', '内容太大了，请稍后再试。');
        body = parseBody(raw);
      } else {
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          const buf = Buffer.from(chunk); size += buf.length;
          if (size > policy.maxBodyBytes) throw new GuardError(413, 'TOO_LARGE', '内容太大了，请稍后再试。');
          chunks.push(buf);
        }
        body = parseBody(Buffer.concat(chunks));
      }
      req.body = body;
    } else if (String(req.url || '').length > 8192) throw new GuardError(413, 'TOO_LARGE', '内容太长了。');
    if (policy.validate) policy.validate(body, req);
    release = acquire(policy.select ? policy.select(body) : policy);
    return await handler(req, res);
  } catch (e) {
    const out = errorResult(e); res.statusCode = out.status;
    for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
    res.end(out.body);
  } finally { if (release) release(); }
}
async function bufferedFetch(url, init = {}, options = {}) {
  const controller = new AbortController();
  const timeout = Math.min(options.timeoutMs || 55000, 120000);
  const timer = setTimeout(() => controller.abort(), timeout);
  const onAbort = () => controller.abort();
  if (init.signal) { if (init.signal.aborted) controller.abort(); else init.signal.addEventListener('abort', onAbort, { once: true }); }
  try {
    const response = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new GuardError(502, 'UPSTREAM_REDIRECT', '生成服务暂时不可用，请稍后再试。'); }
    const bytes = await readBytes(response.body, options.maxBytes || 32 * 1024 * 1024, timeout);
    return new Response(bytes.length ? bytes : null, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (e) { if (controller.signal.aborted) throw new GuardError(504, 'UPSTREAM_TIMEOUT', '准备时间有点长，请稍后再试。'); throw e; }
  finally { clearTimeout(timer); init.signal?.removeEventListener('abort', onAbort); }
}
module.exports = { GuardError, integerEnv, acquire, readBytes, textField, imageField, enumField, withWebGuard, withNodeGuard, bufferedFetch };
