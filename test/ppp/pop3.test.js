'use strict';

// Pop3Stub: empty mailbox, any login, passwords never logged.
// Binds 127.0.0.1 on an ephemeral port; no root needed.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const net = require('node:net');

const config = require('../../config');
config.logging.level = 'error';

const { Pop3Stub, respond, redact } = require('../../src/ppp/Pop3Stub');

function captureLogger() {
  const lines = [];
  const add = m => lines.push(m);
  return { lines, logger: { info: add, warn: add } };
}

/** Run a scripted POP3 dialogue; resolves with everything the server sent. */
function dialogue(port, commands, eol = '\r\n') {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let out = '';
    let sent = 0;
    s.on('data', d => {
      out += d.toString('latin1');
      // send the next command after each complete reply
      const replies = (out.match(/^[+-](OK|ERR)/gm) || []).length;
      if (replies > sent && sent < commands.length) s.write(commands[sent++] + eol);
    });
    s.on('end', () => resolve(out));
    s.on('close', () => resolve(out));
    s.on('error', reject);
  });
}

test('pop3: respond() covers the commands a mail check uses', () => {
  assert.equal(respond('USER bob').reply, '+OK');
  assert.match(respond('PASS hunter2').reply, /^\+OK.*0 messages/);
  assert.equal(respond('STAT').reply, '+OK 0 0');
  assert.equal(respond('LIST').reply, '+OK 0 messages\r\n.');
  assert.equal(respond('UIDL').reply, '+OK 0 messages\r\n.');
  assert.equal(respond('LIST 1').reply, '-ERR no such message');
  assert.equal(respond('RETR 1').reply, '-ERR no such message');
  assert.equal(respond('noop').reply, '+OK');
  assert.equal(respond('XYZZY').reply, '-ERR unknown command');
  assert.deepEqual(respond('QUIT'), { reply: '+OK bye', close: true });
});

test('pop3: passwords are redacted', () => {
  assert.equal(redact('PASS hunter2'), 'PASS ****');
  assert.equal(redact('pass  s3cr3t with spaces'), 'pass  ****');
  assert.equal(redact('APOP bob c4c9334bac560ecc979e58001b3e22fb'), 'APOP bob ****');
  assert.equal(redact('USER bob'), 'USER bob');
});

test('pop3: full mail-check session over TCP, password never logged', async () => {
  const { lines, logger } = captureLogger();
  const stub = new Pop3Stub({ bindIp: '127.0.0.1', port: 0, allowedClients: ['127.0.0.1'], logger });
  await stub.start();
  try {
    const out = await dialogue(stub.port, ['USER dreamcast', 'PASS hunter2', 'STAT', 'LIST', 'UIDL', 'QUIT']);
    assert.match(out, /^\+OK SynthModem POP3 ready\r\n/);
    assert.ok(out.includes('+OK 0 0\r\n'));
    assert.ok(out.includes('+OK 0 messages\r\n.\r\n'));
    assert.ok(out.trimEnd().endsWith('+OK bye'));
    assert.ok(lines.some(l => l.includes('PASS ****')), lines.join('\n'));
    assert.ok(!lines.some(l => l.includes('hunter2')), 'password leaked into log');
  } finally { stub.stop(); }
});

test('pop3: bare-LF line endings are accepted', async () => {
  const stub = new Pop3Stub({ bindIp: '127.0.0.1', port: 0, logger: captureLogger().logger });
  await stub.start();
  try {
    const out = await dialogue(stub.port, ['USER x', 'PASS y', 'STAT', 'QUIT'], '\n');
    assert.ok(out.includes('+OK 0 0'));
    assert.ok(out.trimEnd().endsWith('+OK bye'));
  } finally { stub.stop(); }
});

test('pop3: other clients are refused', async () => {
  const stub = new Pop3Stub({ bindIp: '127.0.0.1', port: 0, allowedClients: ['192.168.51.2'], logger: captureLogger().logger });
  await stub.start();
  try {
    const out = await dialogue(stub.port, ['USER x']);
    assert.equal(out, '');
  } finally { stub.stop(); }
});

test('pop3: stop() closes open sessions and frees the port', async () => {
  const stub = new Pop3Stub({ bindIp: '127.0.0.1', port: 0, logger: captureLogger().logger });
  await stub.start();
  const events = [];
  const s = net.connect(stub.port, '127.0.0.1');
  for (const e of ['connect', 'end', 'close']) s.on(e, () => events.push(e));
  s.on('error', () => {});
  s.resume();   // consume the greeting; a paused stream never emits 'end'/'close'
  const until = async cond => { const end = Date.now() + 2000; while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 10)); };
  await until(() => events.includes('connect') && stub._sockets.size === 1);
  assert.equal(stub._sockets.size, 1, 'session tracked');
  stub.stop();
  await until(() => events.includes('close'));
  assert.ok(events.includes('close'), `client events: ${events}`);
  assert.equal(stub.port, null);
});
