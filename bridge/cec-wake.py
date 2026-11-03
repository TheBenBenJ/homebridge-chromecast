#!/usr/bin/env python3
"""Wake an LG TV through HDMI-CEC when homebridge-webos-tv sends its Wake-on-LAN packet.

Usage: cec-wake.py <TV MAC address> <Chromecast name>

Over Wi-Fi the LG TV ignores Wake-on-LAN (tested on a 49UH603V on 2026-10-30), but the
Chromecast plugged into it can turn it on through HDMI-CEC. homebridge-webos-tv is configured
with "broadcastAdr": "127.0.0.1", so its magic packet arrives here. This script then starts a
Cast app and quits it: the TV wakes up and stays on.
"""
import socket
import sys
import time

import pychromecast

if len(sys.argv) != 3:
    sys.exit("usage: cec-wake.py <TV MAC address> <Chromecast name>")
CHROMECAST_NAME = sys.argv[2]
MAGIC_PACKET = b"\xff" * 6 + bytes.fromhex(sys.argv[1].replace(":", "")) * 16
COOLDOWN_SECONDS = 30  # the webOS plugin repeats its packet until the TV answers
WOL_PORT = 9
CAST_APP_ID = "CC1AD845"  # Google's Default Media Receiver


def wake_tv():
    casts, browser = pychromecast.get_listed_chromecasts(friendly_names=[CHROMECAST_NAME], timeout=8)
    try:
        if not casts:
            print("Chromecast not found", flush=True)
            return
        cast = casts[0]
        cast.wait(timeout=10)
        # An app that is already open does not trigger CEC again, so quit it first.
        # (is_stand_by cannot tell: it is true as soon as the TV sleeps.)
        if not cast.is_idle:
            cast.quit_app()
            time.sleep(5)
        cast.start_app(CAST_APP_ID)
        time.sleep(4)
        cast.quit_app()
        print(time.strftime("%H:%M:%S"), "TV woken up by the Chromecast", flush=True)
    finally:
        # Otherwise the cast's thread outlives discovery and loops on an exception (38 GB of logs on 2026-10-30).
        for cast in casts:
            cast.disconnect(timeout=5)
        browser.stop_discovery()


def main():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    # Bound on all interfaces because macOS refuses this port on 127.0.0.1 without root;
    # hence the filter on the sender below.
    sock.bind(("0.0.0.0", WOL_PORT))
    last_wake = 0
    while True:
        packet, (sender, _) = sock.recvfrom(1024)
        if sender == "127.0.0.1" and packet == MAGIC_PACKET and time.time() - last_wake > COOLDOWN_SECONDS:
            last_wake = time.time()
            try:
                wake_tv()
            except Exception as error:
                print("wake failed:", error, flush=True)


if __name__ == "__main__":
    main()
