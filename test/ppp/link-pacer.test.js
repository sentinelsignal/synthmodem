'use strict';

// LinkPacer: paced, bounded delivery of WebGateway responses.
//
// Unit tests drive the pacer with a fake clock and a modem model: every
// written chunk adds its wire cost to a queue that drains at the negotiated
// line rate (bps / 11). Integration tests run real HTTP over loopback
// through WebGateway with the same model supplying the backlog.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const crypto = require('node:crypto');

const config = require('../../config');
config.logging.level = 'error';

const { LinkPacer, wireBytes } = require('../../src/ppp/LinkPacer');
const { WebGateway } = require('../../src/ppp/WebGateway');

// ─── Fakes ────────────────────────────────────────────────────────────────

class FakeRes extends EventEmitter {
  constructor(onWrite) {
    super();
    this.chunks = []; this.ended = false; this.destroyed = false;
    this.writableLength = 0; this._onWrite = onWrite || (() => {});
    this.socket = { setNoDelay: () => { this.noDelay = true; } };
  }
  // The first write also carries the HTTP status line + headers.
  write(c) { this._onWrite(c, this.chunks.length === 0); this.chunks.push(Buffer.from(c)); return true; }
  end(c) { if (c) this.write(c); this.ended = true; }
  destroy() { this.destroyed = true; this.emit('close'); }
  get body() { return Buffer.concat(this.chunks); }
}

/** Modem queue model + fake clock + manual timers. */
function rig({ bps = 1200, mtu = 296, queueCapBytes = 560, ...opts } = {}) {
  const m = { t: 0, backlog: 0, maxBacklog: 0, wireTotal: 0, timerOn: false };
  const rate = bps / 11;
  const pacer = new LinkPacer({
    backlog: () => m.backlog, bps: () => bps, mtu, queueCapBytes, now: () => m.t,
    timers: { setInterval: () => { m.timerOn = true; return 1; }, clearInterval: () => { m.timerOn = false; } },
    ...opts,
  });
  const onWrite = (c, first) => {
    const w = wireBytes(c.length) + (first ? 160 : 0);   // ~HTTP headers on the first segment(s)
    m.backlog += w; m.wireTotal += w;
    m.maxBacklog = Math.max(m.maxBacklog, m.backlog);
  };
  const run = (ms, until = () => false) => {
    for (let k = 0; k < ms / 50 && !until(); k++) {
      m.t += 50;
      m.backlog = Math.max(0, m.backlog - rate * 0.05);
      pacer.tick();
    }
  };
  return { m, pacer, rate, run, res: () => new FakeRes(onWrite) };
}

const body = n => crypto.randomBytes(n);

// ─── Integrity and pacing ─────────────────────────────────────────────────

test('wire cost: one MSS chunk at MTU 296 is ~295 bytes on the line', () => {
  assert.equal(wireBytes(244), 244 + 40 + 6 + Math.ceil(284 / 64));
});

test('integrity: every byte delivered once, in order, then end()', async () => {
  const r = rig({ bps: 2400 });
  const res = r.res(); const b = body(10000);
  const done = r.pacer.send(res, b);
  r.run(120000, () => res.ended);
  assert.deepEqual(await done, { ok: true, reason: 'complete' });
  assert.ok(res.body.equals(b));
  assert.ok(res.noDelay, 'Nagle disabled so single-segment chunks go out at once');
  assert.ok(res.chunks.every(c => c.length <= r.pacer.chunkBytes));
});

for (const bps of [1200, 2400]) {
  test(`pacing at ${bps} bps: completion ≈ wire bytes / line rate, queue stays ≤ ~1 s + 1 chunk`, async () => {
    const r = rig({ bps });
    const res = r.res(); const b = body(4000);
    const done = r.pacer.send(res, b);
    r.run(600000, () => res.ended);
    await done;
    const ideal = r.m.wireTotal / r.rate * 1000;                  // ms of pure airtime
    assert.ok(r.m.t >= ideal * 0.75 && r.m.t <= ideal * 1.35, `took ${r.m.t} ms, airtime ${Math.round(ideal)} ms`);
    const bound = r.rate * 1.0 + wireBytes(r.pacer.chunkBytes) + 160;
    assert.ok(r.m.maxBacklog <= bound, `max backlog ${Math.round(r.m.maxBacklog)} B > ${Math.round(bound)} B`);
    assert.ok(r.m.maxBacklog < 600, 'never reaches the PppTxShaper drop threshold');
  });
}

test('rate follows the negotiated speed: 2400 bps finishes ~2x faster than 1200', async () => {
  const time = async bps => { const r = rig({ bps }); const res = r.res(); const d = r.pacer.send(res, body(3000)); r.run(600000, () => res.ended); await d; return r.m.t; };
  const slow = await time(1200), fast = await time(2400);
  assert.ok(slow / fast > 1.7 && slow / fast < 2.3, `ratio ${slow / fast}`);
});

test('unknown speed falls back to 1200 bps', () => {
  const p = new LinkPacer({ backlog: () => 0, bps: () => undefined });
  assert.equal(Math.round(p.lineRate()), Math.round(1200 / 11));
});

test('token bound: line bytes written never exceed rate × time + two chunks', async () => {
  const r = rig({ bps: 1200 });
  r.m.backlog = 0;
  const res = new FakeRes(c => { r.m.wireTotal += wireBytes(c.length); });   // backlog ignored: model says empty
  const d = r.pacer.send(res, body(8000));
  let worst = 0;
  for (let k = 0; k < 4000 && !res.ended; k++) {
    r.m.t += 50; r.pacer.tick();
    worst = Math.max(worst, r.m.wireTotal - r.rate * r.m.t / 1000);
  }
  await d;
  assert.ok(worst <= 2 * (wireBytes(r.pacer.chunkBytes) + 160), `ahead of line by ${Math.round(worst)} B`);
});

test('backlog gate: nothing is written while the modem queue is over ~1 s', () => {
  const r = rig({ bps: 1200 });
  const res = r.res();
  r.pacer.send(res, body(2000));
  const first = res.chunks.length;
  r.m.backlog = 5000;
  for (let k = 0; k < 100; k++) { r.m.t += 50; r.pacer.tick(); }
  assert.equal(res.chunks.length, first);
});

test('busy socket (writableLength > 0) is skipped until it drains', () => {
  const r = rig({ bps: 2400 });
  const res = r.res();
  r.pacer.send(res, body(2000));
  res.writableLength = 500;
  const n = res.chunks.length;
  r.run(5000);
  assert.equal(res.chunks.length, n);
  res.writableLength = 0;
  r.run(5000);
  assert.ok(res.chunks.length > n);
});

test('two responses are interleaved and both complete intact', async () => {
  const r = rig({ bps: 2400 });
  const a = r.res(), b = r.res(); const ba = body(1500), bb = body(1500);
  const da = r.pacer.send(a, ba), db = r.pacer.send(b, bb);
  const order = [];
  const wa = a.write.bind(a), wb = b.write.bind(b);
  a.write = c => { order.push('a'); return wa(c); }; b.write = c => { order.push('b'); return wb(c); };
  r.run(120000, () => a.ended && b.ended);
  await Promise.all([da, db]);
  assert.ok(a.body.equals(ba) && b.body.equals(bb));
  assert.ok(order.slice(0, 4).includes('a') && order.slice(0, 4).includes('b'), `order ${order.join('')}`);
});

// ─── Segment size and queue cap ───────────────────────────────────────────

test('chunk fills a whole TCP segment: 256 B at MTU 296, 244 B if timestamps are in use', () => {
  assert.equal(new LinkPacer({ backlog: () => 0, bps: () => 2400 }).chunkBytes, 256);
  assert.equal(new LinkPacer({ backlog: () => 0, bps: () => 2400, tcpOptionsBytes: 12 }).chunkBytes, 244);
  assert.equal(new LinkPacer({ backlog: () => 0, bps: () => 2400, mtu: 576 }).chunkBytes, 536);
});

test('queue cap at 2400 bps: paced data never pushes the modem queue past the cap', async () => {
  const r = rig({ bps: 2400, queueCapBytes: 560 });
  const res = r.res(); const d = r.pacer.send(res, body(6000));
  r.run(600000, () => res.ended);
  await d;
  assert.ok(r.m.maxBacklog <= 560, `peak ${Math.round(r.m.maxBacklog)} B`);
});

test('without the cap the first chunk (headers + data) can overflow the 600 B shaper at 2400 bps', async () => {
  const r = rig({ bps: 2400, queueCapBytes: Infinity });
  r.m.backlog = 210;                                  // just under the 1 s gate
  const res = r.res(); const d = r.pacer.send(res, body(6000));
  r.run(600000, () => res.ended);
  await d;
  assert.ok(r.m.maxBacklog > 600, `peak ${Math.round(r.m.maxBacklog)} B — the cap is what prevents this`);
});

test('a cap smaller than one chunk cannot deadlock: writes proceed when the queue is empty', async () => {
  const r = rig({ bps: 2400, queueCapBytes: 100 });
  const res = r.res(); const d = r.pacer.send(res, body(2000));
  r.run(600000, () => res.ended);
  assert.deepEqual(await d, { ok: true, reason: 'complete' });
});

// ─── Measurement log ──────────────────────────────────────────────────────

function capture() {
  const lines = [];
  return { lines, logger: { info: m => lines.push(['info', m]), warn: m => lines.push(['warn', m]) } };
}

test('measurement: one line per completed response with bytes, time, rate, chunks and queue peak', async () => {
  const { lines, logger } = capture();
  const r = rig({ bps: 2400, logger });
  const res = r.res(); const d = r.pacer.send(res, body(4000));
  r.run(600000, () => res.ended);
  await d;
  assert.equal(lines.length, 1);
  const [level, msg] = lines[0];
  assert.equal(level, 'info');
  const m = msg.match(/^paced response complete: 4000\/4000 B written in ([\d.]+) s \((\d+) B\/s, (\d+)% of 2400 bps line\), (\d+) chunks, modem queue peak (\d+) B$/);
  assert.ok(m, msg);
  assert.equal(Number(m[4]), Math.ceil(4000 / 256));
  assert.ok(Number(m[5]) > 0 && Number(m[5]) <= Math.ceil(r.m.maxBacklog), `peak ${m[5]} vs model ${r.m.maxBacklog}`);
});

test('measurement: a single-chunk response logs no rate (it is not meaningful)', async () => {
  const { lines, logger } = capture();
  const r = rig({ bps: 2400, logger });
  const res = r.res(); const d = r.pacer.send(res, body(218));
  r.run(10000, () => res.ended);
  await d;
  assert.match(lines[0][1], /^paced response complete: 218\/218 B written in [\d.]+ s \(in one chunk\), 1 chunk, modem queue peak \d+ B$/);
  assert.ok(!lines[0][1].includes('%'));
});

test('measurement: client close is logged as info, stalls as a warning, both with progress', async () => {
  const { lines, logger } = capture();
  const r = rig({ bps: 1200, logger, stallMs: 5000 });
  const a = r.res(); const da = r.pacer.send(a, body(5000));
  r.run(3000);
  a.emit('close');
  await da;
  const b = r.res(); const db = r.pacer.send(b, body(5000));
  r.m.backlog = 99999;
  for (let k = 0; k < 200; k++) { r.m.t += 50; r.pacer.tick(); }
  await db;
  assert.equal(lines[0][0], 'info');
  assert.match(lines[0][1], /^paced response closed by client: \d+\/5000 B written/);
  assert.equal(lines[1][0], 'warn');
  assert.match(lines[1][1], /^paced response aborted \(stalled\): \d+\/5000 B written/);
});

// ─── Bounds and cleanup ───────────────────────────────────────────────────

test('client disconnect mid-transfer: stream dropped at once, buffer released, timer stopped', async () => {
  const r = rig({ bps: 1200 });
  const res = r.res();
  const d = r.pacer.send(res, body(10000));
  r.run(3000);
  assert.equal(r.pacer.active, 1);
  assert.ok(r.m.timerOn);
  res.emit('close');
  assert.deepEqual(await d, { ok: false, reason: 'client-closed' });
  assert.equal(r.pacer.active, 0);
  assert.equal(r.m.timerOn, false);
  const n = res.chunks.length;
  r.run(5000);
  assert.equal(res.chunks.length, n, 'nothing written after close');
});

test('stalled transfer (link never drains) is aborted after stallMs', async () => {
  const r = rig({ bps: 1200, stallMs: 10000 });
  const res = r.res();
  const d = r.pacer.send(res, body(5000));
  r.m.backlog = 99999;
  for (let k = 0; k < 400; k++) { r.m.t += 50; r.pacer.tick(); }
  assert.deepEqual(await d, { ok: false, reason: 'stalled' });
  assert.ok(res.destroyed);
  assert.equal(r.pacer.active, 0);
});

test('overlong transfer is aborted at maxDurationMs', async () => {
  const r = rig({ bps: 1200, maxDurationMs: 20000 });
  const res = r.res();
  const d = r.pacer.send(res, body(50000));
  r.run(30000);
  assert.deepEqual(await d, { ok: false, reason: 'too-long' });
});

test('stream limit: excess responses are refused, not queued', async () => {
  const r = rig({ bps: 1200, maxStreams: 2 });
  r.pacer.send(r.res(), body(5000)); r.pacer.send(r.res(), body(5000));
  const third = r.res();
  assert.deepEqual(await r.pacer.send(third, body(5000)), { ok: false, reason: 'too-many-streams' });
  assert.ok(third.destroyed);
  assert.equal(r.pacer.active, 2);
});

test('stop(): aborts all transfers, stops the timer, refuses new ones', async () => {
  const r = rig({ bps: 1200 });
  const a = r.res(), b = r.res();
  const da = r.pacer.send(a, body(5000)), db = r.pacer.send(b, body(5000));
  r.pacer.stop();
  assert.deepEqual(await da, { ok: false, reason: 'stopped' });
  assert.deepEqual(await db, { ok: false, reason: 'stopped' });
  assert.ok(a.destroyed && b.destroyed);
  assert.equal(r.m.timerOn, false);
  assert.equal((await r.pacer.send(r.res(), body(10))).reason, 'stopped');
});

// ─── Real HTTP through WebGateway ─────────────────────────────────────────

/** Loopback "modem": bytes reaching the client enter a queue drained at bps/11. */
function loopbackModem(bps) {
  const m = { backlog: 0, max: 0, rate: bps / 11 };
  m.timer = setInterval(() => { m.backlog = Math.max(0, m.backlog - m.rate * 0.02); }, 20);
  m.add = n => { m.backlog += n; m.max = Math.max(m.max, m.backlog); };
  m.stop = () => clearInterval(m.timer);
  return m;
}

async function gatewayWith(pacer, page) {
  const up = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page); });
  await new Promise(r => up.listen(0, '127.0.0.1', r));
  const gw = new WebGateway({ bindIp: '127.0.0.1', port: 0, allowedClients: ['127.0.0.1'],
    checkTarget: async () => {}, pacer, maxPageBytes: 65536 });
  await gw.start();
  return { gw, up, host: `127.0.0.1:${up.address().port}` };
}

function fetchVia(gw, host, onData) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: gw.port, path: '/', headers: { Host: host } }, res => {
      const c = []; res.on('data', d => { c.push(d); if (onData) onData(d, req, res); });
      res.on('end', () => resolve({ status: res.statusCode, len: Number(res.headers['content-length']), body: Buffer.concat(c) }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

test('gateway + pacer over real sockets: page intact, paced at the configured rate', async () => {
  const page = '<html><body>' + 'x'.repeat(3000) + '</body></html>';
  const bps = 24000;                                    // 10x a real modem, keeps the test short
  const modem = loopbackModem(bps);
  const pacer = new LinkPacer({ backlog: () => modem.backlog, bps: () => bps });
  const { gw, up, host } = await gatewayWith(pacer, page);
  try {
    const t0 = Date.now();
    const r = await fetchVia(gw, host, d => modem.add(wireBytes(d.length)));
    const ms = Date.now() - t0;
    assert.equal(r.status, 200);
    assert.equal(r.body.toString('latin1'), page);
    assert.equal(r.len, page.length);
    const airtime = (page.length * 1.2) / (bps / 11) * 1000;
    assert.ok(ms >= airtime * 0.6, `finished in ${ms} ms, airtime ≈ ${Math.round(airtime)} ms — not paced`);
    assert.ok(modem.max <= (bps / 11) * 1.0 + wireBytes(pacer.chunkBytes) + 400, `queue high-water ${Math.round(modem.max)} B`);
    assert.equal(pacer.active, 0);
  } finally { gw.stop(); up.close(); modem.stop(); }
});

test('gateway + pacer: client disconnect mid-page releases the stream', async () => {
  const page = 'y'.repeat(20000);
  const pacer = new LinkPacer({ backlog: () => 0, bps: () => 1200 });
  const { gw, up, host } = await gatewayWith(pacer, page);
  try {
    await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: gw.port, path: '/', headers: { Host: host } }, res => {
        res.once('data', () => { req.destroy(); setTimeout(resolve, 100); });
      });
      req.on('error', () => {});
      setTimeout(() => reject(new Error('no data')), 5000);
    });
    const end = Date.now() + 2000;
    while (pacer.active && Date.now() < end) await new Promise(r => setTimeout(r, 20));
    assert.equal(pacer.active, 0);
    assert.equal(pacer.stats.aborted, 1);
  } finally { gw.stop(); up.close(); }
});

test('gateway.stop() during a paced transfer aborts it', async () => {
  const page = 'z'.repeat(20000);
  const pacer = new LinkPacer({ backlog: () => 0, bps: () => 1200 });
  const { gw, up, host } = await gatewayWith(pacer, page);
  try {
    const got = fetchVia(gw, host).catch(e => ({ error: e.message }));
    const end = Date.now() + 3000;
    while (!pacer.active && Date.now() < end) await new Promise(r => setTimeout(r, 10));
    assert.equal(pacer.active, 1);
    gw.stop();
    const r = await got;
    assert.ok(r.error || r.body.length < page.length, 'transfer cut short');
    const end2 = Date.now() + 2000;
    while (pacer.active && Date.now() < end2) await new Promise(r2 => setTimeout(r2, 20));
    assert.equal(pacer.active, 0);
  } finally { up.close(); }
});

test('without a pacer the gateway behaves as before (whole body at once)', async () => {
  const page = 'p'.repeat(5000);
  const { gw, up, host } = await gatewayWith(null, page);
  try {
    const r = await fetchVia(gw, host);
    assert.equal(r.body.toString(), page);
  } finally { gw.stop(); up.close(); }
});
