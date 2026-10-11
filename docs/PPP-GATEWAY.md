# PPP gateway (dial-up internet for PPP callers)

SynthModem can terminate a caller's PPP session and give it web access, so a
dial-up client such as a **Sega Dreamcast** can browse through its original
analog modem. Tested live with a Dreamcast at 1200 and 2400 bit/s
(V.22 / V.22bis, native backend).

## How it works

```
caller modem ─ SIP/RTP ─ ModemDSP (V.22/V.22bis) ─ PppBridge ─ /usr/sbin/pppd (notty)
                                                       │
                                     point-to-point link 192.168.51.1 ↔ 192.168.51.2
                                                       │
            DnsResponder :53   WebGateway :80   Pop3Stub :110   (bound to localIp only)
```

1. After modem training, the post-train hold watches the RX stream for an
   LCP frame. When one appears, the call is handed to `pppd` instead of the
   telnet menu (`dataPath: 'auto'`; non-PPP callers still get the menu).
2. `pppd` negotiates LCP/IPCP (no authentication) and creates a temporary
   point-to-point interface for the call.
3. Once the IP link is up, three small services listen on the Mac's PPP
   address only:
   - **DnsResponder** answers every name with the PPP address.
   - **WebGateway** reads the requested site from the `Host` header, fetches
     it as an ordinary Mac client (HTTPS when needed), strips scripts,
     styles and embeds, rewrites `https://` links to `http://`, re-encodes
     to ISO-8859-1 and caps page/image size.
   - **Pop3Stub** answers the client's mail check with an empty mailbox.
4. Responses are paced to the negotiated modem rate (**LinkPacer**), and
   the modem send queue is bounded (**PppTxShaper**, a safety net that drops
   IP frames only if the queue still overflows).

No routing, IP forwarding or firewall changes are made in this mode. The
Mac's own networking (including VPNs) is used for the gateway's outbound
fetches.

## Requirements

- macOS with the system `/usr/sbin/pppd` (it must run as root; SynthModem is
  normally started with `sudo` when bound to a LAN SIP port).
- Node.js 22.
- `modem.backend: 'native'` (the PPP hand-off lives in the native data path).
- Nothing else on the Mac listening on ports 53, 80 or 110 **of the PPP
  address** (other addresses are unaffected).
- A PPP subnet that does not overlap any existing network.

## Configuration

Add a `ppp` section to `config.js` (top level, next to `telnet`). Without it,
SynthModem behaves as before (telnet menu only).

```js
  ppp: {
    // 'telnet' — always the telnet menu (original behaviour)
    // 'auto'   — PPP bridge when an LCP frame is seen, else the telnet menu
    // 'ppp'    — always the PPP bridge
    dataPath: 'auto',

    pppdPath: '/usr/sbin/pppd',

    // Point-to-point addresses: Mac ↔ caller. Must not overlap any existing network.
    localIp:  '192.168.51.1',
    remoteIp: '192.168.51.2',

    // DNS server handed to the caller in IPCP — our own responder.
    dns: ['192.168.51.1'],

    gateway: {
      enabled:       true,
      dnsPort:       53,
      httpPort:      80,
      pop3Port:      110,        // empty-mailbox stub; null = off
      dnsOverrides:  {},         // e.g. { '*.example.com': '203.0.113.5' }
      localHosts:    ['www.sega.com', 'vserver.planetweb.com'],   // → local start page
      maxPageBytes:  16384,      // ~2.5 min at 1200 bit/s
      maxImageBytes: 8192,
      timeoutMs:     15000,
      pacing:        true,       // pace responses to the modem rate (LinkPacer)
    },

    // Internet routing for the caller (IP forwarding + pf NAT). Changes macOS
    // networking while a call is up — leave off unless you need non-HTTP
    // traffic (e.g. games). A VPN that manages pf can prevent it working.
    nat: {
      enabled:   false,
      interface: 'auto',
    },

    // Slow-link tuning.
    mtu:          296,           // packet size both ways (~2.7 s per packet at 1200 bit/s)
    txQueueBytes: 600,           // modem send-queue limit before IP frames are dropped
    vj:           false,         // VJ header compression off (incompatible with drops)

    debug:        true,          // pppd debug log
    logDir:       './logs',      // per-call pppd-<time>_<call>.log
    extraOptions: [],
  },
```

## Dreamcast notes

- Its stored ISP settings may contain DNS servers of a defunct provider; it
  alternates between those and the IPCP-provided server. Setting its DNS
  servers to `192.168.51.1` avoids a timeout on every other lookup.
- On connect the browser fetches `http://www.sega.com/dcreg` and checks mail
  (POP3); both are answered locally.
- At 1200–2400 bit/s expect roughly 80–200 bytes/s of page data: a 4 KB page
  takes 20–45 s, a 16 KB page 1.5–3 minutes. Text-oriented sites work best.

## Logs

- `logs/pppd-*.log` — LCP/IPCP negotiation per call.
- SynthModem log: `IP link up`, `DNS …`, `GET … → 200 … B`, `POP3 …`
  (passwords are never logged), `PPP TX: dropped …` (should be rare with
  pacing on).
