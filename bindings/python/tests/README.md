# Python binding contract suite

These tests treat the documented WebSocket messages as the compatibility
boundary. The fake server intentionally does not import or mimic the Node
implementation, and it does not echo unknown request fields. A client must
therefore handle `serverInfo`, `spawned`, `sessionList`, `joined`, and error
messages exactly as a real lit-shell server sends them.

Run the deterministic contract and packaging suite from this directory:

```console
python -m pip install -e '.[dev]'
python -m pytest -m 'not node_e2e'
```

The Node E2E fixture launches the built `dist/server` entry point on an
ephemeral loopback port and controls a real `/bin/sh` PTY:

```console
cd ../..
npm ci
npm run build
cd bindings/python
python -m pytest -m node_e2e
```

The E2E test skips only when Node or the built server entry point is absent.
