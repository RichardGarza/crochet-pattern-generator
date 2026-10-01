# Claude Design fixtures

Real output captured from claude.ai/design ("3D object" template, Opus 5.5) on 2026-09-30.

- `teddy-bear.crochet-model.json` — the `<script type="application/json" id="crochet-model">` spec Claude Design embedded in its teddy bear page (17 primitive parts), printed verbatim in chat.

Observed facts (Claude Design's real output, not guesses):
- It honoured the embedded-JSON request and built the model from that JSON at runtime.
- Its own field conventions: `dimensions` uses `rx/ry/rz` (ellipsoid), `r` (sphere), `radius` + `length` (capsule; length = straight section between caps); child `position`/`rotationDeg` are **relative to the parent**; it added `axes` and `palette` (hex -> name) keys on its own.
- The page ships "Download OBJ + MTL" and "Download GLB" buttons.
- The preview is served from a token-gated `*.claudeusercontent.com` origin, so the app can't fetch it; the user must download/export the file and import it.

The importer must accept this dialect as well as our canonical schema.
