#!/usr/bin/env python3
"""Local bridge between the homebridge-chromecast plugin and a Chromecast with Google TV.

Keeps an Android TV Remote protocol connection open (androidtvremote2) and serves it to the
plugin over HTTP.

Usage: chromecast-bridge.py <Chromecast name>

Keep it running as a service (systemd or launchd, see README). It listens on 127.0.0.1:5052 only
and has no authentication: only the Homebridge plugin talks to it. The pairing certificate and
key live in ~/.homebridge/chromecast, outside the repository.

HTTP API. Paths, field names and values are a contract with index.js and stay in French:
GET  /etat         {"etat": "ok" | "a_associer" | "injoignable", "allume", "app", "volume", "muet"}
                   (a_associer = pairing needed, injoignable = unreachable, allume = on, muet = muted)
POST /touche       {"touche"}: one key name from KEYS
POST /association  {} shows a code on the Chromecast screen, {"code"} completes the pairing
"""
import asyncio
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pychromecast
from androidtvremote2 import AndroidTVRemote, CannotConnect, ConnectionClosed, InvalidAuth

CERT_DIR = Path.home() / ".homebridge/chromecast"
if len(sys.argv) != 2:
    sys.exit("usage: chromecast-bridge.py <Chromecast name>")
CHROMECAST_NAME = sys.argv[1]
PORT = 5052
CLIENT_NAME = "Homebridge Mac"  # name this remote shows on the Chromecast; unchanged so the existing pairing stays as it is
MAX_OUTAGE_SECONDS = 300  # unreachable this long: exit, so that the service manager restarts the bridge, which looks the Chromecast up again (its IP may have changed)
RETRY_SECONDS = 20
DISCOVERY_TIMEOUT_SECONDS = 8
PAIRING_TIMEOUT_SECONDS = 20

# Statuses reported by GET /etat (contract values).
STATUS_OK = "ok"
STATUS_NEEDS_PAIRING = "a_associer"
STATUS_UNREACHABLE = "injoignable"

# Key names accepted by POST /touche (contract values) -> Android TV key codes.
KEYS = {
    "haut": "DPAD_UP",
    "bas": "DPAD_DOWN",
    "gauche": "DPAD_LEFT",
    "droite": "DPAD_RIGHT",
    "ok": "DPAD_CENTER",
    "retour": "BACK",
    "accueil": "HOME",
    "lecture": "MEDIA_PLAY_PAUSE",
    "muet": "VOLUME_MUTE",
    "plus": "VOLUME_UP",
    "moins": "VOLUME_DOWN",
    "marche": "POWER",
}

# Errors returned by POST /association. They are read by the person pairing, so they stay in French.
ERROR_NO_ANSWER = "Le Chromecast ne répond pas."
ERROR_CODE_REJECTED = "Code refusé."

loop = asyncio.new_event_loop()  # androidtvremote2 runs on this loop, in a background thread; HTTP requests are served by other threads
remote = None  # AndroidTVRemote, created once the Chromecast has been found
state = {"status": STATUS_UNREACHABLE}  # "status", plus "reachable" once androidtvremote2 reports it
outage_timer = None


def find_host():
    """Return the Chromecast's IP address, looked up by name on the local network (mDNS), or None."""
    casts, browser = pychromecast.discovery.discover_listed_chromecasts(friendly_names=[CHROMECAST_NAME], discovery_timeout=DISCOVERY_TIMEOUT_SECONDS)
    browser.stop_discovery()
    return casts[0].host if casts else None


def on_availability_changed(available):
    """androidtvremote2 callback: track reachability, and exit after MAX_OUTAGE_SECONDS without the Chromecast."""
    global outage_timer
    state.update(reachable=available)
    if outage_timer:
        outage_timer.cancel()
    # os._exit and not sys.exit: this runs in the event loop thread, and sys.exit would only stop that thread.
    outage_timer = None if available else loop.call_later(MAX_OUTAGE_SECONDS, os._exit, 1)


async def connect():
    """Find the Chromecast and connect, then let androidtvremote2 reconnect on its own.

    Without a valid pairing, stop there and wait for POST /association.
    """
    global remote
    while True:
        host = await asyncio.to_thread(find_host)
        if not host:
            state["status"] = STATUS_UNREACHABLE
            await asyncio.sleep(RETRY_SECONDS)
            continue
        remote = AndroidTVRemote(CLIENT_NAME, str(CERT_DIR / "cert.pem"), str(CERT_DIR / "key.pem"), host, loop=loop)
        await remote.async_generate_cert_if_missing()
        try:
            await remote.async_connect()
        except InvalidAuth:
            state["status"] = STATUS_NEEDS_PAIRING
            return
        except (CannotConnect, ConnectionClosed):
            state["status"] = STATUS_UNREACHABLE
            await asyncio.sleep(RETRY_SECONDS)
            continue
        state["status"] = STATUS_OK
        remote.add_is_available_updated_callback(on_availability_changed)
        remote.keep_reconnecting(lambda: state.update(status=STATUS_NEEDS_PAIRING))
        return


async def finish_pairing(code):
    await remote.async_finish_pairing(code)
    await connect()


def run_in_loop(coro, timeout=PAIRING_TIMEOUT_SECONDS):
    """Run a coroutine on the bridge's event loop from an HTTP thread, and wait for its result."""
    return asyncio.run_coroutine_threadsafe(coro, loop).result(timeout)


def read_state():
    """Body of GET /etat."""
    if state["status"] != STATUS_OK or not state.get("reachable", True):
        return {"etat": STATUS_UNREACHABLE if state["status"] == STATUS_OK else state["status"]}
    volume = remote.volume_info or {}
    return {"etat": STATUS_OK, "allume": remote.is_on, "app": remote.current_app, "volume": volume.get("level"), "muet": volume.get("muted")}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # no line per request: the plugin polls GET /etat every 10 s

    def reply(self, body, status=200):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/etat":
            self.reply(read_state())
        else:
            self.reply({"ok": False}, 404)

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except ValueError:
            return self.reply({"ok": False}, 400)
        if self.path == "/touche":
            return self.post_key(body)
        if self.path == "/association":
            return self.post_pairing(body)
        self.reply({"ok": False}, 404)

    def post_key(self, body):
        key = KEYS.get(body.get("touche"))
        if not key:
            return self.reply({"ok": False}, 400)
        if remote is None:
            return self.reply({"ok": False})
        try:
            loop.call_soon_threadsafe(remote.send_key_command, key)
        except (ConnectionClosed, RuntimeError):
            return self.reply({"ok": False})
        return self.reply({"ok": read_state()["etat"] == STATUS_OK})

    def post_pairing(self, body):
        if remote is None:
            return self.reply({"ok": False, "erreur": ERROR_NO_ANSWER})
        try:
            run_in_loop(finish_pairing(str(body["code"]).strip()) if body.get("code") else remote.async_start_pairing())
        except InvalidAuth:
            return self.reply({"ok": False, "erreur": ERROR_CODE_REJECTED})
        except (CannotConnect, ConnectionClosed, TimeoutError):
            return self.reply({"ok": False, "erreur": ERROR_NO_ANSWER})
        return self.reply({"ok": True})


def main():
    CERT_DIR.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=loop.run_forever, daemon=True).start()
    asyncio.run_coroutine_threadsafe(connect(), loop)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
