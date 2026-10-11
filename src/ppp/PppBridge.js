'use strict';

/**
 * PppBridge — terminates a caller's PPP session with the system pppd.
 *
 * pppd runs with `notty`: it speaks async-HDLC on its stdin/stdout through
 * an internal pseudo-tty "character shunt", so no serial device or native
 * module is needed. Modem RX bytes are written to pppd's stdin; pppd's
 * stdout is emitted as 'data' for the modem to transmit.
 *
 * pppd creates a point-to-point interface (localIp ↔ remoteIp) for the
 * life of the call and removes it when it exits. It needs root, which
 * SynthModem already has when bound to a LAN SIP port. No default route,
 * proxy ARP or forwarding is configured here.
 *
 * Events: 'data' (Buffer), 'ip-up' ({ iface }) once pppd has assigned
 * localIp to its interface (IPCP up), 'exit' ({ code, signal }),
 * 'error' (Error).
 */

const { spawn }        = require('child_process');
const { EventEmitter } = require('events');
const fs               = require('fs');
const os               = require('os');
const path             = require('path');
const { makeLogger }   = require('../logger');

const log = makeLogger('PppBridge');

/**
 * Build the pppd argument list from the `ppp` config section.
 * Exported for tests.
 */
function buildPppdArgs(cfg, { logFile, tag } = {}) {
  const args = [
    'notty', 'nodetach',
    'noauth',            // don't ask the caller to authenticate
    'local',             // no modem control lines on a pipe
    'passive',           // wait for the caller's LCP rather than giving up
    'maxfail', '1',
    'asyncmap', '0',
    'noacsp',            // Apple's ACSCP extension; callers reject it
    `${cfg.localIp}:${cfg.remoteIp}`,
  ];
  // Small packets for a slow link: a 1500-byte packet takes ~13 s at
  // 1200 bit/s, far beyond TCP's retransmit timer.
  if (cfg.mtu) args.push('mtu', String(cfg.mtu), 'mru', String(cfg.mtu));
  // VJ header compression can't survive PppTxShaper dropping frames.
  if (cfg.vj === false) args.push('novj');
  for (const dns of cfg.dns || []) args.push('ms-dns', dns);
  if (cfg.debug) args.push('debug');
  if (logFile) args.push('logfile', logFile);
  if (tag) args.push('ipparam', tag);
  args.push(...(cfg.extraOptions || []));
  return args;
}

class PppBridge extends EventEmitter {
  /**
   * @param {object} cfg   config.ppp
   * @param {object} [opts]
   * @param {string} [opts.tag]  call identifier (log file name, ipparam)
   * @param {function} [opts.getInterfaces]  os.networkInterfaces stand-in (tests)
   */
  constructor(cfg, opts = {}) {
    super();
    this._cfg  = cfg;
    this._tag  = opts.tag || 'call';
    this._getInterfaces = opts.getInterfaces || os.networkInterfaces;
    this._ipPoll = null;
    this._proc = null;
    this._exited = false;
    this._rxBytes = 0;
    this._txBytes = 0;
  }

  get running() { return !!this._proc && !this._exited; }
  get logFile() { return this._logFile; }

  start() {
    const cfg = this._cfg;
    if (cfg.logDir) {
      try { fs.mkdirSync(cfg.logDir, { recursive: true }); } catch (_) { /* pppd reports */ }
      const safe = this._tag.replace(/[^a-z0-9]/gi, '-');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      this._logFile = path.resolve(cfg.logDir, `pppd-${ts}_${safe}.log`);
    }
    const args = buildPppdArgs(cfg, { logFile: this._logFile, tag: this._tag });
    log.info(`Starting ${cfg.pppdPath} ${args.join(' ')}`);

    const proc = spawn(cfg.pppdPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this._proc = proc;

    proc.stdout.on('data', buf => {
      this._txBytes += buf.length;
      this.emit('data', buf);
    });
    proc.stderr.on('data', buf => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (line.trim()) log.info(`pppd: ${line.trim()}`);
      }
    });
    proc.stdin.on('error', () => { /* pppd gone; 'exit' reports it */ });
    proc.on('error', err => {
      log.error(`pppd failed to start: ${err.message}`);
      if (this._ipPoll) { clearInterval(this._ipPoll); this._ipPoll = null; }
      this._exited = true;
      this.emit('error', err);
    });
    // IPCP up = pppd has put localIp on its interface.
    this._ipPoll = setInterval(() => {
      const ifaces = this._getInterfaces();
      for (const [name, addrs] of Object.entries(ifaces)) {
        if ((addrs || []).some(a => a.address === cfg.localIp)) {
          clearInterval(this._ipPoll);
          this._ipPoll = null;
          log.info(`IP link up on ${name} (${cfg.localIp} ↔ ${cfg.remoteIp})`);
          this.emit('ip-up', { iface: name });
          return;
        }
      }
    }, 250);

    proc.on('exit', (code, signal) => {
      if (this._ipPoll) { clearInterval(this._ipPoll); this._ipPoll = null; }
      this._exited = true;
      log.info(`pppd exited (code ${code}, signal ${signal}); modem→pppd ${this._rxBytes} B, pppd→modem ${this._txBytes} B`);
      this.emit('exit', { code, signal });
    });
  }

  /** Modem RX bytes → pppd. */
  write(buf) {
    if (!this.running) return;
    this._rxBytes += buf.length;
    this._proc.stdin.write(buf);
  }

  /** SIGTERM pppd (it sends LCP Terminate-Request and removes its interface). */
  stop() {
    if (!this.running) return;
    log.info('Stopping pppd');
    try { this._proc.kill('SIGTERM'); } catch (_) { /* already gone */ }
    // Escalate if pppd hangs on teardown.
    const p = this._proc;
    setTimeout(() => { if (!this._exited) { try { p.kill('SIGKILL'); } catch (_) {} } }, 3000).unref();
  }
}

module.exports = { PppBridge, buildPppdArgs };
