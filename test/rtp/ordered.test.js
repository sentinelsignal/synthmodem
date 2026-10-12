'use strict';

// RtpSession 'ordered' playout: in-order delivery with no fixed delay,
// short reorder window, loss skipping, and no latency accumulation.
// Drives _onPacket directly (no socket), like fixed-buffered.test.js.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const config = require('../../config');
config.logging.level = 'error';
const { RtpSession } = require('../../src/rtp/RtpSession');

function rtpPacket(seq) {
  const pkt = Buffer.alloc(12 + 160, 0x55);
  pkt[0] = 0x80; pkt[1] = 0x00;
  pkt.writeUInt16BE(seq & 0xffff, 2);
  pkt.writeUInt32BE((seq * 160) >>> 0, 4);
  pkt.writeUInt32BE(0xdeadbeef, 8);
  pkt.writeUInt16BE(seq & 0xffff, 12);          // tag the payload with its seq
  return pkt;
}

/** Session in test mode; records the seq of each delivered packet. */
function session(mode = 'ordered') {
  const s = new RtpSession({ playoutMode: mode });
  s._running = true;
  s.setRemote('127.0.0.1', 40000);
  const got = [];
  s._deliverAudio = payload => got.push(payload.readUInt16BE(0));
  const rinfo = { address: '127.0.0.1', port: 40000 };
  const send = (...seqs) => { for (const q of seqs) s._onPacket(rtpPacket(q), rinfo); };
  return { s, got, send };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function withRtpCfg(over, fn) {
  const prev = {};
  for (const k of Object.keys(over)) { prev[k] = config.rtp[k]; config.rtp[k] = over[k]; }
  return Promise.resolve(fn()).finally(() => { for (const k of Object.keys(over)) config.rtp[k] = prev[k]; });
}

test('constructor accepts ordered', () => {
  assert.doesNotThrow(() => new RtpSession({ playoutMode: 'ordered' }));
});

test('in-order packets are delivered immediately — no pre-buffer, nothing held', () => {
  const { s, got, send } = session();
  for (let q = 100; q < 110; q++) {
    send(q);
    assert.equal(got[got.length - 1], q, 'delivered on arrival');
    assert.equal(s.playoutStats.held, 0);
  }
  assert.deepEqual(got, [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
  s.close();
});

test('reordering within the window is put back in order', () => {
  const { s, got, send } = session();
  send(1, 3, 2, 4, 6, 5);
  assert.deepEqual(got, [1, 2, 3, 4, 5, 6]);
  assert.equal(s.playoutStats.lost, 0);
  s.close();
});

test('a lost packet is skipped after the reorder wait, then delivery continues', async () => {
  await withRtpCfg({ orderedReorderWaitMs: 30 }, async () => {
    const { s, got, send } = session();
    send(1, 2, 4, 5);
    assert.deepEqual(got, [1, 2], 'held behind the gap');
    await sleep(80);
    assert.deepEqual(got, [1, 2, 4, 5]);
    assert.equal(s.playoutStats.lost, 1);
    assert.equal(s.playoutStats.gaps, 1);
    send(3);                                  // the "lost" one finally shows up
    assert.deepEqual(got, [1, 2, 4, 5], 'too late — dropped');
    assert.equal(s.playoutStats.late, 1);
    s.close();
  });
});

test('duplicates are dropped, whether already played or still held', () => {
  const { s, got, send } = session();
  send(10, 11, 11, 10, 13, 13, 12);
  assert.deepEqual(got, [10, 11, 12, 13]);
  assert.equal(s.playoutStats.late, 3);
  s.close();
});

test('sequence numbers wrap at 65535', () => {
  const { s, got, send } = session();
  send(65534, 65535, 1, 0, 2);
  assert.deepEqual(got, [65534, 65535, 0, 1, 2]);
  s.close();
});

test('held packets are bounded: past orderedMaxHeld the gap is skipped at once', async () => {
  await withRtpCfg({ orderedMaxHeld: 5, orderedReorderWaitMs: 10000 }, () => {
    const { s, got, send } = session();
    send(1);
    send(3, 4, 5, 6, 7);                      // 5 held behind missing 2
    assert.deepEqual(got, [1]);
    send(8);                                  // 6 held > 5 → skip without waiting
    assert.deepEqual(got, [1, 3, 4, 5, 6, 7, 8]);
    assert.equal(s.playoutStats.held, 0);
    s.close();
  });
});

test('a large forward jump (stream restart) resyncs instead of waiting', () => {
  const { s, got, send } = session();
  send(1, 2, 5000, 5001);
  assert.deepEqual(got, [1, 2, 5000, 5001]);
  assert.equal(s.playoutStats.resyncs, 1);
  s.close();
});

test('close() cancels the gap timer: nothing is delivered afterwards', async () => {
  await withRtpCfg({ orderedReorderWaitMs: 20 }, async () => {
    const { s, got, send } = session();
    send(1, 3);
    s.close();
    await sleep(60);
    assert.deepEqual(got, [1]);
  });
});

test('no latency accumulation: a stalled timer cannot delay ordered, but does delay fixed-buffered', async () => {
  await withRtpCfg({ jitterBufferInitDepth: 3 }, () => {
    // 1000 packets arrive (20 s of audio). fixed-buffered gets only half
    // the ticks it needs (throttled timer); ordered needs no ticks at all.
    const fixed = session('fixed-buffered');
    const ord = session('ordered');
    for (let q = 0; q < 1000; q++) {
      fixed.send(q); ord.send(q);
      if (fixed.s._nextPlaySeq !== null && q % 2 === 0) fixed.s._playoutTick();
    }
    clearInterval(fixed.s._jitterTimer);
    const fixedBehind = 1000 - fixed.got.length;
    assert.equal(ord.got.length, 1000, 'ordered: everything delivered on arrival');
    assert.ok(fixedBehind > 400, `fixed-buffered fell ${fixedBehind} packets (${fixedBehind * 20} ms) behind`);
    fixed.s.close(); ord.s.close();
  });
});
