'use strict';

/*
 * homebridge-chromecast
 *
 * Publishes a Chromecast with Google TV as a HomeKit television. iOS then offers its Control
 * Center remote for it, and every key press is forwarded to the local Python bridge
 * (bridge/chromecast-bridge.py), which keeps an Android TV Remote connection open.
 *
 * Contract with the bridge. The French names are historical and part of the protocol: change
 * them only together with bridge/chromecast-bridge.py.
 *   POST /touche {"touche": "<key name>"}  ->  {"ok": true | false}
 *   GET  /etat                              ->  {"etat": "ok" | "a_associer" | "injoignable", "allume": true | false, ...}
 */

const PLUGIN_NAME = 'homebridge-chromecast';
const PLATFORM_NAME = 'Chromecast';
const DEFAULT_NAME = 'Chromecast';
const BRIDGE_URL = 'http://127.0.0.1:5052';
const REQUEST_TIMEOUT_MS = 3000;
const STATE_POLL_INTERVAL_MS = 10000;

/**
 * Forwards one key to the bridge. Never throws: a failure is only logged.
 * Key names: haut/bas/gauche/droite = up/down/left/right, retour = back, accueil = home,
 * lecture = play/pause, muet = mute, plus/moins = volume up/down, marche = power.
 */
async function sendKey(key, log) {
  try {
    const response = await fetch(`${BRIDGE_URL}/touche`, {
      method: 'POST',
      body: JSON.stringify({ touche: key }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!(await response.json()).ok) {
      log.warn(`Key ${key} not delivered`);
    }
  } catch (error) {
    log.warn(`Bridge unreachable (${key}): ${error.message}`);
  }
}

class ChromecastPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    api.on('didFinishLaunching', () => this.publish());
  }

  /**
   * Builds the television accessory and publishes it outside the Homebridge bridge: the Home app
   * only handles a television properly as its own accessory, added with the Homebridge setup code.
   */
  publish() {
    const { Service, Characteristic, Categories, uuid } = this.api.hap;
    const log = this.log;
    // "nom" is the historical config key for the name. The name also seeds the accessory UUID,
    // which is the HomeKit identity: changing the formula or the name creates a new television.
    const name = this.config.nom || DEFAULT_NAME;
    const accessory = new this.api.platformAccessory(name, uuid.generate(`${PLUGIN_NAME}:${name}`), Categories.TELEVISION);

    // Last known power state. The remote protocol only has a power toggle, so the plugin sends it
    // only when HomeKit asks for the other state, and polls the bridge to follow the real state.
    let isOn = false;

    const tv = accessory.addService(Service.Television, name);
    tv.setCharacteristic(Characteristic.ConfiguredName, name)
      .setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE)
      .setCharacteristic(Characteristic.ActiveIdentifier, 1);
    tv.getCharacteristic(Characteristic.Active)
      .onGet(() => (isOn ? 1 : 0))
      .onSet(async (value) => {
        if (!!value !== isOn) {
          isOn = !!value;
          await sendKey('marche', log);
        }
      });
    tv.getCharacteristic(Characteristic.ActiveIdentifier).onSet(() => {});

    // Control Center remote keys -> bridge key names. HomeKit defines no Home key, so Info (and
    // Exit) open the Google TV home screen. Other keys are logged and ignored.
    const RemoteKey = Characteristic.RemoteKey;
    const remoteKeys = {
      [RemoteKey.ARROW_UP]: 'haut',
      [RemoteKey.ARROW_DOWN]: 'bas',
      [RemoteKey.ARROW_LEFT]: 'gauche',
      [RemoteKey.ARROW_RIGHT]: 'droite',
      [RemoteKey.SELECT]: 'ok',
      [RemoteKey.BACK]: 'retour',
      [RemoteKey.EXIT]: 'accueil',
      [RemoteKey.INFORMATION]: 'accueil',
      [RemoteKey.PLAY_PAUSE]: 'lecture',
    };
    tv.getCharacteristic(Characteristic.RemoteKey).onSet((value) => {
      log.info(`iPhone remote key ${value}: ${remoteKeys[value] || 'ignored'}`);
      if (remoteKeys[value]) {
        sendKey(remoteKeys[value], log);
      }
    });

    // Volume: the remote protocol only has volume up/down/mute keys, hence relative control
    // (the iPhone volume buttons while the remote is open). Service name and subtype are part of
    // the accessory identity: keep them.
    const speaker = accessory.addService(Service.TelevisionSpeaker, `${name} Son`, 'son');
    speaker.setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
      .setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.RELATIVE);
    speaker.getCharacteristic(Characteristic.Mute)
      .onGet(() => false)
      .onSet(() => sendKey('muet', log));
    speaker.getCharacteristic(Characteristic.VolumeSelector).onSet((value) => {
      log.info(`iPhone volume ${value}`);
      sendKey(value === Characteristic.VolumeSelector.INCREMENT ? 'plus' : 'moins', log);
    });
    tv.addLinkedService(speaker);

    // A single input source, the Chromecast itself (ActiveIdentifier 1).
    const input = accessory.addService(Service.InputSource, 'Chromecast', 'entree');
    input.setCharacteristic(Characteristic.Identifier, 1)
      .setCharacteristic(Characteristic.ConfiguredName, 'Chromecast')
      .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
      .setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.HDMI)
      .setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);
    tv.addLinkedService(input);

    // Follow power changes made elsewhere, for example with the physical remote.
    setInterval(async () => {
      try {
        const state = await (await fetch(`${BRIDGE_URL}/etat`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })).json();
        if (state.etat === 'ok' && state.allume != null && state.allume !== isOn) {
          isOn = state.allume;
          tv.updateCharacteristic(Characteristic.Active, isOn ? 1 : 0);
        }
      } catch {
        // Bridge down: its service manager restarts it. Keep the last known state meanwhile.
      }
    }, STATE_POLL_INTERVAL_MS);

    this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
  }
}

module.exports = (api) => api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, ChromecastPlatform);
