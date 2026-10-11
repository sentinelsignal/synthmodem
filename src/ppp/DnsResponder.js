'use strict';

/**
 * DnsResponder — answers a PPP caller's DNS queries on the PPP-side address.
 *
 * Every A query is answered with `answerIp` (normally this Mac's PPP
 * address, so the caller's web requests reach WebGateway) unless an entry
 * in `overrides` matches. Keys are exact names ('example.com') or
 * wildcards ('*.example.com', which also matches 'example.com').
 * Other query types get an empty NOERROR answer; malformed packets are
 * dropped.
 *
 * Bound only to the PPP address, so it is unreachable from other networks
 * and exists only while the caller's IP link is up.
 *
 * Events: 'query' ({ name, type, from, answer }).
 */

const dgram            = require('dgram');
const { EventEmitter } = require('events');
const { makeLogger }   = require('../logger');

const log = makeLogger('DnsResponder');

const TYPE_A  = 1;
const CLASS_IN = 1;

/** Parse the question section. Returns null if malformed. */
function parseQuery(buf) {
  if (buf.length < 12) return null;
  const flags = buf.readUInt16BE(2);
  if (flags & 0x8000) return null;                 // a response, not a query
  if (buf.readUInt16BE(4) < 1) return null;        // no question
  const labels = [];
  let i = 12;
  for (;;) {
    if (i >= buf.length) return null;
    const len = buf[i];
    if (len === 0) { i++; break; }
    if (len & 0xc0) return null;                   // no compression in questions
    if (i + 1 + len > buf.length) return null;
    labels.push(buf.subarray(i + 1, i + 1 + len).toString('latin1'));
    i += 1 + len;
  }
  if (i + 4 > buf.length) return null;
  return {
    id:     buf.readUInt16BE(0),
    flags,
    name:   labels.join('.').toLowerCase(),
    type:   buf.readUInt16BE(i),
    cls:    buf.readUInt16BE(i + 2),
    qEnd:   i + 4,                                 // end of the first question
  };
}

/** Look up an override: exact name first, then '*.parent' wildcards. */
function matchOverride(name, overrides) {
  const table = overrides || {};
  if (Object.prototype.hasOwnProperty.call(table, name)) return table[name];
  const parts = name.split('.');
  for (let k = 0; k < parts.length - 1; k++) {
    const wild = '*.' + parts.slice(k).join('.');
    if (Object.prototype.hasOwnProperty.call(table, wild)) return table[wild];
  }
  return null;
}

/**
 * Build the response for a query packet.
 * @returns {{response: Buffer, query: object, answer: string|null}|null}
 */
function buildResponse(buf, { answerIp, overrides, ttl = 60 }) {
  const q = parseQuery(buf);
  if (!q) return null;
  const isA = q.type === TYPE_A && q.cls === CLASS_IN;
  const answer = isA ? (matchOverride(q.name, overrides) || answerIp) : null;

  // Header: echo ID, QR=1, keep opcode + RD, AA=1, RA=1, RCODE=0.
  const header = Buffer.alloc(12);
  header.writeUInt16BE(q.id, 0);
  header.writeUInt16BE(0x8000 | (q.flags & 0x7900) | 0x0400 | 0x0080, 2);
  header.writeUInt16BE(1, 4);                      // QDCOUNT
  header.writeUInt16BE(answer ? 1 : 0, 6);         // ANCOUNT
  const question = buf.subarray(12, q.qEnd);
  const parts = [header, question];
  if (answer) {
    const rr = Buffer.alloc(16);
    rr.writeUInt16BE(0xc00c, 0);                   // name → pointer to question
    rr.writeUInt16BE(TYPE_A, 2);
    rr.writeUInt16BE(CLASS_IN, 4);
    rr.writeUInt32BE(ttl, 6);
    rr.writeUInt16BE(4, 10);
    answer.split('.').forEach((o, k) => { rr[12 + k] = Number(o) & 0xff; });
    parts.push(rr);
  }
  return { response: Buffer.concat(parts), query: q, answer };
}

class DnsResponder extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.bindIp
   * @param {number} [opts.port=53]
   * @param {string} opts.answerIp
   * @param {object} [opts.overrides]
   * @param {number} [opts.ttl=60]
   */
  constructor(opts) {
    super();
    this._opts = opts;
    this._sock = null;
  }

  get port() { return this._sock ? this._sock.address().port : null; }

  start() {
    return new Promise((resolve, reject) => {
      const { bindIp, port = 53 } = this._opts;
      const sock = dgram.createSocket('udp4');
      sock.once('error', reject);
      sock.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
      sock.bind(port, bindIp, () => {
        sock.removeListener('error', reject);
        sock.on('error', err => log.warn(`DNS socket error: ${err.message}`));
        this._sock = sock;
        log.info(`DNS responder on ${bindIp}:${this.port} (answering ${this._opts.answerIp})`);
        resolve();
      });
    });
  }

  stop() {
    if (!this._sock) return;
    try { this._sock.close(); } catch (_) { /* already closed */ }
    this._sock = null;
  }

  _onMessage(msg, rinfo) {
    const r = buildResponse(msg, this._opts);
    if (!r) return;
    const from = `${rinfo.address}:${rinfo.port}`;
    log.info(`DNS ${from} ${r.query.name} type ${r.query.type} → ${r.answer || '(no answer)'}`);
    this.emit('query', { name: r.query.name, type: r.query.type, from, answer: r.answer });
    this._sock.send(r.response, rinfo.port, rinfo.address);
  }
}

module.exports = { DnsResponder, buildResponse, parseQuery, matchOverride };
