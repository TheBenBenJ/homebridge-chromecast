#!/usr/bin/env python3
"""Pont vers le Chromecast : garde ouverte la connexion du protocole de télécommande Android TV (androidtvremote2).

chromecast-pont.py <IP du Chromecast>. À garder lancé (launchd, voir README), sur 127.0.0.1:5052 seulement : aucune authentification, seul le plugin Homebridge
homebridge-chromecast lui parle. Le certificat de l'association reste dans ~/.homebridge/chromecast.

GET  /etat         {"etat": "ok" | "a_associer" | "injoignable", "allume", "app", "volume", "muet"}
POST /touche       {"touche"} : une touche de la liste TOUCHES
POST /association  {} montre un code sur l'écran du Chromecast, {"code"} termine l'association
"""
import asyncio, json, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from androidtvremote2 import AndroidTVRemote, CannotConnect, ConnectionClosed, InvalidAuth

DOSSIER = Path.home() / ".homebridge/chromecast"
if len(sys.argv) != 2:
    sys.exit("usage : chromecast-pont.py <IP du Chromecast>")
HOTE = sys.argv[1]
PORT = 5052
TOUCHES = {"haut": "DPAD_UP", "bas": "DPAD_DOWN", "gauche": "DPAD_LEFT", "droite": "DPAD_RIGHT", "ok": "DPAD_CENTER", "retour": "BACK", "accueil": "HOME",
           "lecture": "MEDIA_PLAY_PAUSE", "muet": "VOLUME_MUTE", "plus": "VOLUME_UP", "moins": "VOLUME_DOWN", "marche": "POWER"}

boucle = asyncio.new_event_loop()
tele = AndroidTVRemote("Homebridge Mac", str(DOSSIER / "cert.pem"), str(DOSSIER / "key.pem"), HOTE, loop=boucle)
etat = {"etat": "injoignable"}


async def connecter():
    """Se connecte, puis laisse la bibliothèque se reconnecter seule ; sans association valable, attend POST /association."""
    await tele.async_generate_cert_if_missing()
    while True:
        try:
            await tele.async_connect()
        except InvalidAuth:
            etat["etat"] = "a_associer"
            return
        except (CannotConnect, ConnectionClosed):
            etat["etat"] = "injoignable"
            await asyncio.sleep(20)
            continue
        etat["etat"] = "ok"
        tele.add_is_available_updated_callback(lambda dispo: etat.update(joignable=dispo))
        tele.keep_reconnecting(lambda: etat.update(etat="a_associer"))
        return


async def terminer_association(code):
    await tele.async_finish_pairing(code)
    await connecter()


def attendre(coro, delai=20):
    return asyncio.run_coroutine_threadsafe(coro, boucle).result(delai)


def lire_etat():
    if etat["etat"] != "ok" or not etat.get("joignable", True):
        return {"etat": "injoignable" if etat["etat"] == "ok" else etat["etat"]}
    v = tele.volume_info or {}
    return {"etat": "ok", "allume": tele.is_on, "app": tele.current_app, "volume": v.get("level"), "muet": v.get("muted")}


class Gestion(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def repondre(self, corps, code=200):
        data = json.dumps(corps, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.repondre(lire_etat() if self.path == "/etat" else {"ok": False}, 200 if self.path == "/etat" else 404)

    def do_POST(self):
        try:
            d = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except ValueError:
            return self.repondre({"ok": False}, 400)
        if self.path == "/touche":
            touche = TOUCHES.get(d.get("touche"))
            if not touche:
                return self.repondre({"ok": False}, 400)
            try:
                boucle.call_soon_threadsafe(tele.send_key_command, touche)
            except (ConnectionClosed, RuntimeError):
                return self.repondre({"ok": False})
            return self.repondre({"ok": lire_etat()["etat"] == "ok"})
        if self.path == "/association":
            try:
                attendre(terminer_association(str(d["code"]).strip()) if d.get("code") else tele.async_start_pairing())
            except InvalidAuth:
                return self.repondre({"ok": False, "erreur": "Code refusé."})
            except (CannotConnect, ConnectionClosed, TimeoutError):
                return self.repondre({"ok": False, "erreur": "Le Chromecast ne répond pas."})
            return self.repondre({"ok": True})
        self.repondre({"ok": False}, 404)


if __name__ == "__main__":
    DOSSIER.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=boucle.run_forever, daemon=True).start()
    asyncio.run_coroutine_threadsafe(connecter(), boucle)
    ThreadingHTTPServer(("127.0.0.1", PORT), Gestion).serve_forever()
