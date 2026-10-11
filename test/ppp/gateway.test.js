'use strict';

// DnsResponder + WebGateway. Everything binds 127.0.0.1 on ephemeral
// ports; a local HTTP server stands in for "the internet". No root, no
// outside network access.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const dgram = require('node:dgram');
const http  = require('node:http');
const net   = require('node:net');
const fs    = require('node:fs');
const os    = require('node:os');
const path  = require('node:path');

const config = require('../../config');
config.logging.level = 'error';
config.modem.backend = 'native';
config.modem.captureAudio = false;

const { DnsResponder, buildResponse, matchOverride } = require('../../src/ppp/DnsResponder');
const { WebGateway, isPrivateAddress, simplifyHtml, toLatin1, capPage } = require('../../src/ppp/WebGateway');

// ─── DNS helpers ──────────────────────────────────────────────────────────

function query(name, { id = 0x1234, type = 1, rd = true } = {}) {
  const labels = name.split('.').map(l => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
  const h = Buffer.alloc(12);
  h.writeUInt16BE(id, 0);
  h.writeUInt16BE(rd ? 0x0100 : 0, 2);
  h.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([h, ...labels, Buffer.from([0]), tail]);
}

function parseAnswer(resp) {
  const flags = resp.readUInt16BE(2), an = resp.readUInt16BE(6);
  let ip = null;
  if (an) { const o = resp.length - 4; ip = [...resp.subarray(o)].join('.'); }
  return { id: resp.readUInt16BE(0), qr: !!(flags & 0x8000), aa: !!(flags & 0x0400),
           rd: !!(flags & 0x0100), ra: !!(flags & 0x0080), rcode: flags & 0xf, an, ip };
}

// ─── DnsResponder ─────────────────────────────────────────────────────────

test('dns: A query for any name answers the gateway address, echoing id and RD', () => {
  const r = buildResponse(query('www.sega.com', { id: 0 }), { answerIp: '192.168.51.1' });
  const a = parseAnswer(r.response);
  assert.deepEqual(a, { id: 0, qr: true, aa: true, rd: true, ra: true, rcode: 0, an: 1, ip: '192.168.51.1' });
  assert.equal(r.query.name, 'www.sega.com');
});

test('dns: names are case-insensitive; overrides match exact and wildcard', () => {
  const overrides = { 'game.example.com': '203.0.113.5', '*.dcnet.test': '198.51.100.7' };
  const ans = n => parseAnswer(buildResponse(query(n), { answerIp: '192.168.51.1', overrides }).response).ip;
  assert.equal(ans('GAME.Example.com'), '203.0.113.5');
  assert.equal(ans('a.b.dcnet.test'), '198.51.100.7');
  assert.equal(ans('dcnet.test'), '198.51.100.7', 'wildcard also covers the bare parent');
  assert.equal(ans('other.example.com'), '192.168.51.1');
  assert.equal(matchOverride('x.y', {}), null);
});

test('dns: non-A queries get NOERROR with no answer', () => {
  const a = parseAnswer(buildResponse(query('www.sega.com', { type: 28 }), { answerIp: '192.168.51.1' }).response);
  assert.equal(a.rcode, 0);
  assert.equal(a.an, 0);
});

test('dns: malformed packets and responses are ignored', () => {
  const opts = { answerIp: '192.168.51.1' };
  assert.equal(buildResponse(Buffer.alloc(5), opts), null);
  const truncated = query('www.sega.com').subarray(0, 20);
  assert.equal(buildResponse(truncated, opts), null);
  const resp = Buffer.from(query('x.com')); resp.writeUInt16BE(0x8180, 2);
  assert.equal(buildResponse(resp, opts), null);
});

test('dns: live UDP round trip', async () => {
  const dnsr = new DnsResponder({ bindIp: '127.0.0.1', port: 0, answerIp: '192.168.51.1' });
  await dnsr.start();
  const seen = [];
  dnsr.on('query', q => seen.push(q));
  const sock = dgram.createSocket('udp4');
  const resp = await new Promise((resolve, reject) => {
    sock.once('message', resolve);
    sock.send(query('vserver.planetweb.com', { id: 0x4242 }), dnsr.port, '127.0.0.1', e => e && reject(e));
  });
  sock.close();
  dnsr.stop();
  const a = parseAnswer(resp);
  assert.equal(a.id, 0x4242);
  assert.equal(a.ip, '192.168.51.1');
  assert.equal(seen[0].name, 'vserver.planetweb.com');
});

// ─── Gateway pure functions ───────────────────────────────────────────────

test('gateway: private/loopback/link-local addresses are refused, public allowed', () => {
  for (const ip of ['10.1.2.3', '172.16.2.1', '172.31.255.255', '192.168.50.1', '127.0.0.1',
                    '169.254.81.57', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1',
                    '::ffff:192.168.1.1', 'not-an-ip']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '93.184.216.34', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('gateway: simplifyHtml strips scripts/styles/embeds/comments and rewrites https links', () => {
  const html = `<html><head><style>body{color:red}</style><script src="a.js"></script>
<link rel="stylesheet" href="x.css"><script>alert(1)</script></head>
<body><!-- c --><p style="color:blue" data-x="1">Hello <a href="https://example.com/a">link</a></p>
<iframe src="https://ads"></iframe><noscript><p>No JS</p></noscript><img src="https://e.com/i.gif" srcset="a 2x"></body></html>`;
  const out = simplifyHtml(html);
  for (const bad of ['<style', '<script', 'alert(1)', '<link', '<iframe', '<!--', 'style=', 'data-x', 'srcset', 'https://', '<noscript']) {
    assert.ok(!out.includes(bad), `still contains ${bad}: ${out}`);
  }
  for (const good of ['Hello', 'href="http://example.com/a"', 'No JS', 'src="http://e.com/i.gif"']) {
    assert.ok(out.includes(good), `lost ${good}: ${out}`);
  }
});

test('gateway: an unterminated script (raw read cut mid-element) is dropped, page kept', () => {
  const out = simplifyHtml('<html><body><p>Headline one</p><script>var x = "' + 'a'.repeat(5000));
  assert.ok(out.includes('Headline one'));
  assert.ok(!out.includes('var x') && !out.includes('<script'));
});

test('gateway: capPage hard-cuts when the last tag boundary is far back', () => {
  const page = Buffer.from('<p>start</p>' + 'z'.repeat(20000), 'latin1');
  const out = capPage(page, 4096);
  assert.ok(out.length > 3000 && out.length <= 4096, `length ${out.length}`);
  assert.ok(out.toString('latin1').includes('page truncated'));
});

test('gateway: toLatin1 transliterates punctuation and replaces the rest', () => {
  assert.equal(toLatin1('“Café” – it’s… ✓').toString('latin1'), '"Café" - it\'s... ?');
});

test('gateway: capPage truncates at a tag boundary with a notice', () => {
  const page = Buffer.from('<html><body>' + '<p>xxxxxxxxxx</p>'.repeat(500) + '</body></html>', 'latin1');
  const out = capPage(page, 1000).toString('latin1');
  assert.ok(out.length <= 1000);
  assert.ok(out.includes('page truncated'));
  assert.equal(capPage(Buffer.from('small'), 1000).toString(), 'small');
});

// ─── Gateway server ───────────────────────────────────────────────────────

const PAGE = `<html><head><meta charset="utf-8"><script>evil()</script><title>T</title></head>
<body><p style="x">Café “quotes” <a href="https://example.com/next">next</a></p></body></html>`;

async function startUpstream() {
  const srv = http.createServer((req, res) => {
    if (req.url === '/page') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
    if (req.url === '/big') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html><body>' + '<p>yyyyyyyyyy</p>'.repeat(5000) + '</body></html>'); }
    if (req.url === '/img') { res.writeHead(200, { 'Content-Type': 'image/gif' }); return res.end(Buffer.alloc(100, 7)); }
    if (req.url === '/bigimg') { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(Buffer.alloc(20000, 7)); }
    if (req.url === '/webp') { res.writeHead(200, { 'Content-Type': 'image/webp' }); return res.end(Buffer.alloc(10)); }
    if (req.url === '/redir-private') { res.writeHead(302, { Location: 'http://10.0.0.1/' }); return res.end(); }
    if (req.url === '/redir-ok') { res.writeHead(301, { Location: '/page' }); return res.end(); }
    if (req.url === '/form' && req.method === 'POST') {
      let b = ''; req.on('data', c => { b += c; });
      return req.on('end', () => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<p>got ${b}</p>`); });
    }
    res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<p>nope</p>');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return srv;
}

// allow loopback (the test upstream) but keep refusing 10/8 like the real policy
const testCheck = async host => {
  if (host !== '127.0.0.1' && isPrivateAddress(host)) throw Object.assign(new Error(`${host} is private`), { blocked: true });
};

async function startGateway(extra = {}) {
  const gw = new WebGateway({
    bindIp: '127.0.0.1', port: 0, allowedClients: ['127.0.0.1'],
    localHosts: ['www.sega.com', 'vserver.planetweb.com'], checkTarget: testCheck,
    maxPageBytes: 4096, maxImageBytes: 8192, ...extra,
  });
  await gw.start();
  return gw;
}

function get(gw, { host, pathName = '/', method = 'GET', body, absolute } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: gw.port, method, path: absolute || pathName,
      headers: { ...(host ? { Host: host } : {}), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('gateway: Host-header request is fetched, simplified and re-encoded as Latin-1', async () => {
  const up = await startUpstream(); const gw = await startGateway();
  try {
    const r = await get(gw, { host: `127.0.0.1:${up.address().port}`, pathName: '/page' });
    assert.equal(r.status, 200);
    assert.match(r.type, /text\/html; charset=ISO-8859-1/);
    const text = r.body.toString('latin1');
    assert.ok(text.includes('Café "quotes"'), text);
    assert.ok(text.includes('href="http://example.com/next"'));
    assert.ok(!text.includes('evil()') && !text.includes('style=') && !text.includes('charset="utf-8"'));
  } finally { gw.stop(); up.close(); }
});

test('gateway: absolute-URI (proxy-style) request works too', async () => {
  const up = await startUpstream(); const gw = await startGateway();
  try {
    const r = await get(gw, { absolute: `http://127.0.0.1:${up.address().port}/page` });
    assert.equal(r.status, 200);
    assert.ok(r.body.toString('latin1').includes('Café'));
  } finally { gw.stop(); up.close(); }
});

test('gateway: local hosts and the gateway address get the start page without fetching', async () => {
  let fetched = 0;
  const gw = await startGateway({ fetchImpl: () => { fetched++; throw new Error('should not fetch'); } });
  try {
    for (const host of ['www.sega.com', 'vserver.planetweb.com', '127.0.0.1']) {
      const r = await get(gw, { host, pathName: '/whatever.cgi?x=1' });
      assert.equal(r.status, 200);
      assert.ok(r.body.toString('latin1').includes('SynthModem gateway'), host);
    }
    assert.equal(fetched, 0);
    assert.ok((await get(gw, { host: 'www.sega.com' })).body.length < 2048, 'start page stays small');
  } finally { gw.stop(); }
});

test('gateway: other clients are refused', async () => {
  const gw = await startGateway({ allowedClients: ['192.168.51.2'] });
  try {
    assert.equal((await get(gw, { host: 'www.sega.com' })).status, 403);
  } finally { gw.stop(); }
});

test('gateway: private targets are blocked by the default policy, also via redirect', async () => {
  const up = await startUpstream();
  const strict = await startGateway({ checkTarget: undefined });
  const gw = await startGateway();
  try {
    const r1 = await get(strict, { host: '192.168.50.1', pathName: '/' });
    assert.equal(r1.status, 403);
    assert.ok(r1.body.toString().includes('Blocked'));
    const r2 = await get(gw, { host: `127.0.0.1:${up.address().port}`, pathName: '/redir-private' });
    assert.equal(r2.status, 403, 'redirect to 10.0.0.1 must be refused');
    const r3 = await get(gw, { host: `127.0.0.1:${up.address().port}`, pathName: '/redir-ok' });
    assert.equal(r3.status, 200, 'same-site redirect is followed');
    assert.ok(r3.body.toString('latin1').includes('Café'));
  } finally { strict.stop(); gw.stop(); up.close(); }
});

test('gateway: big pages are truncated; images capped; unsupported types skipped', async () => {
  const up = await startUpstream(); const gw = await startGateway();
  const host = `127.0.0.1:${up.address().port}`;
  try {
    const big = await get(gw, { host, pathName: '/big' });
    assert.ok(big.body.length <= 4096 && big.body.toString().includes('page truncated'));
    const img = await get(gw, { host, pathName: '/img' });
    assert.equal(img.status, 200); assert.equal(img.type, 'image/gif'); assert.equal(img.body.length, 100);
    assert.equal((await get(gw, { host, pathName: '/bigimg' })).status, 404);
    assert.equal((await get(gw, { host, pathName: '/webp' })).status, 404);
    assert.equal((await get(gw, { host, pathName: '/missing' })).status, 404);
  } finally { gw.stop(); up.close(); }
});

test('gateway: form POST is forwarded', async () => {
  const up = await startUpstream(); const gw = await startGateway();
  try {
    const r = await get(gw, { host: `127.0.0.1:${up.address().port}`, pathName: '/form', method: 'POST', body: 'q=dreamcast' });
    assert.equal(r.status, 200);
    assert.ok(r.body.toString().includes('got q=dreamcast'));
  } finally { gw.stop(); up.close(); }
});

test('gateway: HTTP/1.0 request without Host gets the proxy hint page', async () => {
  const gw = await startGateway();
  try {
    const raw = await new Promise((resolve, reject) => {
      const s = net.connect(gw.port, '127.0.0.1', () => s.write('GET / HTTP/1.0\r\n\r\n'));
      const chunks = []; s.on('data', c => chunks.push(c)); s.on('end', () => resolve(Buffer.concat(chunks).toString())); s.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.[01] 400/);
    assert.ok(raw.includes('HTTP proxy'));
  } finally { gw.stop(); }
});

// ─── CallSession wiring ───────────────────────────────────────────────────

const { CallSession } = require('../../src/session/CallSession');
const LCP = Buffer.from('7eff7d23c0217d217d228d7d207d347d227d267d207d207d207d207d277d227d287d227d257d267d207d202cefccc67e', 'hex');

test('session: IP link up starts DNS + gateway on the PPP address; pppd exit stops them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthmodem-gw-'));
  const script = path.join(dir, 'pppd');
  fs.writeFileSync(script, '#!/bin/sh\nexec cat\n'); fs.chmodSync(script, 0o755);
  config.ppp = {
    dataPath: 'auto', pppdPath: script, localIp: '127.0.0.1', remoteIp: '127.0.0.1', dns: [],
    debug: false, logDir: null, extraOptions: [], nat: { enabled: false },
    gateway: { enabled: true, dnsPort: 0, httpPort: 0, pop3Port: 0, localHosts: ['www.sega.com'] },
  };
  class Sip extends EventEmitter { answerCall() {} sendBye() {} }
  class Dsp extends EventEmitter { write() {} stop() {} }
  const sess = new CallSession(new Sip(), {
    callId: 'gw-test', remoteRtpAddr: '127.0.0.1', remoteRtpPort: 40000, localRtpPort: null,
    session: null, negotiatedCodec: { name: 'PCMU', payloadType: 0 }, canBye: () => true,
  }, {});
  sess._active = true; sess._dsp = new Dsp();
  try {
    sess._onModemConnected();
    sess._dsp.emit('data', LCP);
    sess._ppp.emit('ip-up', { iface: 'lo0' });
    const { dnsResponder, webGateway, pop3Stub } = sess._gateway;
    const end = Date.now() + 2000;
    while ((!dnsResponder.port || !webGateway.port || !pop3Stub.port) && Date.now() < end) await new Promise(r => setTimeout(r, 10));
    assert.ok(pop3Stub.port, 'POP3 stub listening');
    const r = await get(webGateway, { host: 'www.sega.com' });
    assert.ok(r.body.toString().includes('SynthModem gateway'));
    const ended = new Promise(r2 => sess.once('ended', r2));
    sess.hangup('test');
    await ended;
    const end2 = Date.now() + 3000;
    while ((dnsResponder.port || webGateway.port || pop3Stub.port) && Date.now() < end2) await new Promise(r2 => setTimeout(r2, 20));
    assert.equal(dnsResponder.port, null);
    assert.equal(webGateway.port, null);
    assert.equal(pop3Stub.port, null);
  } finally {
    if (sess._active) sess.hangup('cleanup');
    if (sess._ppp) sess._ppp.stop();
  }
});
