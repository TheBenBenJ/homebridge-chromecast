# homebridge-chromecast

Homebridge plugin that turns a Chromecast with Google TV into a HomeKit TV, so that the iPhone
Control Center remote drives it: arrows, OK, back, home, play/pause and volume.

It also ships an optional script that wakes an LG TV through HDMI-CEC, for TVs that ignore
Wake-on-LAN over Wi-Fi.

Why: HomeKit has no Chromecast support, and the Google Cast protocol used by most Chromecast
integrations cannot send navigation keys. The Android TV Remote protocol can, and iOS shows its
Control Center remote for any HomeKit TV.

## How it works

```
iPhone remote ──HomeKit──> Homebridge (index.js) ──HTTP, 127.0.0.1:5052──> bridge/chromecast-bridge.py ──Android TV Remote──> Chromecast

homebridge-webos-tv ──Wake-on-LAN packet, 127.0.0.1:9──> bridge/cec-wake.py ──Cast: start, then quit an app──> Chromecast ──HDMI-CEC──> TV
```

- `index.js` is the Homebridge plugin. It publishes the TV accessory, forwards each key press to
  the bridge, and polls the bridge every 10 s to follow the power state.
- `bridge/chromecast-bridge.py` keeps the Android TV Remote connection open
  ([androidtvremote2](https://github.com/tronikos/androidtvremote2)), finds the Chromecast by
  name on the local network even when its IP address changes, and serves a small HTTP API on
  `127.0.0.1:5052`.
- `bridge/cec-wake.py` (optional) waits for the Wake-on-LAN packet that
  [homebridge-webos-tv](https://github.com/merdok/homebridge-webos-tv) sends, then starts and
  quits a Cast app: the Chromecast turns the TV on through HDMI-CEC.

## Requirements

- Homebridge 1.6 or 2.x, Node.js 22 or later.
- Python 3.11 or later for the bridge (tested with 3.14), with the packages of
  `bridge/requirements.txt`.
- A Chromecast with Google TV on the same local network as the Homebridge host, with mDNS
  working between them.
- For the CEC wake: homebridge-webos-tv, and HDMI-CEC enabled on the TV (SIMPLINK on LG).

Tested with one Chromecast with Google TV and an LG 49UH603V, on macOS and Ubuntu hosts.

## Installation

The plugin is not published on npm. Install it from a clone, in the Homebridge storage
directory (`/var/lib/homebridge` with the official Linux package):

```sh
git clone https://github.com/TheBenBenJ/homebridge-chromecast.git
cd /var/lib/homebridge && npm install /path/to/homebridge-chromecast
```

Set up and start the bridge, with the Chromecast's name as shown in the Google Home app:

```sh
cd /path/to/homebridge-chromecast
python3 -m venv venv
venv/bin/pip install -r bridge/requirements.txt
venv/bin/python bridge/chromecast-bridge.py "Living Room TV"
```

Pair it once, while the bridge runs:

```sh
curl -X POST 127.0.0.1:5052/association -d '{}'                 # a code appears on the TV
curl -X POST 127.0.0.1:5052/association -d '{"code":"ABC123"}'  # the code shown
```

The pairing certificate is stored in `~/.homebridge/chromecast` (home directory of the user
running the bridge), outside the repository, and reused at every start.

Then add the platform to Homebridge's `config.json` and restart Homebridge:

```json
{
  "platform": "Chromecast",
  "nom": "Chromecast"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `nom` | `Chromecast` | Name of the TV in the Home app ("nom" is French for "name"). It also defines the accessory identity: changing it makes HomeKit see a new TV. |

The TV is published as its own accessory, outside the Homebridge bridge: add it in the Home app
with the Homebridge setup code.

### Optional: wake the TV through HDMI-CEC

```sh
venv/bin/python bridge/cec-wake.py <TV MAC address> "<Chromecast name>"
```

and set `"broadcastAdr": "127.0.0.1"` in the homebridge-webos-tv configuration, so that its
wake packet reaches the script. The script listens on UDP port 9: on Linux it needs root or the
`CAP_NET_BIND_SERVICE` capability.

### Running as services

Both scripts must run permanently and be restarted when they exit: the bridge exits on purpose
after 5 minutes without the Chromecast, so that the restart looks it up again. A systemd unit for
the bridge can look like this:

```ini
[Unit]
Description=Chromecast bridge for homebridge-chromecast
After=network-online.target
Wants=network-online.target

[Service]
User=homebridge
Environment=HOME=/var/lib/homebridge
ExecStart=/path/to/venv/bin/python /path/to/homebridge-chromecast/bridge/chromecast-bridge.py "Living Room TV"
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

The wake service is the same with `bridge/cec-wake.py <TV MAC address> "<Chromecast name>"` and
`AmbientCapabilities=CAP_NET_BIND_SERVICE`. On macOS, use a launchd agent with `KeepAlive`.

In the author's installation both run as services on the home server: see the home-server
repository (`docs/operations.md`).

## Operations and troubleshooting

- `curl -s 127.0.0.1:5052/etat` shows the bridge state:
  - `{"etat": "ok", "allume": true, ...}`: connected (`allume` means on);
  - `a_associer`: pairing needed (first start, or pairing removed on the Chromecast): run the two
    pairing commands again;
  - `injoignable`: the Chromecast is not found or does not answer: check that it is powered and
    on the same network as the host, and that mDNS reaches the host.
- Each key press is logged by Homebridge as `iPhone remote key <number>: <key>`.
  `Bridge unreachable (...)` means the bridge is not running.
- The power state in the Home app follows the bridge every 10 s.
- After an IP change the bridge finds the Chromecast again by name, at the latest 5 minutes
  after the connection was lost (it exits and its service restarts it).
- The wake script prints `TV woken up by the Chromecast`, `Chromecast not found` or
  `wake failed: ...`. It reacts at most once every 30 s, only to packets sent from 127.0.0.1
  that carry the configured MAC address.

## Security

- The bridge has no authentication and listens on 127.0.0.1 only. Never expose port 5052:
  anyone reaching it could send keys or pair another remote.
- `cert.pem` and `key.pem` in `~/.homebridge/chromecast` are this remote's credentials for the
  Chromecast. Keep them out of any repository.
- The wake script listens on UDP port 9 on all interfaces (see the design decisions below), but
  only acts on a wake packet for the configured MAC address sent from 127.0.0.1.
- The repository holds no address, MAC address or device name: they are passed as arguments or
  set in `config.json`.

## Design decisions

- **A HomeKit TV.** It is the only accessory type for which iOS shows its Control Center remote.
  The Home app only handles a TV properly when it is published as its own accessory, outside the
  Homebridge bridge, so it is added separately with the setup code.
- **A Python bridge.** The Cast protocol can launch media but cannot send navigation keys; the
  Android TV Remote protocol can. androidtvremote2 is a maintained implementation of it, also
  used by Home Assistant, so the plugin delegates to a small Python process instead of
  reimplementing the pairing and the protocol in Node.js. The bridge keeps one connection open,
  which makes key presses immediate.
- **Loopback HTTP without authentication.** Plugin and bridge run on the same host, and binding
  to 127.0.0.1 keeps the API private without managing a secret.
- **The Chromecast is found by name, not by IP address.** DHCP can give it a new address.
  androidtvremote2 reconnects on its own, but always to the same address, so after 5 minutes
  without the Chromecast the bridge exits and its service manager restarts it, which runs the
  lookup again. This is simpler than rebuilding the connection inside the running process.
- **Power is a toggle, followed by polling.** The remote protocol only has a power toggle key.
  The plugin sends it only when HomeKit asks for the opposite of the known state, and polls the
  bridge every 10 s so that the known state follows the physical remote.
- **Relative volume, and Info opens Home.** The protocol has volume up, down and mute keys but
  no absolute volume, hence relative control (the iPhone volume buttons while the remote is
  open). HomeKit defines no Home key, so Info (and Exit) open the Google TV home screen.
- **French names kept in the contracts.** The HTTP paths, JSON fields and values (`/etat`,
  `/touche`, `allume`, `a_associer`...) and the `nom` config key come from the first version.
  They are shared by the plugin, the bridge and existing configurations, and `nom` also seeds
  the accessory UUID: renaming it would make HomeKit see a new TV and lose its room, scenes and
  automations. `name` is not accepted as an alias either, because Homebridge already uses a
  platform's `name` as its log prefix and an existing configuration may contain one. The Home
  app names ("Son", the speaker) and the pairing error messages are French on purpose: they are
  read by the user.
- **Waking the TV through the Chromecast.** Over Wi-Fi the LG TV ignores Wake-on-LAN (tested on
  2026-10-30). Starting a Cast app makes the Chromecast wake the TV through HDMI-CEC, and quitting
  it right away leaves the TV on. An app that is already open does not trigger CEC again, so it
  is quit first. Pointing homebridge-webos-tv's `broadcastAdr` to 127.0.0.1 redirects its usual
  wake packet to the script, without changing that plugin.
- **Port 9 on all interfaces, filtered by sender.** macOS refuses to bind 127.0.0.1:9 without
  root but accepts 0.0.0.0:9; checking the sender keeps the trigger local. The 30 s cooldown
  absorbs the packets that homebridge-webos-tv repeats until the TV answers.
- **Every Cast object is disconnected after use.** Otherwise pychromecast's thread outlives the
  discovery and loops on an exception: on 2026-10-30 this filled 38 GB of logs.
- **Pairing data lives outside the repository**, so that deploying new code never touches it.

## Bridge HTTP API

The plugin is the only client. Names are French and part of the contract (see above).

| Request | Body | Answer |
| --- | --- | --- |
| `GET /etat` | | `{"etat": "ok", "allume", "app", "volume", "muet"}`, or `{"etat": "a_associer"}` (pairing needed), or `{"etat": "injoignable"}` (unreachable) |
| `POST /touche` | `{"touche": "<key>"}` | `{"ok": true}` when sent and connected; 400 for an unknown key |
| `POST /association` | `{}` shows a code; `{"code": "ABC123"}` completes the pairing | `{"ok": true}`, or `{"ok": false, "erreur": "<message>"}` |

Keys: `haut`, `bas`, `gauche`, `droite` (arrows), `ok`, `retour` (back), `accueil` (home),
`lecture` (play/pause), `muet` (mute), `plus` and `moins` (volume), `marche` (power).

## License

MIT, see [LICENSE](LICENSE).
