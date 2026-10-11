'use strict';

/**
 * WebGateway — plain-HTTP web access for a PPP caller (e.g. a Dreamcast
 * browser) without routing its traffic.
 *
 * DnsResponder answers every name with this Mac's PPP address, so the
 * caller's browser connects here believing it reached the real site. The
 * gateway reads the target from the Host header (or from an absolute
 * proxy-style request URI), fetches it as an ordinary Mac client — over
 * HTTPS when the site requires it — and returns a slimmed-down page:
 * scripts, styles and embeds removed, https:// links rewritten to http://,
 * text re-encoded to ISO-8859-1, size capped for a 1200 bps link.
 *
 * Safety: only the PPP caller's address may connect, and targets that
 * resolve to private, loopback or link-local addresses are refused (also
 * when reached through a redirect), so the caller cannot reach the LAN.
 */

const http             = require('http');
const dns              = require('dns');
const net              = require('net');
const { EventEmitter } = require('events');
const { makeLogger }   = require('../logger');

const log = makeLogger('WebGateway');

const USER_AGENT = 'Mozilla/5.0 (compatible; SynthModem-gateway; +text-friendly)';
const MAX_REDIRECTS = 5;
const RAW_HTML_LIMIT = 1024 * 1024;   // upstream bytes read before simplifying

// ─── Address policy ───────────────────────────────────────────────────────

function ipv4ToInt(ip) {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
const PRIVATE_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 3],
].map(([base, bits]) => [ipv4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

/** True for addresses the caller must not reach through the gateway. */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const v = ipv4ToInt(ip);
    return PRIVATE_V4.some(([base, mask]) => ((v & mask) >>> 0) === base);
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    if (s.startsWith('::ffff:')) return isPrivateAddress(s.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
  }
  return true;
}

/** Resolve a hostname and reject it if any address is private. */
async function defaultCheckTarget(hostname) {
  const addrs = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.promises.lookup(hostname, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateAddress(a.address))) {
    throw Object.assign(new Error(`${hostname} resolves to a private address`), { blocked: true });
  }
}

// ─── Page simplification ──────────────────────────────────────────────────

const LATIN1_MAP = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"', '–': '-', '—': '-',
  '…': '...', '•': '*', ' ': ' ', ' ': ' ', '​': '',
  '™': '(TM)', '€': 'EUR',
};

/** Encode text as ISO-8859-1, transliterating common punctuation. */
function toLatin1(text) {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x100) out += ch;
    else out += LATIN1_MAP[ch] !== undefined ? LATIN1_MAP[ch] : '?';
  }
  return Buffer.from(out, 'latin1');
}

/** Strip what a 1999 browser can't use and rewrite https links. */
function simplifyHtml(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|svg|iframe|template|object|video|audio|canvas)\b[\s\S]*?<\/\1\s*>/gi, '')
    // An opener left after that has no closing tag — the raw read was capped
    // mid-element. Drop it and everything after it.
    .replace(/<(script|style|svg|iframe|template)\b[\s\S]*$/i, '')
    .replace(/<(script|link|meta\s+http-equiv="?content-security[^>]*|source|embed)\b[^>]*>/gi, '')
    .replace(/<\/?noscript\b[^>]*>/gi, '')
    .replace(/\s(style|srcset|integrity|crossorigin|data-[\w-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/https:\/\//gi, 'http://')
    .replace(/<meta\b[^>]*charset[^>]*>/gi, '')
    .replace(/\n\s*\n+/g, '\n');
}

/** Truncate a Latin-1 page to maxBytes at a tag boundary, with a notice. */
function capPage(buf, maxBytes) {
  if (buf.length <= maxBytes) return buf;
  let cut = buf.lastIndexOf(0x3e /* > */, maxBytes - 120);
  // No tag boundary in the last half: hard cut rather than lose the page.
  if (cut < maxBytes / 2) cut = maxBytes - 121;
  const note = Buffer.from('\n<hr><p><b>[SynthModem: page truncated for the modem link]</b></p></body></html>', 'latin1');
  return Buffer.concat([buf.subarray(0, cut + 1), note]);
}

function charsetOf(contentType) {
  const m = /charset=([\w-]+)/i.exec(contentType || '');
  return m ? m[1].toLowerCase() : 'utf-8';
}

// ─── Local pages ──────────────────────────────────────────────────────────

function startPage() {
  return `<html><head><title>SynthModem</title></head>
<body bgcolor="#ffffff">
<h2>SynthModem gateway</h2>
<p>You are online through SynthModem. Pages are simplified (no scripts or
styles) and capped in size because the modem link is about 1200 bit/s.</p>
<p>Type an address in the browser's URL field, or try:</p>
<ul>
<li><a href="http://frogfind.com/">FrogFind</a> - search for vintage browsers</li>
<li><a href="http://68k.news/">68k.news</a> - news headlines</li>
<li><a href="http://text.npr.org/">text.npr.org</a> - NPR text-only</li>
<li><a href="http://lite.cnn.com/">lite.cnn.com</a> - CNN lite</li>
</ul>
</body></html>`;
}

function messagePage(title, text) {
  return `<html><head><title>${title}</title></head><body><h2>${title}</h2><p>${text}</p>` +
         '<p><a href="http://www.sega.com/">SynthModem start page</a></p></body></html>';
}

const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ─── Gateway ──────────────────────────────────────────────────────────────

class WebGateway extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string}   opts.bindIp
   * @param {number}   [opts.port=80]
   * @param {string[]} opts.allowedClients   caller address(es)
   * @param {string[]} [opts.localHosts]     names served the start page
   * @param {number}   [opts.maxPageBytes=16384]
   * @param {number}   [opts.maxImageBytes=8192]
   * @param {number}   [opts.timeoutMs=15000]
   * @param {function} [opts.checkTarget]    async (hostname) → throws if blocked (tests)
   * @param {function} [opts.fetchImpl]      fetch stand-in (tests)
   */
  constructor(opts) {
    super();
    // Defaults, overridden only by options that are actually set.
    this._opts = { port: 80, localHosts: [], maxPageBytes: 16384, maxImageBytes: 8192, timeoutMs: 15000 };
    for (const [k, v] of Object.entries(opts)) if (v !== undefined) this._opts[k] = v;
    this._checkTarget = opts.checkTarget || defaultCheckTarget;
    this._fetch = opts.fetchImpl || fetch;
    this._server = null;
  }

  get port() { return this._server ? this._server.address().port : null; }

  start() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this._handle(req, res).catch(err => {
          log.warn(`gateway error: ${err.message}`);
          this._send(res, 502, 'text/html', toLatin1(messagePage('Gateway error', escapeHtml(err.message))));
        });
      });
      server.once('error', reject);
      server.listen(this._opts.port, this._opts.bindIp, () => {
        server.removeListener('error', reject);
        this._server = server;
        log.info(`Web gateway on http://${this._opts.bindIp}:${this.port}/`);
        resolve();
      });
    });
  }

  stop() {
    if (!this._server) return;
    this._server.close();
    if (this._server.closeAllConnections) this._server.closeAllConnections();
    this._server = null;
  }

  _send(res, status, type, body) {
    if (res.headersSent) return res.end();
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length, Connection: 'close' });
    res.end(body);
  }

  /** Work out the requested URL from an absolute URI or the Host header. */
  _target(req) {
    if (/^https?:\/\//i.test(req.url)) return new URL(req.url);
    const host = req.headers.host;
    if (!host) return null;
    return new URL(`http://${host}${req.url.startsWith('/') ? req.url : '/' + req.url}`);
  }

  async _handle(req, res) {
    const started = Date.now();
    const client = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!this._opts.allowedClients.includes(client)) {
      log.warn(`refused client ${client}`);
      return this._send(res, 403, 'text/plain', Buffer.from('forbidden'));
    }
    const url = this._target(req);
    if (!url) {
      return this._send(res, 400, 'text/html', toLatin1(messagePage('No Host header',
        'This browser did not say which site it wanted. Set its HTTP proxy to ' +
        `${this._opts.bindIp} port ${this.port} instead.`)));
    }
    const host = url.hostname.toLowerCase();
    const urlPort = url.port === '' ? 80 : Number(url.port);
    const isGateway = host === this._opts.bindIp && (urlPort === this.port || url.port === '');
    if (isGateway || this._opts.localHosts.includes(host)) {
      log.info(`${req.method} ${url.href} → start page`);
      return this._send(res, 200, 'text/html; charset=ISO-8859-1', toLatin1(startPage()));
    }

    let body;
    if (req.method === 'POST') body = await readBody(req, 64 * 1024);

    let upstream;
    try {
      upstream = await this._fetchFollowing(url, req.method, body, req.headers['content-type']);
    } catch (err) {
      const status = err.blocked ? 403 : 502;
      log.warn(`${req.method} ${url.href} → ${status} ${err.message}`);
      return this._send(res, status, 'text/html; charset=ISO-8859-1',
        toLatin1(messagePage(err.blocked ? 'Blocked' : 'Could not fetch page', escapeHtml(err.message))));
    }

    const type = (upstream.headers.get('content-type') || 'application/octet-stream').toLowerCase();
    let out, outType;
    if (type.startsWith('text/html') || type.startsWith('application/xhtml')) {
      // Modern pages are mostly script/style; read plenty before simplifying.
      const raw = await readCapped(upstream, RAW_HTML_LIMIT);
      const text = new TextDecoder(charsetOf(type), { fatal: false }).decode(raw);
      out = capPage(toLatin1(simplifyHtml(text)), this._opts.maxPageBytes);
      outType = 'text/html; charset=ISO-8859-1';
    } else if (/^image\/(gif|jpeg|jpg|png)/.test(type)) {
      const raw = await readCapped(upstream, this._opts.maxImageBytes + 1);
      if (raw.length > this._opts.maxImageBytes) {
        log.info(`${req.method} ${url.href} → image too large, skipped`);
        return this._send(res, 404, 'text/plain', Buffer.from('image too large for modem link'));
      }
      out = raw; outType = type;
    } else if (type.startsWith('text/')) {
      const raw = await readCapped(upstream, this._opts.maxPageBytes * 4);
      out = capPage(toLatin1(new TextDecoder(charsetOf(type)).decode(raw)), this._opts.maxPageBytes);
      outType = `${type.split(';')[0]}; charset=ISO-8859-1`;
    } else {
      log.info(`${req.method} ${url.href} → unsupported type ${type}`);
      return this._send(res, 404, 'text/plain', Buffer.from('unsupported content type'));
    }
    log.info(`${req.method} ${url.href} → ${upstream.status} ${outType.split(';')[0]} ${out.length} B (${Date.now() - started} ms)`);
    this.emit('request', { method: req.method, url: url.href, status: upstream.status, bytes: out.length });
    this._send(res, upstream.status >= 400 ? upstream.status : 200, outType, out);
  }

  /** Fetch with manual redirects, checking every hop; fall back to https. */
  async _fetchFollowing(url, method, body, contentType) {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await this._checkTarget(current.hostname);
      let resp;
      try {
        resp = await this._fetch(current.href, {
          method, body, redirect: 'manual',
          signal: AbortSignal.timeout(this._opts.timeoutMs),
          headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,image/gif,image/jpeg,image/png,*/*;q=0.5',
                     ...(contentType ? { 'Content-Type': contentType } : {}) },
        });
      } catch (err) {
        if (current.protocol === 'http:') {        // site may be https-only
          current = new URL(current.href.replace(/^http:/, 'https:'));
          continue;
        }
        throw err;
      }
      const loc = resp.headers.get('location');
      if (resp.status >= 300 && resp.status < 400 && loc) {
        current = new URL(loc, current);
        if (resp.status === 303) { method = 'GET'; body = undefined; }
        continue;
      }
      return resp;
    }
    throw new Error('too many redirects');
  }
}

async function readCapped(resp, limit) {
  const chunks = [];
  let n = 0;
  if (!resp.body) return Buffer.alloc(0);
  for await (const chunk of resp.body) {
    chunks.push(Buffer.from(chunk));
    n += chunk.length;
    if (n >= limit) { try { await resp.body.cancel(); } catch (_) {} break; }
  }
  return Buffer.concat(chunks).subarray(0, limit);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', c => { n += c.length; if (n <= limit) chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = { WebGateway, isPrivateAddress, simplifyHtml, toLatin1, capPage, startPage };
