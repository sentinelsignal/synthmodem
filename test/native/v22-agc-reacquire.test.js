'use strict';

// V.22 receiver AGC re-acquisition
// =====================================================================
// The demodulator's AGC is one-shot (set during SYMBOL_ACQUISITION, then
// locked). A real Dreamcast call (capture 2026-10-11) opens with a ~100 ms
// burst ~19 dB below its steady level and then ramps up; locking on the
// burst left the AGC ~18 dB too hot and the receiver emitted 0x55 at line
// rate for the whole call. QAMDemodulator now restarts acquisition when the
// smoothed RX power rises >= 6 dB between AGC lock and the first
// NORMAL_OPERATION.
//
// The capture-replay test runs only when the recording is available:
// set SYNTHMODEM_DREAMCAST_CAPTURE to the _rx.wav path, or leave it in
// captures/ (default lookup by call ID). Otherwise it is skipped.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs   = require('node:fs');
const path = require('node:path');

const { QAMModulator, V22bis } = require('../../src/dsp/protocols/V22');
const { QAMDemodulator, RX_TRAINING } = require('../../src/dsp/protocols/V22Demodulator');

const SR = 8000;
const PAYLOAD = Buffer.from('The quick brown fox 0123456789 \x7e\xff\x7d\x23');

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Synthetic V.22 caller on the 1200 Hz carrier: 200 ms silence, a burst at
 * burstDb for burstMs, a linear-in-dB ramp to rampDb over rampMs, then
 * steady. Scrambled ones throughout, PAYLOAD written at payloadAt.
 * stepAt/stepDb optionally apply a level step later in the call.
 */
function caller({ burstDb = 0, burstMs = 0, rampMs = 1, rampDb = 0, level = 0.5,
                  payloadAt = 3.0, total = 6.0, stepAt = null, stepDb = 0 } = {}) {
  const mod = new QAMModulator({ carrier: 1200, bitsPerSymbol: 2, guardTone: false });
  mod.setMode('scr-ones');
  const out = new Float32Array(Math.round(total * SR));
  let wrote = false;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    if (!wrote && t >= payloadAt) { mod.setMode('data'); mod.write(PAYLOAD); wrote = true; }
    let db;
    if (t < 0.2) db = -Infinity;
    else if (t < 0.2 + burstMs / 1000) db = burstDb;
    else if (t < 0.2 + (burstMs + rampMs) / 1000) {
      const f = (t - 0.2 - burstMs / 1000) / (rampMs / 1000);
      db = burstDb + f * (rampDb - burstDb);
    } else db = rampDb;
    if (stepAt !== null && t >= stepAt) db += stepDb;
    out[i] = mod.generate(1)[0] * level * Math.pow(10, db / 20);
  }
  return out;
}

function demodulate(signal, opts = {}) {
  const d = new QAMDemodulator({ carrier: 1200, bitsPerSymbol: 2, ...opts });
  const bytes = [];
  const reacquires = [];
  d.on('data', b => bytes.push(...b));
  d.on('agc-reacquire', info => reacquires.push(info));
  for (let i = 0; i < signal.length; i += 160) d.process(signal.subarray(i, i + 160));
  return { d, bytes: Buffer.from(bytes), reacquires };
}

const containsPayload = buf => buf.includes(PAYLOAD);

// ─── Synthetic cases ──────────────────────────────────────────────────────

test('weak initial burst: without re-acquisition the receiver locks too hot and emits 0x55 garbage', () => {
  const sig = caller({ burstDb: -19, burstMs: 100, rampMs: 200 });
  const { bytes, reacquires } = demodulate(sig, { agcReacquireDb: 0 });
  assert.equal(reacquires.length, 0);
  assert.equal(containsPayload(bytes), false, 'payload should NOT survive with the fix disabled');
  assert.ok(bytes.length > 300, `expected a line-rate garbage stream, got ${bytes.length} bytes`);
});

for (const burstDb of [-25, -19, -12]) {
  test(`weak initial burst (${burstDb} dB): re-acquisition recovers the exact payload`, () => {
    const sig = caller({ burstDb, burstMs: 100, rampMs: 200 });
    const { d, bytes, reacquires } = demodulate(sig);
    assert.ok(reacquires.length >= 1, 'expected at least one AGC re-acquisition');
    assert.ok(reacquires.length <= 4, `re-acquisitions must be bounded, got ${reacquires.length}`);
    for (const r of reacquires) assert.ok(r.riseDb >= 6, `trigger rise ${r.riseDb} dB < 6 dB`);
    assert.equal(d.trainingStage, RX_TRAINING.NORMAL_OPERATION);
    assert.deepEqual(bytes, PAYLOAD, `decoded ${bytes.toString('hex')}`);
  });
}

for (const level of [0.02, 0.05, 0.15, 0.5, 1.0]) {
  test(`steady clean signal (level ${level}): no re-acquisition, output identical to fix disabled`, () => {
    const sig = caller({ level });
    const on  = demodulate(sig);
    const off = demodulate(sig, { agcReacquireDb: 0 });
    assert.equal(on.reacquires.length, 0, 'clean steady signal must not trigger re-acquisition');
    assert.deepEqual(on.bytes, off.bytes);
    assert.equal(on.d.trainingStage, off.d.trainingStage);
  });
}

test('trained modem: a +12 dB level step after NORMAL_OPERATION does not restart acquisition', () => {
  const sig = caller({ stepAt: 2.5, stepDb: 12, level: 0.1, payloadAt: 4.0 });
  const { d, reacquires } = demodulate(sig);
  assert.equal(reacquires.length, 0);
  assert.equal(d.trainingStage, RX_TRAINING.NORMAL_OPERATION);
});

test('continuous 40 dB ramp: re-acquisitions are capped', () => {
  const sig = caller({ burstDb: -40, burstMs: 0, rampMs: 1200, level: 0.5, payloadAt: 4.0 });
  const { reacquires } = demodulate(sig);
  assert.ok(reacquires.length <= 4, `got ${reacquires.length}`);
});

test('re-acquisition state resets on carrier loss', () => {
  const burst = caller({ burstDb: -19, burstMs: 100, rampMs: 200, total: 2.0, payloadAt: 9 });
  const gap = new Float32Array(SR);   // 1 s silence → carrier down
  const sig = new Float32Array(burst.length * 2 + gap.length);
  sig.set(burst, 0); sig.set(gap, burst.length); sig.set(burst, burst.length + gap.length);
  const { reacquires } = demodulate(sig);
  const first  = reacquires.filter(r => r.t < 2.0);
  const second = reacquires.filter(r => r.t > 3.0);
  assert.ok(first.length >= 1 && second.length >= 1, `per-epoch reacquires: ${first.length}, ${second.length}`);
  assert.equal(second[0].count, 1, 'counter restarts at 1 after carrier loss');
});

test('SYNTHMODEM_V22_AGC_REACQUIRE=0 disables the feature', () => {
  const prev = process.env.SYNTHMODEM_V22_AGC_REACQUIRE;
  process.env.SYNTHMODEM_V22_AGC_REACQUIRE = '0';
  try {
    const { reacquires } = demodulate(caller({ burstDb: -19, burstMs: 100, rampMs: 200 }));
    assert.equal(reacquires.length, 0);
  } finally {
    if (prev === undefined) delete process.env.SYNTHMODEM_V22_AGC_REACQUIRE;
    else process.env.SYNTHMODEM_V22_AGC_REACQUIRE = prev;
  }
});

// ─── Real Dreamcast capture replay ────────────────────────────────────────

const CAPTURE_CALL_ID = 'c63a3c6238e548de';

function findCapture() {
  if (process.env.SYNTHMODEM_DREAMCAST_CAPTURE) return process.env.SYNTHMODEM_DREAMCAST_CAPTURE;
  const dir = path.join(__dirname, '..', '..', 'captures');
  try {
    const f = fs.readdirSync(dir).find(n => n.includes(CAPTURE_CALL_ID) && n.endsWith('_rx.wav'));
    return f ? path.join(dir, f) : null;
  } catch (_) { return null; }
}

function readWav(file) {
  const b = fs.readFileSync(file);
  const n = b.readUInt32LE(40) / 2;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = b.readInt16LE(44 + 2 * i) / 32768;
  return x;
}

/** Replay as Handshake.js does: the V22bis probe starts at RX 5.000 s. */
function replay(rx, opts = {}) {
  const prev = process.env.SYNTHMODEM_V22_AGC_REACQUIRE;
  if (opts.disable) process.env.SYNTHMODEM_V22_AGC_REACQUIRE = '0';
  let p;
  try { p = new V22bis('answer'); }
  finally {
    if (prev === undefined) delete process.env.SYNTHMODEM_V22_AGC_REACQUIRE;
    else process.env.SYNTHMODEM_V22_AGC_REACQUIRE = prev;
  }
  const d = p.demodulator;
  let t = 0, normalAt = null, ready = null;
  const bytes = [], reacquires = [];
  d.on('data', b => { for (const v of b) bytes.push({ t, v }); });
  d.on('agc-reacquire', info => reacquires.push(info));
  p.on('ready', info => { ready = { ...info, t }; });
  for (let off = 5 * SR; off + 160 <= rx.length; off += 160) {
    t = off / SR;
    p.generateAudio(160);
    p.receiveAudio(rx.subarray(off, off + 160));
    if (normalAt === null && d.trainingStage === RX_TRAINING.NORMAL_OPERATION) normalAt = t;
  }
  return { bytes, reacquires, normalAt, ready };
}

/** RFC 1662 FCS-16. A frame including its FCS checks to 0xF0B8. */
function fcs16(buf) {
  let fcs = 0xffff;
  for (const b of buf) {
    fcs ^= b;
    for (let k = 0; k < 8; k++) fcs = (fcs & 1) ? (fcs >>> 1) ^ 0x8408 : fcs >>> 1;
  }
  return fcs;
}

/** Split an async-HDLC byte stream into unescaped frames. */
function hdlcFrames(stream) {
  const frames = [];
  let cur = null, esc = false;
  for (const b of stream) {
    if (b === 0x7e) { if (cur && cur.length) frames.push(Buffer.from(cur)); cur = []; esc = false; continue; }
    if (!cur) continue;
    if (esc) { cur.push(b ^ 0x20); esc = false; } else if (b === 0x7d) esc = true; else cur.push(b);
  }
  return frames;
}

const capture = findCapture();

test('Dreamcast capture replay: idle ones, V.42 ODP and PPP LCP Configure-Requests decode', { skip: capture ? false : 'capture not available' }, () => {
  const rx = readWav(capture);
  const { bytes, reacquires, normalAt, ready } = replay(rx);

  assert.ok(reacquires.length >= 1, 'expected AGC re-acquisition on the weak opening burst');
  assert.ok(ready && ready.bps === 1200 && ready.remoteDetected === true, `ready: ${JSON.stringify(ready)}`);
  assert.ok(normalAt !== null && normalAt < 9.5, `NORMAL_OPERATION at ${normalAt}`);

  // Idle marking (descrambled ones) produces no UART bytes until the
  // caller's first character just after RX 11.0 s.
  const idle = bytes.filter(b => b.t >= normalAt && b.t < 11.0);
  assert.equal(idle.length, 0, `idle period emitted ${idle.length} bytes`);

  // V.42 ODP: DC1 with even/odd parity, alternating.
  const odp = bytes.filter(b => b.t >= 11.5 && b.t < 20.5).map(b => b.v);
  let alt = 0;
  for (let i = 1; i < odp.length; i++) {
    if ((odp[i - 1] === 0x11 && odp[i] === 0x91) || (odp[i - 1] === 0x91 && odp[i] === 0x11)) alt++;
  }
  assert.ok(alt >= 500, `ODP alternations ${alt}`);

  // PPP: FCS-valid LCP Configure-Request frames (FF 03 C0 21 01 ...).
  const frames = hdlcFrames(bytes.filter(b => b.t >= 21).map(b => b.v));
  const lcpReq = frames.filter(f => f.length >= 8 && fcs16(f) === 0xf0b8
    && f[0] === 0xff && f[1] === 0x03 && f[2] === 0xc0 && f[3] === 0x21 && f[4] === 0x01);
  assert.ok(lcpReq.length >= 10, `FCS-valid LCP Configure-Requests: ${lcpReq.length}`);

  // No 0x55 garbage stream.
  let run = 0, maxRun = 0;
  for (const b of bytes) { run = b.v === 0x55 ? run + 1 : 0; if (run > maxRun) maxRun = run; }
  assert.ok(maxRun < 8, `longest 0x55 run ${maxRun}`);
});

test('Dreamcast capture replay with re-acquisition disabled reproduces the 0x55 failure', { skip: capture ? false : 'capture not available' }, () => {
  const { bytes, reacquires } = replay(readWav(capture), { disable: true });
  assert.equal(reacquires.length, 0);
  const n55 = bytes.filter(b => b.v === 0x55).length;
  assert.ok(n55 > 0.95 * bytes.length && bytes.length > 1000, `0x55 ${n55}/${bytes.length}`);
});
