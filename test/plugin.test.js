'use strict';

// Offline tests: no Homebridge, no Chromecast, no bridge process. A fake HomeKit (services, characteristics, accessory)
// records what the plugin builds, a fake `fetch` plays the Python bridge, and node's mock timers drive the state polling.
// Run: npm test (node --test).

const assert = require('node:assert/strict');
const { afterEach, beforeEach, describe, mock, test } = require('node:test');

class FakeCharacteristic {
  onGet(handler) {
    this.getter = handler;
    return this;
  }
  onSet(handler) {
    this.setter = handler;
    return this;
  }
}

class FakeService {
  constructor(name, subtype) {
    this.name = name;
    this.subtype = subtype;
    this.characteristics = new Map();
    this.values = new Map();
    this.updates = [];
    this.linked = [];
  }
  getCharacteristic(characteristic) {
    if (!this.characteristics.has(characteristic)) this.characteristics.set(characteristic, new FakeCharacteristic());
    return this.characteristics.get(characteristic);
  }
  setCharacteristic(characteristic, value) {
    this.values.set(characteristic, value);
    return this;
  }
  updateCharacteristic(characteristic, value) {
    this.updates.push([characteristic, value]);
    return this;
  }
  addLinkedService(service) {
    this.linked.push(service);
    return this;
  }
}

class FakeAccessory {
  constructor(name, uuid, category) {
    Object.assign(this, { name, uuid, category, services: [] });
  }
  addService(type, name, subtype) {
    const service = new FakeService(name, subtype);
    service.type = type;
    this.services.push(service);
    return service;
  }
}

// Any characteristic or constant the plugin reads: a stable string named after it, e.g. RemoteKey.ARROW_UP.
const constants = new Map();
const Characteristic = new Proxy(
  {},
  {
    get: (_, name) => {
      if (!constants.has(name)) {
        constants.set(
          name,
          new Proxy(
            { toString: () => name },
            { get: (target, key) => (key in target ? target[key] : `${name}.${String(key)}`) },
          ),
        );
      }
      return constants.get(name);
    },
  },
);

function makePlatform(config = {}) {
  let registered;
  const handlers = {};
  const published = [];
  const api = {
    hap: {
      Service: { Television: 'Television', TelevisionSpeaker: 'TelevisionSpeaker', InputSource: 'InputSource' },
      Characteristic,
      Categories: { TELEVISION: 'TELEVISION' },
      uuid: { generate: (seed) => `uuid(${seed})` },
    },
    platformAccessory: FakeAccessory,
    on: (event, handler) => {
      handlers[event] = handler;
    },
    publishExternalAccessories: (plugin, accessories) => published.push({ plugin, accessories }),
    registerPlatform: (name, alias, platformClass) => {
      registered = { name, alias, platformClass };
    },
  };
  require('../index.js')(api);
  const warnings = [];
  const log = { info: () => {}, debug: () => {}, warn: (m) => warnings.push(m) };
  const platform = new registered.platformClass(log, config, api);
  return { platform, registered, handlers, published, warnings };
}

function publish(config) {
  const made = makePlatform(config);
  made.handlers.didFinishLaunching();
  const accessory = made.published[0].accessories[0];
  const [tv, speaker] = accessory.services;
  return { ...made, accessory, tv, speaker };
}

let requests;
function fakeBridge({ keyAnswer = { ok: true }, state = { etat: 'ok', allume: false }, down = false } = {}) {
  requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (down) throw new Error('connection refused');
    return { json: async () => (url.endsWith('/etat') ? state : keyAnswer) };
  };
}

const realFetch = globalThis.fetch;
// The plugin starts a 10 s polling interval it never clears: always run on a mock clock, or the process would not end.
beforeEach(() => mock.timers.enable({ apis: ['setInterval'] }));
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
});
const flush = () => new Promise((resolve) => setImmediate(resolve));
const keysSent = () => requests.filter((r) => r.url.endsWith('/touche')).map((r) => JSON.parse(r.options.body).touche);

describe('registration and identity', () => {
  test('keeps the plugin name and the platform alias', () => {
    const { registered } = makePlatform();
    assert.equal(registered.name, 'homebridge-chromecast');
    assert.equal(registered.alias, 'Chromecast');
  });

  test('the television is published outside the bridge once Homebridge has launched, UUID seeded by plugin and name', () => {
    fakeBridge();
    const { published, accessory } = publish();
    assert.equal(published.length, 1);
    assert.equal(published[0].plugin, 'homebridge-chromecast');
    assert.equal(accessory.category, 'TELEVISION');
    assert.equal(accessory.name, 'Chromecast');
    assert.equal(accessory.uuid, 'uuid(homebridge-chromecast:Chromecast)');
  });

  test('the historical config key "nom" renames the television and its identity', () => {
    fakeBridge();
    const { accessory } = publish({ nom: 'Salon' });
    assert.equal(accessory.name, 'Salon');
    assert.equal(accessory.uuid, 'uuid(homebridge-chromecast:Salon)');
  });

  test('one speaker service named after the television, one HDMI input with identifier 1', () => {
    fakeBridge();
    const { accessory, tv, speaker } = publish({ nom: 'Salon' });
    assert.equal(speaker.name, 'Salon Son');
    assert.equal(speaker.subtype, 'son');
    const input = accessory.services.find((service) => service.type === 'InputSource');
    assert.equal(input.subtype, 'entree');
    assert.equal(input.values.get(Characteristic.Identifier), 1);
    assert.deepEqual(tv.linked, [speaker, input]);
  });
});

describe('remote keys', () => {
  const press = async (tv, key) => {
    tv.getCharacteristic(Characteristic.RemoteKey).setter(key);
    await flush();
  };

  test('Control Center keys are forwarded to the bridge with its key names', async () => {
    fakeBridge();
    const { tv } = publish();
    const { RemoteKey } = Characteristic;
    const expected = [
      [RemoteKey.ARROW_UP, 'haut'],
      [RemoteKey.ARROW_DOWN, 'bas'],
      [RemoteKey.ARROW_LEFT, 'gauche'],
      [RemoteKey.ARROW_RIGHT, 'droite'],
      [RemoteKey.SELECT, 'ok'],
      [RemoteKey.BACK, 'retour'],
      [RemoteKey.EXIT, 'accueil'],
      [RemoteKey.INFORMATION, 'accueil'],
      [RemoteKey.PLAY_PAUSE, 'lecture'],
    ];
    for (const [homekitKey] of expected) await press(tv, homekitKey);
    assert.deepEqual(
      keysSent(),
      expected.map(([, bridgeKey]) => bridgeKey),
    );
    assert.equal(requests[0].url, 'http://127.0.0.1:5052/touche');
    assert.equal(requests[0].options.method, 'POST');
  });

  test('a key HomeKit offers but the plugin does not map is ignored', async () => {
    fakeBridge();
    const { tv } = publish();
    await press(tv, Characteristic.RemoteKey.NEXT_TRACK);
    assert.deepEqual(keysSent(), []);
  });

  test('volume buttons and mute', async () => {
    fakeBridge();
    const { speaker } = publish();
    const { VolumeSelector } = Characteristic;
    speaker.getCharacteristic(VolumeSelector).setter(VolumeSelector.INCREMENT);
    speaker.getCharacteristic(VolumeSelector).setter(VolumeSelector.DECREMENT);
    await speaker.getCharacteristic(Characteristic.Mute).setter(true);
    await flush();
    assert.deepEqual(keysSent(), ['plus', 'moins', 'muet']);
  });

  test('a bridge that is down or refuses a key never throws, it only logs', async () => {
    fakeBridge({ down: true });
    const down = publish();
    await down.speaker.getCharacteristic(Characteristic.Mute).setter(true);
    assert.match(down.warnings.join(), /Bridge unreachable \(muet\): connection refused/);

    fakeBridge({ keyAnswer: { ok: false } });
    const refused = publish();
    await refused.speaker.getCharacteristic(Characteristic.Mute).setter(true);
    assert.match(refused.warnings.join(), /Key muet not delivered/);
  });
});

describe('power', () => {
  test('the power toggle is only sent when HomeKit asks for the other state', async () => {
    fakeBridge();
    const { tv } = publish();
    const active = tv.getCharacteristic(Characteristic.Active);
    assert.equal(active.getter(), 0);
    await active.setter(1);
    assert.equal(active.getter(), 1);
    await active.setter(1);
    assert.deepEqual(keysSent(), ['marche']);
    await active.setter(0);
    assert.deepEqual(keysSent(), ['marche', 'marche']);
    assert.equal(active.getter(), 0);
  });

  test('power changes made elsewhere are followed by polling the bridge every 10 seconds', async () => {
    fakeBridge({ state: { etat: 'ok', allume: true } });
    const { tv } = publish();
    const active = tv.getCharacteristic(Characteristic.Active);
    mock.timers.tick(10000);
    await flush();
    assert.equal(requests.at(-1).url, 'http://127.0.0.1:5052/etat');
    assert.equal(active.getter(), 1);
    assert.deepEqual(tv.updates.at(-1), [Characteristic.Active, 1]);
  });

  test('an unreachable or unpaired bridge keeps the last known state', async () => {
    fakeBridge({ state: { etat: 'a_associer', allume: true } });
    const { tv } = publish();
    mock.timers.tick(10000);
    await flush();
    assert.equal(tv.getCharacteristic(Characteristic.Active).getter(), 0);
    fakeBridge({ down: true });
    mock.timers.tick(10000);
    await flush();
    assert.equal(tv.getCharacteristic(Characteristic.Active).getter(), 0);
  });
});
