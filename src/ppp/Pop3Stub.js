'use strict';

/**
 * Pop3Stub — an always-empty POP3 mailbox on the PPP address.
 *
 * Dial-up clients (the Dreamcast browser among them) check mail right after
 * connecting. DnsResponder sends the mail server's name to this Mac, so
 * without a listener the check is refused and the client may give up. This
 * stub accepts any login and reports zero messages (RFC 1939), so the
 * check succeeds immediately. Passwords are never logged.
 */

const net              = require('net');
const { EventEmitter } = require('events');
const { makeLogger }   = require('../logger');

const log = makeLogger('Pop3Stub');

const IDLE_MS  = 60000;
const MAX_LINE = 512;

/** Response(s) for one command line; { reply, close } */
function respond(line) {
  const [cmd = '', arg] = line.trim().split(/\s+/, 2);
  switch (cmd.toUpperCase()) {
    case 'USER': return { reply: '+OK' };
    case 'PASS': return { reply: '+OK mailbox empty (0 messages)' };
    case 'APOP': return { reply: '+OK mailbox empty (0 messages)' };
    case 'CAPA': return { reply: '+OK\r\nUSER\r\nUIDL\r\n.' };
    case 'STAT': return { reply: '+OK 0 0' };
    case 'LIST':
    case 'UIDL': return { reply: arg ? '-ERR no such message' : '+OK 0 messages\r\n.' };
    case 'RETR':
    case 'TOP':
    case 'DELE': return { reply: '-ERR no such message' };
    case 'NOOP':
    case 'RSET': return { reply: '+OK' };
    case 'QUIT': return { reply: '+OK bye', close: true };
    default:     return { reply: '-ERR unknown command' };
  }
}

/** Command line as it may be logged (PASS/APOP secrets masked). */
function redact(line) {
  return line.replace(/^(\s*(PASS|APOP\s+\S+)\s+).*$/i, '$1****');
}

class Pop3Stub extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.bindIp
   * @param {number} [opts.port=110]
   * @param {string[]} [opts.allowedClients]  refuse anyone else (default: anyone)
   * @param {object} [opts.logger]
   */
  constructor(opts) {
    super();
    this._opts = { port: 110, ...opts };
    this._log = opts.logger || log;
    this._server = null;
    this._sockets = new Set();
  }

  get port() { return this._server ? this._server.address().port : null; }

  start() {
    return new Promise((resolve, reject) => {
      const server = net.createServer(sock => this._session(sock));
      server.once('error', reject);
      server.listen(this._opts.port, this._opts.bindIp, () => {
        server.removeListener('error', reject);
        this._server = server;
        this._log.info(`POP3 stub on ${this._opts.bindIp}:${this.port} (empty mailbox)`);
        resolve();
      });
    });
  }

  stop() {
    if (!this._server) return;
    for (const s of this._sockets) s.destroy();
    this._server.close();
    this._server = null;
  }

  _session(sock) {
    const client = (sock.remoteAddress || '').replace(/^::ffff:/, '');
    const allowed = this._opts.allowedClients;
    if (allowed && !allowed.includes(client)) {
      this._log.warn(`POP3 refused client ${client}`);
      sock.destroy();
      return;
    }
    this._sockets.add(sock);
    sock.on('close', () => this._sockets.delete(sock));
    sock.on('error', () => {});
    sock.setTimeout(IDLE_MS, () => sock.destroy());
    this._log.info(`POP3 session from ${client}`);
    sock.write('+OK SynthModem POP3 ready\r\n');

    let buf = '';
    sock.on('data', chunk => {
      buf += chunk.toString('latin1');
      if (buf.length > MAX_LINE && !buf.includes('\n')) { sock.destroy(); return; }
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        const { reply, close } = respond(line);
        this._log.info(`POP3 ${client} ${redact(line)} → ${reply.split('\r\n')[0]}`);
        this.emit('command', { client, line: redact(line) });
        sock.write(reply + '\r\n');
        if (close) { sock.end(); return; }
      }
    });
  }
}

module.exports = { Pop3Stub, respond, redact };
