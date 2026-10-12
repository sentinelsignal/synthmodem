'use strict';

/**
 * LinkPacer — delivers WebGateway responses no faster than the modem link
 * can carry them, so nothing upstream of the modem queues up and nothing
 * needs to be dropped.
 *
 * Without pacing the gateway hands a whole page to the Mac's TCP, which
 * bursts it onto ppp0; pppd forwards it into the modem's send queue faster
 * than the line drains, the queue fills, PppTxShaper has to drop frames and
 * TCP spends the call retransmitting. Here each response body is written in
 * single-segment chunks, gated two ways:
 *
 *   1. a token bucket refilled at the negotiated line rate (bps / 11 bits
 *      per byte), each chunk charged its on-the-wire cost (IP+TCP headers,
 *      PPP framing, HDLC escapes, HTTP headers on the first chunk), with the
 *      bucket capped at two chunks — never more than that ahead of the line;
 *   2. the modem's actual send backlog must be under maxBacklogSec of
 *      airtime, so the gateway follows the real link, not just the model.
 *
 * Responses are interleaved round-robin. Everything is bounded: at most
 * maxStreams responses, each body already size-capped by WebGateway; a
 * response that makes no progress for stallMs, or exceeds maxDurationMs, is
 * aborted; a client disconnect drops its stream at once; stop() aborts all.
 * The timer runs only while there is something to send.
 */

const { makeLogger } = require('../logger');

const log = makeLogger('LinkPacer');

const BITS_PER_BYTE    = 11;    // QAMModulator UART framing: start + 8 + 2 stop
const TCPIP_HEADER     = 40;    // IPv4 + TCP, no VJ compression
const PPP_FRAMING      = 6;     // flag + address/control + protocol + FCS (worst case)
const HTTP_HEADER_EST  = 160;   // response status line + headers

/** Bytes on the wire for one TCP segment carrying `payload` bytes. */
function wireBytes(payload) {
  const pkt = payload + TCPIP_HEADER;
  return pkt + PPP_FRAMING + Math.ceil(pkt / 64);   // ~escape overhead, generous
}

class LinkPacer {
  /**
   * @param {object} opts
   * @param {function} opts.backlog       () → bytes waiting in the modem
   * @param {function} opts.bps           () → negotiated bit rate (falls back to 1200)
   * @param {number}   [opts.mtu=296]     PPP MTU; chunk = one MSS
   * @param {number}   [opts.tcpOptionsBytes=0]  per-segment TCP options (12 if the
   *     peer negotiates timestamps); a Dreamcast uses none, so a full
   *     MTU − 40 byte chunk fills each segment
   * @param {number}   [opts.maxBacklogSec=1.0]
   * @param {number}   [opts.queueCapBytes=Infinity]  never let backlog + chunk exceed
   *     this; set just below PppTxShaper's limit so paced data is never dropped
   * @param {number}   [opts.tickMs=50]
   * @param {number}   [opts.stallMs=60000]
   * @param {number}   [opts.maxDurationMs=900000]
   * @param {number}   [opts.maxStreams=8]
   * @param {function} [opts.now]         clock (tests)
   * @param {object}   [opts.timers]      { setInterval, clearInterval } (tests)
   * @param {object}   [opts.logger]      { info, warn } (tests)
   */
  constructor(opts) {
    this._backlog = opts.backlog;
    this._bps = opts.bps;
    this._chunk = Math.max(64, (opts.mtu || 296) - TCPIP_HEADER - (opts.tcpOptionsBytes || 0));
    this._log = opts.logger || log;
    this._maxBacklogSec = opts.maxBacklogSec ?? 1.0;
    this._queueCap = opts.queueCapBytes ?? Infinity;
    this._tickMs = opts.tickMs ?? 50;
    this._stallMs = opts.stallMs ?? 60000;
    this._maxDurationMs = opts.maxDurationMs ?? 900000;
    this._maxStreams = opts.maxStreams ?? 8;
    this._now = opts.now || Date.now;
    this._timers = opts.timers || { setInterval, clearInterval };
    this._streams = [];
    this._rr = 0;
    this._tokens = 0;
    this._lastTick = null;
    this._timer = null;
    this._stopped = false;
    this.stats = { streams: 0, completed: 0, aborted: 0, bytes: 0, chunks: 0, maxBacklog: 0 };
  }

  get chunkBytes() { return this._chunk; }
  get active() { return this._streams.length; }

  /** Line bytes per second at the current negotiated rate. */
  lineRate() {
    const bps = Number(this._bps()) || 1200;
    return bps / BITS_PER_BYTE;
  }

  /**
   * Send `body` on `res` (headers already set, not yet flushed) at link
   * pace, then end it. Resolves { ok, reason }.
   */
  send(res, body) {
    return new Promise(resolve => {
      if (this._stopped || this._streams.length >= this._maxStreams) {
        const reason = this._stopped ? 'stopped' : 'too-many-streams';
        this._log.warn(`refusing paced response: ${reason}`);
        res.destroy();
        this.stats.aborted++;
        resolve({ ok: false, reason });
        return;
      }
      const now = this._now();
      const s = { res, body, size: body.length, off: 0, first: true, chunks: 0, peak: 0,
                  started: now, progress: now, resolve, done: false };
      const onClose = () => { if (!s.done) this._finish(s, false, 'client-closed'); };
      s.onClose = onClose;
      res.on('close', onClose);
      if (res.socket && res.socket.setNoDelay) res.socket.setNoDelay(true);
      this._streams.push(s);
      this.stats.streams++;
      this._ensureTimer();
      this.tick();   // first chunk without waiting a tick, if the link is free
    });
  }

  /** One scheduling step. Public for tests driven by a fake clock. */
  tick() {
    const now = this._now();
    const rate = this.lineRate();
    const cap = 2 * (wireBytes(this._chunk) + HTTP_HEADER_EST);
    if (this._lastTick === null) this._tokens = cap / 2;
    else this._tokens = Math.min(cap, this._tokens + (now - this._lastTick) / 1000 * rate);
    this._lastTick = now;

    const backlog = this._backlog() || 0;
    if (backlog > this.stats.maxBacklog) this.stats.maxBacklog = backlog;
    for (const s of this._streams) if (backlog > s.peak) s.peak = backlog;

    // Abort stalled or overlong transfers.
    for (const s of [...this._streams]) {
      if (now - s.progress > this._stallMs) this._finish(s, false, 'stalled');
      else if (now - s.started > this._maxDurationMs) this._finish(s, false, 'too-long');
    }

    // At most one chunk per tick: the backlog must reflect it before the next.
    if (this._streams.length && backlog <= this._maxBacklogSec * rate) {
      for (let n = 0; n < this._streams.length; n++) {
        const s = this._streams[(this._rr + n) % this._streams.length];
        if (s.res.writableLength > 0) continue;            // socket still busy
        const size = Math.min(this._chunk, s.body.length - s.off);
        const cost = wireBytes(size) + (s.first ? HTTP_HEADER_EST : 0);
        if (this._tokens < cost) break;
        // Would overflow the shaper — wait, unless the queue is empty (a chunk
        // larger than the cap must still be able to go, or nothing ever would).
        if (backlog > 0 && backlog + cost > this._queueCap) break;
        this._tokens -= cost;
        this._rr = (this._rr + n + 1) % Math.max(1, this._streams.length);
        this._write(s, size, now);
        break;
      }
    }
    if (!this._streams.length) this._stopTimer();
  }

  _write(s, size, now) {
    const chunk = s.body.subarray(s.off, s.off + size);
    s.off += size;
    s.first = false;
    s.progress = now;
    s.chunks++;
    this.stats.bytes += size;
    this.stats.chunks++;
    if (s.off >= s.body.length) {
      s.res.end(chunk);
      this._finish(s, true, 'complete');
    } else {
      s.res.write(chunk);
    }
  }

  _finish(s, ok, reason) {
    if (s.done) return;
    s.done = true;
    const i = this._streams.indexOf(s);
    if (i >= 0) this._streams.splice(i, 1);
    s.res.removeListener('close', s.onClose);
    // One measurement line per response. "written" = handed to TCP; the
    // modem still has up to ~1 s of it queued at that point.
    const secs = Math.max(0.001, (this._now() - s.started) / 1000);
    const bps = Number(this._bps()) || 1200;
    // A rate is only meaningful once pacing has spaced at least two chunks.
    const rate = s.chunks >= 2
      ? `(${Math.round(s.off / secs)} B/s, ${Math.round(s.off / secs / (bps / BITS_PER_BYTE) * 100)}% of ${bps} bps line)`
      : '(in one chunk)';
    const measure = `${s.off}/${s.size} B written in ${secs.toFixed(1)} s ${rate}, ` +
      `${s.chunks} chunk${s.chunks === 1 ? '' : 's'}, modem queue peak ${Math.round(s.peak)} B`;
    if (ok) {
      this.stats.completed++;
      this._log.info(`paced response complete: ${measure}`);
    } else {
      this.stats.aborted++;
      if (reason === 'client-closed') this._log.info(`paced response closed by client: ${measure}`);
      else this._log.warn(`paced response aborted (${reason}): ${measure}`);
      if (!s.res.destroyed) s.res.destroy();
    }
    s.body = null;                  // release the buffer promptly
    s.resolve({ ok, reason });
    if (!this._streams.length) this._stopTimer();
  }

  _ensureTimer() {
    if (this._timer) return;
    this._lastTick = null;
    this._timer = this._timers.setInterval(() => this.tick(), this._tickMs);
    if (this._timer && this._timer.unref) this._timer.unref();
  }

  _stopTimer() {
    if (!this._timer) return;
    this._timers.clearInterval(this._timer);
    this._timer = null;
  }

  /** Abort everything (call teardown). */
  stop() {
    this._stopped = true;
    for (const s of [...this._streams]) this._finish(s, false, 'stopped');
    this._stopTimer();
  }
}

module.exports = { LinkPacer, wireBytes, BITS_PER_BYTE };
