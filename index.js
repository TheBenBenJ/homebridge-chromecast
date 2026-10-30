// Chromecast en télé HomeKit : iOS propose alors sa télécommande du Centre de contrôle, et ses touches partent vers chromecast-pont.py.
const PLUGIN = 'homebridge-chromecast', PLATEFORME = 'Chromecast', PONT = 'http://127.0.0.1:5052';

async function touche(nom, log) {
  try {
    const r = await fetch(`${PONT}/touche`, { method: 'POST', body: JSON.stringify({ touche: nom }), signal: AbortSignal.timeout(3000) });
    if (!(await r.json()).ok) log.warn(`Touche ${nom} non transmise`);
  } catch (e) { log.warn(`Pont injoignable (${nom}) : ${e.message}`); }
}

class Chromecast {
  constructor(log, config, api) {
    this.log = log; this.config = config; this.api = api;
    api.on('didFinishLaunching', () => this.publier());
  }

  publier() {
    const { Service: S, Characteristic: C, Categories, uuid } = this.api.hap, nom = this.config.nom || 'Chromecast', log = this.log;
    const acc = new this.api.platformAccessory(nom, uuid.generate(`${PLUGIN}:${nom}`), Categories.TELEVISION);
    const tv = acc.addService(S.Television, nom);
    let allume = false;
    tv.setCharacteristic(C.ConfiguredName, nom).setCharacteristic(C.SleepDiscoveryMode, C.SleepDiscoveryMode.ALWAYS_DISCOVERABLE).setCharacteristic(C.ActiveIdentifier, 1);
    tv.getCharacteristic(C.Active).onGet(() => (allume ? 1 : 0)).onSet(async v => { if (!!v !== allume) { allume = !!v; await touche('marche', log); } });
    tv.getCharacteristic(C.ActiveIdentifier).onSet(() => {});
    const touches = { [C.RemoteKey.ARROW_UP]: 'haut', [C.RemoteKey.ARROW_DOWN]: 'bas', [C.RemoteKey.ARROW_LEFT]: 'gauche', [C.RemoteKey.ARROW_RIGHT]: 'droite', [C.RemoteKey.SELECT]: 'ok',
      [C.RemoteKey.BACK]: 'retour', [C.RemoteKey.EXIT]: 'accueil', [C.RemoteKey.INFORMATION]: 'accueil', [C.RemoteKey.PLAY_PAUSE]: 'lecture' };
    tv.getCharacteristic(C.RemoteKey).onSet(v => { log.info(`Touche iPhone ${v} : ${touches[v] || 'ignorée'}`); if (touches[v]) touche(touches[v], log); });
    const son = acc.addService(S.TelevisionSpeaker, `${nom} Son`, 'son');
    son.setCharacteristic(C.Active, C.Active.ACTIVE).setCharacteristic(C.VolumeControlType, C.VolumeControlType.RELATIVE);
    son.getCharacteristic(C.Mute).onGet(() => false).onSet(() => touche('muet', log));
    son.getCharacteristic(C.VolumeSelector).onSet(v => { log.info(`Volume iPhone ${v}`); touche(v === C.VolumeSelector.INCREMENT ? 'plus' : 'moins', log); });
    tv.addLinkedService(son);
    const entree = acc.addService(S.InputSource, 'Chromecast', 'entree');
    entree.setCharacteristic(C.Identifier, 1).setCharacteristic(C.ConfiguredName, 'Chromecast').setCharacteristic(C.IsConfigured, C.IsConfigured.CONFIGURED)
      .setCharacteristic(C.InputSourceType, C.InputSourceType.HDMI).setCharacteristic(C.CurrentVisibilityState, C.CurrentVisibilityState.SHOWN);
    tv.addLinkedService(entree);
    setInterval(async () => {
      try {
        const e = await (await fetch(`${PONT}/etat`, { signal: AbortSignal.timeout(3000) })).json();
        if (e.etat === 'ok' && e.allume != null && e.allume !== allume) { allume = e.allume; tv.updateCharacteristic(C.Active, allume ? 1 : 0); }
      } catch (e) { /* pont arrêté : launchd le relance */ }
    }, 10000);
    this.api.publishExternalAccessories(PLUGIN, [acc]);
  }
}

module.exports = api => api.registerPlatform(PLUGIN, PLATEFORME, Chromecast);
