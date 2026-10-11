'use strict';

// NatManager (IP forwarding + pf NAT anchor) with a fake command runner —
// no real sysctl/pfctl/route calls are made.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const config = require('../../config');
config.logging.level = 'error';

const { NatManager, ANCHOR } = require('../../src/ppp/NatManager');

/** Fake runner: scripted outputs, records every command. */
function fakeRun({ forwarding = '0', pfE = 'pf enabled\nToken : 12345678\n', mainNat = 'nat-anchor "com.apple/*" all\n', fail = null } = {}) {
  const calls = [];
  const run = (cmd, args, input) => {
    const line = `${cmd.split('/').pop()} ${args.join(' ')}`;
    calls.push(input ? `${line} <<< ${input.trim()}` : line);
    if (fail && line.startsWith(fail)) return { status: 1, out: 'Operation not permitted' };
    if (line === 'route -n get default') return { status: 0, out: '   route to: default\n  interface: en1\n' };
    if (line === 'sysctl -n net.inet.ip.forwarding') return { status: 0, out: `${forwarding}\n` };
    if (line === 'pfctl -E') return { status: 0, out: pfE };
    if (line === 'pfctl -s nat') return { status: 0, out: mainNat };
    return { status: 0, out: '' };
  };
  return { run, calls };
}

test('acquire: enables forwarding, loads the anchor rule, enables pf with a token', () => {
  const f = fakeRun();
  const nat = new NatManager({ run: f.run });
  assert.equal(nat.acquire({ subnet: '192.168.51.0/24' }), true);
  assert.deepEqual(f.calls, [
    'route -n get default',
    'sysctl -n net.inet.ip.forwarding',
    'sysctl -w net.inet.ip.forwarding=1',
    `pfctl -a ${ANCHOR} -f - <<< nat on en1 inet from 192.168.51.0/24 to any -> (en1)`,
    'pfctl -E',
    'pfctl -s nat',
  ]);
  nat.releaseAll();
});

test('release: reverses in order — pf token, anchor flush, forwarding restore', () => {
  const f = fakeRun();
  const nat = new NatManager({ run: f.run });
  nat.acquire({ subnet: '192.168.51.0/24' });
  f.calls.length = 0;
  nat.release();
  assert.deepEqual(f.calls, [
    'pfctl -X 12345678',
    `pfctl -a ${ANCHOR} -F all`,
    'sysctl -w net.inet.ip.forwarding=0',
  ]);
  assert.equal(nat.active, false);
});

test('forwarding already on: left on, never switched off', () => {
  const f = fakeRun({ forwarding: '1' });
  const nat = new NatManager({ run: f.run });
  nat.acquire({ subnet: '192.168.51.0/24' });
  nat.release();
  assert.ok(!f.calls.some(c => c.startsWith('sysctl -w')), f.calls.join('\n'));
});

test('explicit interface skips default-route lookup', () => {
  const f = fakeRun();
  const nat = new NatManager({ run: f.run });
  nat.acquire({ subnet: '192.168.51.0/24', interface: 'en0' });
  assert.ok(!f.calls.includes('route -n get default'));
  assert.ok(f.calls.some(c => c.includes('nat on en0 inet from 192.168.51.0/24 to any -> (en0)')));
  nat.releaseAll();
});

test('reference counting: torn down only by the last release', () => {
  const f = fakeRun();
  const nat = new NatManager({ run: f.run });
  nat.acquire({ subnet: '192.168.51.0/24' });
  nat.acquire({ subnet: '192.168.51.0/24' });
  assert.equal(f.calls.filter(c => c === 'pfctl -E').length, 1);
  nat.release();
  assert.equal(nat.active, true);
  nat.release();
  assert.equal(nat.active, false);
  nat.release();   // extra release is harmless
});

test('failure (not root): reports false and rolls back what it changed', () => {
  const f = fakeRun({ fail: 'pfctl -a' });
  const nat = new NatManager({ run: f.run });
  assert.equal(nat.acquire({ subnet: '192.168.51.0/24' }), false);
  assert.equal(nat.active, false);
  // forwarding was switched on before the pf step failed → restored
  assert.equal(f.calls[f.calls.length - 1], 'sysctl -w net.inet.ip.forwarding=0');
  assert.ok(!f.calls.includes(`pfctl -a ${ANCHOR} -F all`), 'anchor was never loaded, nothing to flush');
  nat.release();   // the failed acquire still counted; release is safe
});

function captureLogger() {
  const warnings = [];
  return { warnings, logger: { warn: m => warnings.push(m), info: () => {} } };
}

test('missing com.apple nat-anchor in the active ruleset: still sets up, warns', () => {
  const f = fakeRun({ mainNat: 'nat-anchor "mullvad" all\n' });
  const { warnings, logger } = captureLogger();
  const nat = new NatManager({ run: f.run, logger });
  assert.equal(nat.acquire({ subnet: '192.168.51.0/24' }), true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /does not reference nat-anchor "com\.apple\/\*"/);
  nat.releaseAll();
});

test('com.apple nat-anchor present: no warning', () => {
  const f = fakeRun();
  const { warnings, logger } = captureLogger();
  const nat = new NatManager({ run: f.run, logger });
  nat.acquire({ subnet: '192.168.51.0/24' });
  assert.deepEqual(warnings, []);
  nat.releaseAll();
});

test('process exit handler tears everything down', () => {
  const f = fakeRun();
  const nat = new NatManager({ run: f.run });
  nat.acquire({ subnet: '192.168.51.0/24' });
  f.calls.length = 0;
  nat._exitHandler();
  assert.deepEqual(f.calls, ['pfctl -X 12345678', `pfctl -a ${ANCHOR} -F all`, 'sysctl -w net.inet.ip.forwarding=0']);
  process.removeListener('exit', nat._exitHandler);
});
