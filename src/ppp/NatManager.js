'use strict';

/**
 * NatManager — gives PPP callers internet access while a call is up, using
 * macOS IP forwarding plus a pf NAT rule, and undoes both afterwards.
 *
 * On the first acquire():
 *   1. remember net.inet.ip.forwarding, then set it to 1
 *   2. load   nat on <iface> inet from <subnet> to any -> (<iface>)
 *      into the private anchor com.apple/synthmodem. The stock
 *      /etc/pf.conf evaluates nat-anchor "com.apple/*", so no system file
 *      is edited and nothing outside this anchor is touched.
 *   3. enable pf with a reference-counted token (pfctl -E), so pf goes back
 *      to its previous state when the token is released
 * On the last release() (or process exit), in reverse: release the token,
 * flush the anchor, restore forwarding to its previous value.
 *
 * Commands run synchronously so the same code can run from a process
 * 'exit' handler. They need root, which SynthModem has when running the
 * PPP bridge; failures are logged and the call continues without NAT.
 */

const { spawnSync }  = require('child_process');
const { makeLogger } = require('../logger');

const log = makeLogger('NatManager');

const ANCHOR = 'com.apple/synthmodem';

function defaultRun(cmd, args, input) {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

class NatManager {
  constructor({ run = defaultRun, logger = log } = {}) {
    this._run = run;
    this._log = logger;
    this._refs = 0;
    this._state = null;    // { iface, subnet, prevForwarding, pfToken }
    this._exitHandler = null;
  }

  get active() { return this._state !== null; }

  /**
   * @param {object} opts
   * @param {string} opts.subnet  e.g. '192.168.51.0/24'
   * @param {string} [opts.interface='auto']  egress interface, or 'auto'
   *     for the interface of the current default route
   * @returns {boolean} true if NAT is (now) active
   */
  acquire({ subnet, interface: ifaceOpt = 'auto' }) {
    this._refs++;
    if (this._state) return true;
    try {
      const iface = ifaceOpt === 'auto' ? this._defaultInterface() : ifaceOpt;
      const prev = this._cmd('/usr/sbin/sysctl', ['-n', 'net.inet.ip.forwarding']).trim();
      const state = { iface, subnet, prevForwarding: prev, pfToken: null, anchorLoaded: false };
      this._state = state;
      this._installExitHandler();

      if (prev !== '1') this._cmd('/usr/sbin/sysctl', ['-w', 'net.inet.ip.forwarding=1']);

      const rule = `nat on ${iface} inet from ${subnet} to any -> (${iface})\n`;
      this._cmd('/sbin/pfctl', ['-a', ANCHOR, '-f', '-'], rule);
      state.anchorLoaded = true;

      const en = this._cmd('/sbin/pfctl', ['-E'], undefined, true);
      const m = en.match(/Token\s*:\s*(\d+)/);
      if (m) state.pfToken = m[1];

      const mainNat = this._cmd('/sbin/pfctl', ['-s', 'nat'], undefined, true);
      if (!/nat-anchor "com\.apple\/\*"/.test(mainNat)) {
        this._log.warn('Active pf ruleset does not reference nat-anchor "com.apple/*" — another firewall (e.g. a VPN) may have replaced it; NAT will not take effect');
      }
      this._log.info(`NAT up: ${subnet} → ${iface} (forwarding was ${prev}, pf token ${state.pfToken || 'none'})`);
      return true;
    } catch (err) {
      this._log.warn(`NAT setup failed: ${err.message} — PPP caller will have no internet access`);
      this._teardown();
      return false;
    }
  }

  release() {
    if (this._refs === 0) return;
    this._refs--;
    if (this._refs === 0) this._teardown();
  }

  /** Undo everything regardless of reference count (process exit). */
  releaseAll() {
    this._refs = 0;
    this._teardown();
  }

  _teardown() {
    const s = this._state;
    if (!s) return;
    this._state = null;
    const step = (what, fn) => {
      try { fn(); } catch (err) { this._log.warn(`NAT teardown: ${what} failed: ${err.message}`); }
    };
    if (s.pfToken) step('release pf token', () => this._cmd('/sbin/pfctl', ['-X', s.pfToken], undefined, true));
    if (s.anchorLoaded) step('flush anchor', () => this._cmd('/sbin/pfctl', ['-a', ANCHOR, '-F', 'all'], undefined, true));
    if (s.prevForwarding && s.prevForwarding !== '1') {
      step('restore forwarding', () => this._cmd('/usr/sbin/sysctl', ['-w', `net.inet.ip.forwarding=${s.prevForwarding}`]));
    }
    this._log.info(`NAT down: anchor flushed, forwarding restored to ${s.prevForwarding}`);
  }

  _defaultInterface() {
    const out = this._cmd('/sbin/route', ['-n', 'get', 'default']);
    const m = out.match(/interface:\s*(\S+)/);
    if (!m) throw new Error('could not determine default-route interface');
    return m[1];
  }

  /** Run a command; throw on non-zero exit unless tolerant. */
  _cmd(cmd, args, input, tolerant = false) {
    const { status, out } = this._run(cmd, args, input);
    if (status !== 0 && !tolerant) throw new Error(`${cmd} ${args.join(' ')} exited ${status}: ${out.trim()}`);
    return out;
  }

  _installExitHandler() {
    if (this._exitHandler) return;
    this._exitHandler = () => this.releaseAll();
    process.on('exit', this._exitHandler);
  }
}

const natManager = new NatManager();

module.exports = { NatManager, natManager, ANCHOR };
