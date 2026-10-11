'use strict';

// PPP data path: LCP detection, pppd arguments, the pppd bridge, and the
// CallSession hand-off. A stand-in "pppd" shell script (records its
// arguments and echoes stdin → stdout) replaces /usr/sbin/pppd, so these
// tests need no root and create no network interfaces.
//
// The capture test runs only when the Dreamcast recording is available
// (SYNTHMODEM_DREAMCAST_CAPTURE or captures/ lookup by call ID).

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const config = require('../../config');
config.logging.level = 'error';
config.modem.backend = 'native';
config.modem.captureAudio = false;

const { PppDetector } = require('../../src/ppp/PppDetector');
const { PppBridge, buildPppdArgs } = require('../../src/ppp/PppBridge');
const { CallSession } = require('../../src/session/CallSession');

// LCP Configure-Request exactly as the Dreamcast sent it (escaped form).
const LCP = Buffer.from('7eff7d23c0217d217d228d7d207d347d227d267d207d207d207d207d277d227d287d227d257d267d207d202cefccc67e', 'hex');
const ODP = Buffer.from('1191'.repeat(40), 'hex');

// ─── Stand-in pppd ────────────────────────────────────────────────────────

function makeStubPppd() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthmodem-ppp-'));
  const argsFile = path.join(dir, 'args');
  const script = path.join(dir, 'pppd');
  fs.writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nexec cat\n`);
  fs.chmodSync(script, 0o755);
  return { dir, script, argsFile };
}

function pppCfg(stub, extra = {}) {
  return {
    dataPath: 'auto', pppdPath: stub.script,
    localIp: '192.168.51.1', remoteIp: '192.168.51.2', dns: ['192.168.51.1'],
    debug: false, logDir: null, extraOptions: [], ...extra,
  };
}

const waitFor = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise(r => setTimeout(r, 10));
  }
};

// ─── PppDetector ──────────────────────────────────────────────────────────

test('detector: finds an escaped LCP frame after V.42 ODP and returns it from the flag', () => {
  const d = new PppDetector();
  assert.equal(d.feed(ODP), null);
  const out = d.feed(Buffer.concat([Buffer.from([0x11, 0x91]), LCP]));
  assert.deepEqual(out, LCP);
  assert.equal(d.detected, true);
  assert.equal(d.feed(LCP), null, 'only reports once');
});

test('detector: matches the unescaped control-field form', () => {
  const d = new PppDetector();
  const f = Buffer.from([0x7e, 0xff, 0x03, 0xc0, 0x21, 0x01, 0x01]);
  assert.deepEqual(d.feed(f), f);
});

test('detector: pattern split across byte-at-a-time delivery', () => {
  const d = new PppDetector();
  let out = null;
  for (const b of Buffer.concat([ODP, LCP])) out = out || d.feed(Buffer.from([b]));
  assert.deepEqual(out, LCP.subarray(0, 6), 'returns the frame start once the pattern completes');
});

test('detector: ignores ODP, 0x55 garbage, telnet text and non-LCP PPP frames', () => {
  const d = new PppDetector();
  assert.equal(d.feed(ODP), null);
  assert.equal(d.feed(Buffer.alloc(2000, 0x55)), null);
  assert.equal(d.feed(Buffer.from('bbs.example.com:23\r\n')), null);
  assert.equal(d.feed(Buffer.from([0x7e, 0xff, 0x03, 0x80, 0x21])), null, 'IPCP is not a session start');
  assert.equal(d.detected, false);
});

// ─── pppd arguments ───────────────────────────────────────────────────────

test('pppd args: notty server with no auth, fixed addresses, DNS, no routing options', () => {
  const args = buildPppdArgs({
    localIp: '192.168.51.1', remoteIp: '192.168.51.2', dns: ['1.1.1.1', '8.8.8.8'],
    debug: true, extraOptions: ['mru', '576'],
  }, { logFile: '/tmp/x.log', tag: 'call-1' });
  for (const a of ['notty', 'nodetach', 'noauth', 'local', 'passive', '192.168.51.1:192.168.51.2', 'debug']) {
    assert.ok(args.includes(a), `missing ${a}`);
  }
  assert.deepEqual(args.slice(args.indexOf('ms-dns'), args.indexOf('ms-dns') + 4), ['ms-dns', '1.1.1.1', 'ms-dns', '8.8.8.8']);
  assert.equal(args[args.indexOf('logfile') + 1], '/tmp/x.log');
  assert.deepEqual(args.slice(-2), ['mru', '576']);
  for (const a of ['defaultroute', 'proxyarp']) assert.ok(!args.includes(a), `must not set ${a}`);
});

// ─── PppBridge ────────────────────────────────────────────────────────────

test('bridge: bytes flow both ways through pppd, stop() terminates it', async () => {
  const stub = makeStubPppd();
  const bridge = new PppBridge(pppCfg(stub), { tag: 'unit' });
  const out = [];
  let exited = false;
  bridge.on('data', b => out.push(b));
  bridge.on('exit', () => { exited = true; });
  bridge.start();
  bridge.write(LCP);
  await waitFor(() => Buffer.concat(out).length >= LCP.length);
  assert.deepEqual(Buffer.concat(out), LCP);
  assert.ok(fs.readFileSync(stub.argsFile, 'utf8').split('\n').includes('notty'));
  bridge.stop();
  await waitFor(() => exited);
  assert.equal(bridge.running, false);
});

test('bridge: missing pppd binary emits error instead of throwing', async () => {
  const bridge = new PppBridge(pppCfg({ script: '/nonexistent/pppd' }), { tag: 'missing' });
  let err = null;
  bridge.on('error', e => { err = e; });
  bridge.start();
  await waitFor(() => err !== null);
  assert.match(err.message, /ENOENT/);
});

// ─── CallSession hand-off ─────────────────────────────────────────────────

class StubSipServer extends EventEmitter {
  answerCall() {}
  sendBye() { this.byeSent = true; }
}
class StubDsp extends EventEmitter {
  constructor() { super(); this.written = []; }
  write(b) { this.written.push(Buffer.from(b)); }
  stop() {}
}

function makeSession(ppp) {
  config.ppp = ppp;
  const dialog = {
    callId: 'ppp-test', remoteRtpAddr: '127.0.0.1', remoteRtpPort: 40000,
    localRtpPort: null, session: null,
    negotiatedCodec: { name: 'PCMU', payloadType: 0 }, canBye: () => true,
  };
  const sess = new CallSession(new StubSipServer(), dialog, {});
  sess._active = true;
  sess._dsp = new StubDsp();
  return sess;
}

test('session: LCP during the post-train hold attaches the PPP bridge immediately', async () => {
  const stub = makeStubPppd();
  const sess = makeSession(pppCfg(stub));
  const dsp = sess._dsp;
  sess._onModemConnected();
  dsp.emit('data', ODP);
  assert.equal(sess._ppp, null, 'ODP alone must not start PPP');
  dsp.emit('data', Buffer.concat([Buffer.from([0x91]), LCP]));
  assert.ok(sess._ppp, 'bridge created on LCP');
  // stub pppd echoes: the LCP frame (from its flag) must come back out to the modem
  await waitFor(() => Buffer.concat(dsp.written).length >= LCP.length);
  assert.deepEqual(Buffer.concat(dsp.written), LCP);
  // later modem bytes reach pppd too
  dsp.emit('data', Buffer.from([0x7e, 0x01, 0x7e]));
  await waitFor(() => Buffer.concat(dsp.written).length >= LCP.length + 3);
  assert.equal(sess._telnet._txCallback ?? null, null, 'telnet menu not attached');
  const ended = new Promise(r => sess.once('ended', r));
  sess.hangup('test');
  await ended;
  await waitFor(() => !sess._ppp.running);
});

test('session: pppd exiting hangs up the call', async () => {
  const stub = makeStubPppd();
  const sess = makeSession(pppCfg(stub));
  sess._onModemConnected();
  sess._dsp.emit('data', LCP);
  const ended = new Promise(r => sess.once('ended', r));
  sess._ppp._proc.kill('SIGTERM');
  await ended;
  assert.equal(sess._active, false);
  assert.ok(sess._sip.byeSent, 'BYE sent');
});

test('session: nat.enabled false — IP link up never touches NatManager', async () => {
  const { natManager } = require('../../src/ppp/NatManager');
  const calls = [];
  const realRun = natManager._run;
  natManager._run = (cmd, args) => { calls.push(`${cmd} ${args.join(' ')}`); return { status: 0, out: '' }; };
  try {
    const stub = makeStubPppd();
    const sess = makeSession(pppCfg(stub, { nat: { enabled: false } }));
    sess._onModemConnected();
    sess._dsp.emit('data', LCP);
    sess._ppp.emit('ip-up', { iface: 'ppp0' });
    assert.equal(natManager.active, false);
    assert.deepEqual(calls, [], 'no sysctl/pfctl/route commands');
    const ended = new Promise(r => sess.once('ended', r));
    sess.hangup('test');
    await ended;
    await waitFor(() => !sess._ppp.running);
    assert.deepEqual(calls, []);
  } finally {
    natManager._run = realRun;
  }
});

test('session: nat.enabled true — acquired on IP link up, released when pppd exits', async () => {
  const { natManager } = require('../../src/ppp/NatManager');
  const calls = [];
  const realRun = natManager._run;
  natManager._run = (cmd, args, input) => {
    calls.push(`${cmd.split('/').pop()} ${args.join(' ')}${input ? ` <<< ${input.trim()}` : ''}`);
    if (args.join(' ') === '-n net.inet.ip.forwarding') return { status: 0, out: '0\n' };
    if (args.join(' ') === '-s nat') return { status: 0, out: 'nat-anchor "com.apple/*" all\n' };
    return { status: 0, out: '' };
  };
  const stub = makeStubPppd();
  const sess = makeSession(pppCfg(stub, { nat: { enabled: true, interface: 'en9' } }));
  try {
    sess._onModemConnected();
    sess._dsp.emit('data', LCP);
    sess._ppp.emit('ip-up', { iface: 'ppp0' });
    assert.equal(natManager.active, true);
    assert.ok(calls.some(c => c.includes('nat on en9 inet from 192.168.51.0/24 to any -> (en9)')), calls.join('\n'));
    const ended = new Promise(r => sess.once('ended', r));
    sess.hangup('test');
    await ended;
    await waitFor(() => !natManager.active);
    assert.ok(calls.includes('sysctl -w net.inet.ip.forwarding=0'), 'forwarding restored');
  } finally {
    if (sess._active) sess.hangup('test-cleanup');
    if (sess._ppp) sess._ppp.stop();
    natManager.releaseAll();
    natManager._run = realRun;
  }
});

test('session: dataPath telnet never starts PPP', async () => {
  const stub = makeStubPppd();
  const sess = makeSession(pppCfg(stub, { dataPath: 'telnet' }));
  sess._onModemConnected();
  sess._dsp.emit('data', LCP);
  assert.equal(sess._ppp, null);
  const ended = new Promise(r => sess.once('ended', r));
  sess.hangup('test');
  await ended;
});

test('session: no ppp config section keeps the original telnet behaviour', async () => {
  const sess = makeSession(undefined);
  sess._onModemConnected();
  sess._dsp.emit('data', LCP);
  assert.equal(sess._ppp, null);
  const ended = new Promise(r => sess.once('ended', r));
  sess.hangup('test');
  await ended;
});

// ─── Real Dreamcast capture ───────────────────────────────────────────────

function findCapture() {
  if (process.env.SYNTHMODEM_DREAMCAST_CAPTURE) return process.env.SYNTHMODEM_DREAMCAST_CAPTURE;
  const dir = path.join(__dirname, '..', '..', 'captures');
  try {
    const f = fs.readdirSync(dir).find(n => n.includes('c63a3c6238e548de') && n.endsWith('_rx.wav'));
    return f ? path.join(dir, f) : null;
  } catch (_) { return null; }
}
const capture = findCapture();

test('Dreamcast capture: detector fires on the first LCP Configure-Request, not on ODP', { skip: capture ? false : 'capture not available' }, () => {
  const { V22bis } = require('../../src/dsp/protocols/V22');
  const b = fs.readFileSync(capture);
  const n = b.readUInt32LE(40) / 2;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = b.readInt16LE(44 + 2 * i) / 32768;
  const p = new V22bis('answer');
  const d = new PppDetector();
  let t = 0, at = null, initial = null, before = 0;
  p.demodulator.on('data', buf => {
    if (at !== null) return;
    const r = d.feed(buf);
    if (r) { at = t; initial = r; } else before += buf.length;
  });
  for (let off = 5 * 8000; off + 160 <= n && at === null; off += 160) {
    t = off / 8000;
    p.generateAudio(160);
    p.receiveAudio(x.subarray(off, off + 160));
  }
  assert.ok(at !== null && at > 20 && at < 22, `detected at RX ${at}`);
  assert.ok(before > 500, `ODP bytes before detection: ${before}`);
  assert.deepEqual(initial.subarray(0, 6), Buffer.from([0x7e, 0xff, 0x7d, 0x23, 0xc0, 0x21]));
});
