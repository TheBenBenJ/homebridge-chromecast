# AGENTS.md — homebridge-chromecast

Quick reference for coding agents working in this repository. Rules: [`CLAUDE.md`](CLAUDE.md); setup and behaviour: [`README.md`](README.md).

## Layout

| Path | Role |
|---|---|
| `index.js` | The plugin: `ChromecastPlatform` publishes the television (remote keys, volume, power, one input) and follows its state. |
| `bridge/chromecast-bridge.py` | Local HTTP bridge (`/touche`, `/etat`, pairing) holding the Android TV Remote connection. |
| `bridge/cec-wake.py` | HDMI-CEC wake-up helper. |
| `bridge/requirements.txt` | Pinned Python dependencies of the bridge. |
| `config.schema.json` | Settings shown in the Homebridge UI. |
| `test/plugin.test.js` | Offline tests (`node --test`): fake HomeKit, fake bridge, mock clock. |
| `biome.json`, `pyproject.toml` | Lint and format rules (Biome 2.6.8 through `npx`; Ruff for the bridge). |
| `.github/workflows/ci.yml` | Checks, then promotion of `main` to `production`. |

## Verification Commands

```sh
npx --yes @biomejs/biome@2.6.8 check .
node --test
python3 -m py_compile bridge/*.py && ruff check bridge && ruff format --check bridge
```

## Deployment

A green push to `main` moves `production`, which the home server's deployer pulls and applies. Agents never push to `main` without the owner's validation.
