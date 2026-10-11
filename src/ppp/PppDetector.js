'use strict';

/**
 * PppDetector — spots the start of a PPP session in a modem RX byte stream.
 *
 * A PPP caller (e.g. a Dreamcast) opens with LCP Configure-Requests in
 * async-HDLC framing (RFC 1662). LCP frames always carry the full address
 * and control fields, and with the default ACCM the control byte 0x03 is
 * escaped, so the frame begins with one of:
 *
 *   7E FF 03 C0 21        (control unescaped)
 *   7E FF 7D 23 C0 21     (control escaped — what the Dreamcast sends)
 *
 * Bytes before the opening flag (V.42 ODP, line noise) are ignored.
 * feed() returns the bytes from the opening 0x7E onward once a match is
 * seen, so the first LCP frame can be handed to pppd intact.
 */

const PATTERNS = [
  Buffer.from([0x7e, 0xff, 0x03, 0xc0, 0x21]),
  Buffer.from([0x7e, 0xff, 0x7d, 0x23, 0xc0, 0x21]),
];
const MAX_PATTERN = Math.max(...PATTERNS.map(p => p.length));

class PppDetector {
  constructor() {
    this._tail = Buffer.alloc(0);
    this._detected = false;
  }

  get detected() { return this._detected; }

  /**
   * @param {Buffer} buf  newly received bytes
   * @returns {Buffer|null}  bytes from the opening flag onward on the
   *     call that detects PPP; null otherwise (and on every later call).
   */
  feed(buf) {
    if (this._detected) return null;
    const data = Buffer.concat([this._tail, buf]);
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== 0x7e) continue;
      for (const p of PATTERNS) {
        if (i + p.length <= data.length && data.subarray(i, i + p.length).equals(p)) {
          this._detected = true;
          return Buffer.from(data.subarray(i));
        }
      }
    }
    // Keep enough tail to match a pattern split across calls.
    this._tail = Buffer.from(data.subarray(Math.max(0, data.length - (MAX_PATTERN - 1))));
    return null;
  }
}

module.exports = { PppDetector };
