# homebridge-chromecast

Homebridge plugin: a Chromecast with Google TV as a HomeKit television, with its Control Center remote, driven through a local Python bridge (`bridge/`). Overview and setup: [`README.md`](README.md). Agent quick map: [`AGENTS.md`](AGENTS.md).

## Engineering Standards (Mandatory)

1. **Small and readable**: `index.js` has named constants at the top and focused functions, no dependency (Node.js standard library only). The bridge is plain Python 3 over the standard library plus `androidtvremote2` and `pychromecast` (pinned in `bridge/requirements.txt`). Keep the Homebridge entry point `module.exports = (api) => api.registerPlatform(...)`.
2. **100% English technical code**: identifiers, comments, tests, docs and commit messages in English. The French names of the plugin/bridge protocol (`/touche`, `/etat`, `touche`, `allume`, `a_associer`, `injoignable`, the key names such as `haut`, `marche`, `muet`) and the `nom` config key are a contract between `index.js` and `bridge/chromecast-bridge.py`: change them only together, in one commit.
3. **Offline tests required**: every rule or bug fix comes with a test in `test/plugin.test.js` (fake HomeKit, fake bridge through `fetch`, mock clock; no network, no Chromecast, no pairing). The plugin starts a polling interval it never clears: tests always run on a mock clock.
4. **Required checks before every commit**:
   ```sh
   npx --yes @biomejs/biome@2.6.8 check .
   node --test
   python3 -m py_compile bridge/*.py && ruff check bridge && ruff format --check bridge
   ```
   Check that a new test fails when the rule it pins is broken (change the code, watch it fail, restore it).

## Behaviour you must not break

- The remote protocol only has a power toggle: the plugin sends `marche` only when HomeKit asks for the other state, and follows the real state by polling `/etat`.
- A bridge that is down or refuses a key never throws into HomeKit: it is logged.
- The accessory name seeds its UUID (`homebridge-chromecast:<name>`), which is the HomeKit identity; service names and subtypes (`son`, `entree`) are part of it. Changing them creates a new television.

## Operational rules

- **Never push directly to `main`** without the owner's explicit validation: a green push to `main` fast-forwards `production`, which the home server deploys.
- No pairing key, certificate or address in the repository.
