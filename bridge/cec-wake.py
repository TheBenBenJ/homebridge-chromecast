#!/usr/bin/env python3
# reveil-cec.py <MAC de la télé> <nom du Chromecast>
# Réveil d'une TV LG : en Wi-Fi elle ignore le Wake-on-LAN (testé sur une 49UH603V le 30/10/2026), mais le Chromecast branché
# dessus la rallume en HDMI-CEC. Le plugin webOS envoie son paquet magique ici (broadcastAdr 127.0.0.1) ; on lance alors une
# appli Cast, puis on la quitte : la télé reste allumée.
import socket
import sys
import time

import pychromecast

if len(sys.argv) != 3:
    sys.exit("usage : reveil-cec.py <MAC de la télé> <nom du Chromecast>")
CHROMECAST = sys.argv[2]
MAGIC = b"\xff" * 6 + bytes.fromhex(sys.argv[1].replace(":", "")) * 16
ATTENTE = 30  # le plugin répète son paquet tant que la télé ne répond pas


def reveiller():
    casts, nav = pychromecast.get_listed_chromecasts(friendly_names=[CHROMECAST], timeout=8)
    try:
        if not casts:
            print("Chromecast introuvable", flush=True)
            return
        cast = casts[0]
        cast.wait(timeout=10)
        if not cast.is_idle:  # une appli déjà ouverte ne redéclenche pas le CEC (is_stand_by ne le dit pas : vrai dès que la télé dort)
            cast.quit_app()
            time.sleep(5)
        cast.start_app("CC1AD845")
        time.sleep(4)
        cast.quit_app()
        print(time.strftime("%H:%M:%S"), "télé réveillée par le Chromecast", flush=True)
    finally:
        for cast in casts:  # sinon son thread survit à la découverte et boucle sur une exception (38 Go de log le 30/10/2026)
            cast.disconnect(timeout=5)
        nav.stop_discovery()


s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("0.0.0.0", 9))  # macOS refuse ce port sur 127.0.0.1 sans être root, d'où le filtre sur l'expéditeur
dernier = 0
while True:
    paquet, (origine, _) = s.recvfrom(1024)
    if origine == "127.0.0.1" and paquet == MAGIC and time.time() - dernier > ATTENTE:
        dernier = time.time()
        try:
            reveiller()
        except Exception as e:
            print("échec du réveil :", e, flush=True)
