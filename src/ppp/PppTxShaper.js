'use strict';

/**
 * PppTxShaper — keeps the modem's transmit queue short on the pppd → modem
 * path, the way a real modem's small buffer does.
 *
 * At 1200 bit/s (~110 B/s) an unbounded queue lets the Mac's TCP pile up
 * minutes of data and retransmissions; anything queued behind it (a DNS
 * answer, an ACK) arrives too late and the caller gives up. Here pppd's
 * async-HDLC output is cut into frames at the 0x7E flags and each frame is
 * checked against the modem's current backlog:
 *
 *   - link-control frames (protocol ≥ 0x4000: LCP, IPCP, PAP, ...) always go
 *   - IP frames are dropped whole when the backlog exceeds limitBytes
 *     (small frames — DNS answers, ACKs — get twice the limit)
 *
 * TCP sees a drop as congestion and backs off. Dropping whole frames keeps
 * the HDLC stream valid. Use with VJ header compression off: a silently
 * dropped VJ-compressed frame would desynchronise the peer's decompressor.
 */

const { makeLogger } = require('../logger');

const log = makeLogger('PppTxShaper');

const SMALL_FRAME   = 128;      // bytes on the wire
const MAX_PENDING   = 4096;     // flush a flag-less buffer rather than grow
const REPORT_MS     = 10000;

/** Protocol number of an async-HDLC frame body (escaped, no flags). */
function frameProtocol(seg) {
  // Unescape just enough of the head: addr, ctrl, 2 protocol bytes.
  const head = [];
  for (let i = 0; i < seg.length && head.length < 4; i++) {
    if (seg[i] === 0x7d && i + 1 < seg.length) head.push(seg[++i] ^ 0x20);
    else head.push(seg[i]);
  }
  if (head.length < 3) return null;                      // too short to be a frame
  let i = 0;
  if (head[0] === 0xff && head[1] === 0x03) i = 2;      // address/control present
  if (i >= head.length) return null;
  if (head[i] & 1) return head[i];                       // compressed (1-byte) protocol
  if (i + 1 >= head.length) return null;
  return (head[i] << 8) | head[i + 1];
}

/**
 * Short description of an async-HDLC frame body (escaped, no flags) for
 * the drop log, e.g. "TCP 192.168.51.1:80→:1034 seq=710038375 len=244
 * [ACK,PSH] (295 B)". Only used when a frame is dropped.
 */
function describeFrame(seg) {
  const f = [];
  for (let i = 0; i < seg.length; i++) f.push(seg[i] === 0x7d && i + 1 < seg.length ? seg[++i] ^ 0x20 : seg[i]);
  const wire = `(${seg.length + 1} B)`;
  let i = (f[0] === 0xff && f[1] === 0x03) ? 2 : 0;
  let proto = f[i];
  if (proto & 1) i += 1; else { proto = (f[i] << 8) | f[i + 1]; i += 2; }
  if (proto !== 0x21) return `proto 0x${proto.toString(16)} ${wire}`;
  const ip = Buffer.from(f.slice(i, f.length - 2));         // strip FCS
  if (ip.length < 20) return `IP (truncated) ${wire}`;
  const ihl = (ip[0] & 0x0f) * 4, p = ip[9], src = [...ip.subarray(12, 16)].join('.');
  const seg4 = ip.subarray(ihl);
  if (p === 6 && seg4.length >= 20) {
    const doff = (seg4[12] >> 4) * 4, len = ip.readUInt16BE(2) - ihl - doff;
    const flags = ['FIN', 'SYN', 'RST', 'PSH', 'ACK'].filter((_, k) => seg4[13] & (1 << k)).join(',');
    return `TCP ${src}:${seg4.readUInt16BE(0)}→:${seg4.readUInt16BE(2)} seq=${seg4.readUInt32BE(4)} len=${len} [${flags}] ${wire}`;
  }
  if (p === 17 && seg4.length >= 8) return `UDP ${src}:${seg4.readUInt16BE(0)}→:${seg4.readUInt16BE(2)} ${wire}`;
  return `IP proto ${p} ${wire}`;
}

const MAX_DROP_DETAILS = 5;    // per report line

class PppTxShaper {
  /**
   * @param {object} opts
   * @param {function} opts.write       (Buffer) → void, to the modem
   * @param {function} opts.backlog     () → bytes queued in the modem
   * @param {number}   [opts.limitBytes=600]
   * @param {function} [opts.now]       clock (tests)
   * @param {object}   [opts.logger]    { info } (tests)
   */
  constructor({ write, backlog, limitBytes = 600, now = Date.now, logger = log }) {
    this._write = write;
    this._backlog = backlog;
    this._limit = limitBytes;
    this._now = now;
    this._log = logger;
    this._dropDetails = [];
    this._buf = Buffer.alloc(0);
    this.stats = { frames: 0, dropped: 0, droppedBytes: 0 };
    this._lastReport = now();
    this._reportedDrops = 0;
  }

  /** pppd output → modem, frame by frame. */
  push(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    let start = 0;
    for (let i = 0; i < this._buf.length; i++) {
      if (this._buf[i] !== 0x7e) continue;
      this._segment(this._buf.subarray(start, i + 1));   // body + closing flag
      start = i + 1;
    }
    this._buf = this._buf.subarray(start);
    if (this._buf.length > MAX_PENDING) {                  // no flag for a long time
      this._write(Buffer.from(this._buf));
      this._buf = Buffer.alloc(0);
    }
    this._report();
  }

  _segment(seg) {
    if (seg.length === 1) { this._write(Buffer.from(seg)); return; }  // bare flag
    this.stats.frames++;
    const proto = frameProtocol(seg.subarray(0, seg.length - 1));
    const control = proto === null || proto >= 0x4000;
    if (!control) {
      const limit = seg.length <= SMALL_FRAME ? this._limit * 2 : this._limit;
      const backlog = this._backlog();
      if (backlog + seg.length > limit) {
        this.stats.dropped++;
        this.stats.droppedBytes += seg.length;
        if (this._dropDetails.length < MAX_DROP_DETAILS) {
          let what;
          try { what = describeFrame(seg.subarray(0, seg.length - 1)); }
          catch (_) { what = `frame (${seg.length} B)`; }
          this._dropDetails.push(`${what} at backlog ${backlog} B`);
        }
        return;
      }
    }
    this._write(Buffer.from(seg));
  }

  _report() {
    const t = this._now();
    if (t - this._lastReport < REPORT_MS || this.stats.dropped === this._reportedDrops) return;
    const n = this.stats.dropped - this._reportedDrops;
    const more = n > this._dropDetails.length ? `; +${n - this._dropDetails.length} more` : '';
    this._log.info(`PPP TX: dropped ${n} frame(s) to keep the modem queue short (backlog ${this._backlog()} B, total dropped ${this.stats.dropped}/${this.stats.frames}) — ${this._dropDetails.join('; ')}${more}`);
    this._lastReport = t;
    this._reportedDrops = this.stats.dropped;
    this._dropDetails = [];
  }
}

module.exports = { PppTxShaper, frameProtocol, describeFrame };
