# homebridge-chromecast

Turns a Chromecast with Google TV into a HomeKit TV, so the iPhone Control Center remote drives it (arrows, OK, back, home, play/pause, volume). Also wakes an LG TV that ignores Wake-on-LAN over Wi-Fi, through HDMI-CEC.

Un Chromecast avec Google TV devient une télé HomeKit : la télécommande du Centre de contrôle de l'iPhone le pilote. Le dépôt réveille aussi une TV LG qui ignore le Wake-on-LAN en Wi-Fi, par HDMI-CEC.

## Composants

- `index.js` : le plugin Homebridge. Il publie l'accessoire et envoie les touches au pont.
- `pont/chromecast-pont.py` : garde ouverte la connexion Android TV Remote ([androidtvremote2](https://github.com/tronikos/androidtvremote2)) et retrouve le Chromecast par son nom, même si son IP change, sur `127.0.0.1:5052` et sans authentification. Ne l'expose pas sur le réseau.
- `pont/reveil-cec.py` : écoute le paquet magique que `homebridge-webos-tv` envoie à `127.0.0.1` (`broadcastAdr`), lance une appli Cast puis la quitte : la télé se rallume par CEC.

## Installation

Le plugin n'est pas sur npm : installe-le depuis ce dossier.

```sh
python3 -m venv venv && venv/bin/pip install androidtvremote2 pychromecast
venv/bin/python pont/chromecast-pont.py "Chromecast Salon"
curl -X POST 127.0.0.1:5052/association -d '{}'                 # un code s'affiche à l'écran
curl -X POST 127.0.0.1:5052/association -d '{"code":"ABC123"}'
```

Dans la config Homebridge :

```json
{ "platform": "Chromecast", "nom": "Chromecast Salon" }
```

L'accessoire est publié hors du pont : ajoute-le à l'app Maison avec le code de Homebridge.

Réveil CEC, facultatif : `venv/bin/python pont/reveil-cec.py <MAC de la télé> "<nom du Chromecast>"`, avec `"broadcastAdr": "127.0.0.1"` dans la config de `homebridge-webos-tv`. Le certificat d'association reste dans `~/.homebridge/chromecast`, hors du dépôt.

Testé sur un seul appareil, avec un Mac comme hôte. Les deux scripts doivent rester lancés (launchd ou systemd).
