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

## Readability Standards (Mandatory, same in every repository)

Full text: `docs/engineering-standards.md` of the `home-server` repository (French → English vocabulary: `docs/decisions.md` of the `dashboard` repository).

1. **Limits**: functions ≤ 60 lines (100 with a comment that says why); lines ≤ 120 characters (100 in the Dashboard's JavaScript); early returns instead of nested `if`; no dead or commented-out code; no history in comments (git and the changelog keep it).
2. **Named structures**: `@dataclass(slots=True)` or `{ key, label }` objects, never `d[0]` or a hand-built nested dict; more than 3 parameters → an options object or keyword-only signature; named constants with their unit for every threshold, delay and size.
3. **Types and docs**: annotated signatures (Python), JSDoc `@typedef` for data shapes (JavaScript); a docstring or JSDoc that says WHY on every module and shared function.
4. **Errors and output**: precise exceptions, never swallowed in silence, `raise … from error`; `logging` instead of `print` outside interactive tools.
5. **Contracts**: a key, path or protocol word read by another program (often French) is never renamed on one side only; produce it from English attributes and read it through English locals.
6. **A readability pass changes no behaviour**: characterization test first, output compared before and after, `grep -rn` every rename across the repository (tools, tests, units, installers), entry points keep their name and command line, no bug fixed in passing (it goes in the report), one commit per module on `refactor/<language>-readability-<module>`, never pushed to `main` without the owner's validation. A new test must fail when the rule it pins is broken.

## Behaviour you must not break

- The remote protocol only has a power toggle: the plugin sends `marche` only when HomeKit asks for the other state, and follows the real state by polling `/etat`.
- A bridge that is down or refuses a key never throws into HomeKit: it is logged.
- The accessory name seeds its UUID (`homebridge-chromecast:<name>`), which is the HomeKit identity; service names and subtypes (`son`, `entree`) are part of it. Changing them creates a new television.

## Operational rules

- **Never push directly to `main`** without the owner's explicit validation: a green push to `main` fast-forwards `production`, which the home server deploys.
- No pairing key, certificate or address in the repository.
