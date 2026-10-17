'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const guard = require('../server/ai-guard.cjs');
const state = globalThis[Symbol.for('family-ai.guard.v1')];
const policy = { scope: 'test', perMinute: 2, perDay: 3, concurrent: 1, maxBodyBytes: 32 };
const originalFetch = global.fetch;
beforeEach(() => { state.clear(); for (const k of Object.keys(process.env)) if (k.startsWith('AI_GUARD_') || k === 'AI_CALLS_ENABLED') delete process.env[k]; global.fetch = () => { throw new Error('Unexpected network'); }; });
afterEach(() => { global.fetch = originalFetch; });
function request(body, headers = {}) { return new Request('https://family.test/api', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }); }
test('normal JSON is preserved and a completed request releases concurrency', async () => {
  for (let i = 0; i < 2; i++) { const r = await guard.withWebGuard(request({ text: '你好' }), policy, async r => Response.json(await r.json())); assert.equal(r.status, 200); assert.equal((await r.json()).text, '你好'); }
});
test('actual streamed bytes reject oversized JSON even with a misleading Content-Length', async () => {
  let calls = 0; const r = await guard.withWebGuard(request({ text: 'x'.repeat(100) }, { 'Content-Length': '1' }), policy, async () => { calls++; return new Response(); });
  assert.equal(r.status, 413); assert.equal(calls, 0);
});
test('chunked body without Content-Length is bounded', async () => {
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"x":"' + 'x'.repeat(60))); c.close(); } });
  const r = await guard.withWebGuard(new Request('https://family.test/api', { method: 'POST', body: stream, duplex: 'half' }), policy, async () => { throw new Error('must not reach handler'); });
  assert.equal(r.status, 413);
});
test('malformed and non-object JSON are rejected before handler', async () => {
  for (const value of ['{', 'null', '[]', '"hi"']) { const r = await guard.withWebGuard(request(value), policy, async () => { throw new Error('must not reach handler'); }); assert.equal(r.status, 400); }
});
test('rolling minute, UTC day and concurrency limits are independent and release is idempotent', () => {
  const release = guard.acquire(policy, 1000);
  assert.throws(() => guard.acquire(policy, 1000), e => e.code === 'BUSY'); release(); release();
  guard.acquire(policy, 1001)();
  assert.throws(() => guard.acquire(policy, 1002), e => e.code === 'RATE_LIMIT');
  guard.acquire(policy, 62000)();
  assert.throws(() => guard.acquire(policy, 123000), e => e.code === 'DAILY_LIMIT');
  guard.acquire(policy, 86400000)();
});
test('handler failures release concurrency and rate errors provide Retry-After', async () => {
  const r = await guard.withWebGuard(request({}), policy, async () => { throw new Error('test'); }); assert.equal(r.status, 500);
  assert.equal((await guard.withWebGuard(request({}), policy, async () => new Response())).status, 200);
  const limited = await guard.withWebGuard(request({}), policy, async () => new Response()); assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
});
test('operator pause affects paid calls but permits already-created result reads', () => {
  process.env.AI_CALLS_ENABLED = 'false';
  assert.throws(() => guard.acquire(policy), e => e.code === 'AI_PAUSED');
  guard.acquire({ ...policy, paid: false })();
});
test('invalid quota configuration fails explicitly instead of silently disabling protection', () => {
  process.env.AI_GUARD_PER_DAY = 'NaN'; assert.throws(() => guard.acquire(policy), e => e.code === 'INVALID_LIMIT_CONFIG');
});
test('Node pre-parsed and streamed bodies are both bounded', async () => {
  for (const req of [{ method: 'POST', body: { x: 'x'.repeat(50) } }, Object.assign(Readable.from(['{"x":"', 'x'.repeat(50), '"}']), { method: 'POST' })]) {
    const res = { setHeader() {}, end(body) { this.body = body; } };
    await guard.withNodeGuard(req, res, policy, () => { throw new Error('must not reach handler'); }); assert.equal(res.statusCode, 413);
  }
});
test('upstream redirects are not followed with credentials', async () => {
  let calls = 0; global.fetch = async (_url, init) => { calls++; assert.equal(init.redirect, 'manual'); return new Response(null, { status: 307, headers: { location: 'https://untrusted.example/' } }); };
  await assert.rejects(guard.bufferedFetch('https://provider.example', { headers: { Authorization: 'Bearer test-only' } }), e => e.code === 'UPSTREAM_REDIRECT'); assert.equal(calls, 1);
});
test('upstream bytes are bounded and timeout aborts the mock fetch', async () => {
  global.fetch = async () => new Response('x'.repeat(100));
  await assert.rejects(guard.bufferedFetch('https://provider.example', {}, { maxBytes: 10 }), e => e.status === 413);
  global.fetch = async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  await assert.rejects(guard.bufferedFetch('https://provider.example', {}, { timeoutMs: 5 }), e => e.status === 504);
});
test('stalled incoming streams time out', async () => {
  await assert.rejects(guard.readBytes(new ReadableStream(), 32, 5), e => e.status === 408);
});
