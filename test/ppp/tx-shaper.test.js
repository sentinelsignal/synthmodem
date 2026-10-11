'use strict';

// PppTxShaper (bounded pppd → modem queue), the modem backlog getters it
// relies on, and the slow-link pppd options.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const config = require('../../config');
config.logging.level = 'error';

const { PppTxShaper, frameProtocol } = require('../../src/ppp/PppTxShaper');
const { buildPppdArgs } = require('../../src/ppp/PppBridge');
const { QAMModulator, V22bis } = require('../../src/dsp/protocols/V22');
const { HandshakeEngine } = require('../../src/dsp/Handshake');

// ─── async-HDLC helpers ───────────────────────────────────────────────────

function fcs16(buf) {
  let f = 0xffff;
  for (const c of buf) { f ^= c; for (let k = 0; k < 8; k++) f = (f & 1) ? (f >>> 1) ^ 0x8408 : f >>> 1; }
  return f;
}
/** Frame a PPP packet (proto + payload) the way pppd does: 7E body 7E. */
function hdlc(proto, payload, { acfc = false } = {}) {
  const raw = Buffer.concat([
    acfc ? Buffer.alloc(0) : Buffer.from([0xff, 0x03]),
    proto < 0x100 ? Buffer.from([proto]) : Buffer.from([proto >> 8, proto & 0xff]),
    payload,
  ]);
  const f = (~fcs16(raw)) & 0xffff;
  const all = Buffer.concat([raw, Buffer.from([f & 0xff, f >> 8])]);
  const out = [0x7e];
  for (const b of all) { if (b < 0x20 || b === 0x7d || b === 0x7e) out.push(0x7d, b ^ 0x20); else out.push(b); }
  out.push(0x7e);
  return Buffer.from(out);
}
function deframe(stream) {
  const frames = []; let cur = null, esc = false;
  for (const b of stream) {
    if (b === 0x7e) { if (cur && cur.length) frames.push(Buffer.from(cur)); cur = []; esc = false; continue; }
    if (!cur) continue;
    if (esc) { cur.push(b ^ 0x20); esc = false; } else if (b === 0x7d) esc = true; else cur.push(b);
  }
  return frames;
}
const LCP  = () => hdlc(0xc021, Buffer.from([0x01, 0x01, 0x00, 0x04]));
const IPCP = () => hdlc(0x8021, Buffer.from([0x01, 0x01, 0x00, 0x04]));
const IP   = n => hdlc(0x0021, Buffer.alloc(n, 0x41));

// ─── frameProtocol ────────────────────────────────────────────────────────

test('frameProtocol: escaped LCP, IPCP, IP with and without address/protocol compression', () => {
  const body = f => f.subarray(1, f.length - 1);
  assert.equal(frameProtocol(body(LCP())), 0xc021);
  assert.equal(frameProtocol(body(IPCP())), 0x8021);
  assert.equal(frameProtocol(body(IP(20))), 0x0021);
  assert.equal(frameProtocol(body(hdlc(0x21, Buffer.alloc(20, 0x41), { acfc: true }))), 0x21);
  assert.equal(frameProtocol(Buffer.from([0x7d])), null);
});

// ─── shaping ──────────────────────────────────────────────────────────────

function shaperWith(backlogFn, limitBytes = 600) {
  const out = [];
  const s = new PppTxShaper({ write: b => out.push(b), backlog: backlogFn, limitBytes });
  return { s, out, bytes: () => Buffer.concat(out) };
}

test('shaper: with an empty modem queue everything passes byte-for-byte', () => {
  const { s, bytes } = shaperWith(() => 0);
  const stream = Buffer.concat([LCP(), IP(250), IPCP(), IP(40)]);
  s.push(stream);
  assert.deepEqual(bytes(), stream);
  assert.equal(s.stats.dropped, 0);
});

test('shaper: chunking does not matter (byte-at-a-time)', () => {
  const { s, bytes } = shaperWith(() => 0);
  const stream = Buffer.concat([LCP(), IP(250), IP(30)]);
  for (const b of stream) s.push(Buffer.from([b]));
  assert.deepEqual(bytes(), stream);
});

test('shaper: full queue drops large IP frames but never link control', () => {
  const { s, bytes } = shaperWith(() => 700);
  s.push(Buffer.concat([IP(250), LCP(), IPCP(), IP(250)]));
  const frames = deframe(bytes());
  assert.equal(s.stats.dropped, 2);
  assert.deepEqual(frames.map(f => f.readUInt16BE(2)), [0xc021, 0x8021]);
});

test('shaper: small IP frames (DNS answers, ACKs) get twice the limit', () => {
  const { s, bytes } = shaperWith(() => 900);       // > 600, < 1200
  s.push(Buffer.concat([IP(60), IP(250)]));
  const frames = deframe(bytes());
  assert.equal(frames.length, 1, 'small frame kept, large dropped');
  assert.equal(s.stats.dropped, 1);
  const { s: s2 } = shaperWith(() => 1300);         // beyond 2× limit
  s2.push(IP(60));
  assert.equal(s2.stats.dropped, 1);
});

test('shaper: output stays valid HDLC after drops (every surviving frame FCS-valid)', () => {
  let backlog = 0;
  const { s, bytes } = shaperWith(() => backlog);
  for (let k = 0; k < 20; k++) { backlog = k % 3 === 0 ? 0 : 800; s.push(IP(200 + k)); }
  const frames = deframe(bytes());
  assert.ok(frames.length > 0 && s.stats.dropped > 0);
  for (const f of frames) assert.equal(fcs16(f), 0xf0b8);
});

test('shaper: a flag-less run is flushed rather than buffered forever', () => {
  const { s, bytes } = shaperWith(() => 0);
  s.push(Buffer.alloc(5000, 0x41));
  assert.equal(bytes().length, 5000);
});

test('simulation: TCP-sized burst into a 1200 bps modem keeps the queue bounded', () => {
  // Modem drains ~110 B/s. pppd delivers a 300-byte IP frame every 50 ms
  // (a TCP sender far outrunning the link) plus an LCP echo every second.
  let backlog = 0, t = 0, maxBacklog = 0, lcpSent = 0;
  const written = [];
  const s = new PppTxShaper({
    write: b => { backlog += b.length; written.push(b); },
    backlog: () => backlog, limitBytes: 600, now: () => t,
  });
  for (let step = 0; step < 600; step++) {       // 30 s
    t = step * 50;
    backlog = Math.max(0, backlog - 110 * 0.05);
    s.push(IP(280));
    if (step % 20 === 0) { s.push(LCP()); lcpSent++; }
    maxBacklog = Math.max(maxBacklog, backlog);
  }
  assert.ok(maxBacklog < 600 + 2 * 320, `max backlog ${Math.round(maxBacklog)} B`);
  const out = deframe(Buffer.concat(written));
  assert.equal(out.filter(f => f.readUInt16BE(2) === 0xc021).length, lcpSent, 'every LCP frame delivered');
  for (const f of out) assert.equal(fcs16(f), 0xf0b8);
  assert.ok(s.stats.dropped > 0.8 * 600, `dropped ${s.stats.dropped}/600 IP frames`);
});

// ─── modem backlog reporting ──────────────────────────────────────────────

test('modulator: pendingBytes counts queued bytes and drains as audio is generated', () => {
  const m = new QAMModulator({ carrier: 2400, bitsPerSymbol: 2, guardTone: true });
  m.setMode('data');
  m.write(Buffer.alloc(100, 0x55));
  assert.equal(m.pendingBytes, 100);
  m.generate(8000 * 0.5);                 // 0.5 s ≈ 54 bytes at 11 bits/byte
  assert.ok(m.pendingBytes > 40 && m.pendingBytes < 52, `${m.pendingBytes}`);
  m.generate(8000);
  assert.equal(m.pendingBytes, 0);
});

test('V22bis and HandshakeEngine expose the backlog; 0 without a protocol', () => {
  const p = new V22bis('answer');
  p.modulator.setMode('data');
  p.write(Buffer.alloc(30));
  assert.equal(p.txBacklogBytes, 30);
  const hs = new HandshakeEngine('answer');
  assert.equal(hs.txBacklogBytes, 0);
  hs._protocol = p;
  assert.equal(hs.txBacklogBytes, 30);
});

// ─── pppd options ─────────────────────────────────────────────────────────

test('pppd args: mtu/mru and novj only when configured', () => {
  const base = { localIp: '192.168.51.1', remoteIp: '192.168.51.2', dns: [] };
  const tuned = buildPppdArgs({ ...base, mtu: 296, vj: false });
  assert.deepEqual(tuned.slice(tuned.indexOf('mtu'), tuned.indexOf('mtu') + 4), ['mtu', '296', 'mru', '296']);
  assert.ok(tuned.includes('novj'));
  const plain = buildPppdArgs(base);
  assert.ok(!plain.includes('mtu') && !plain.includes('novj'));
});
