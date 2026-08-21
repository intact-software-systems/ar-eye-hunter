# Asset Pipeline Decision

Last reviewed: 2026-05-18.

## Decision

Relic Hunters stays **procedural-first** for the active gameplay scene.

Imported glTF assets are deferred until there is a dedicated hybrid asset
boundary with measured performance headroom, procedural fallbacks, and approved
asset conventions. The next useful asset work is not to drop in models; it is
to continue reducing scene cost through cross-room instancing/shared geometry
and then prototype one non-authoritative visual replacement behind a fallback.

## Rationale

- The procedural castle kit, room identity pass, tactical camera, avatar
  presentation, and lighting presets are now covered by focused tests and
  browser scene baselines.
- The current Babylon chunk is already large. Adding gameplay-critical imported
  assets before code-splitting and scene-cost work would increase load and
  failure risk.
- Headless scene metrics show the full-map visual state is the current pressure
  point: many meshes, particle systems, and draw calls. Imported modular assets
  would not automatically reduce that cost unless they replace repeated
  geometry with a controlled instancing/LOD plan.
- No approved modular glTF set exists yet for room pieces, avatars, or relics.

## Current Measurements

Latest production build command:

```text
npm --workspace relic-hunters-v1 run build
```

Latest bundle output:

| Chunk                          |    Minified |      Gzip |
| ------------------------------ | ----------: | --------: |
| `index.html`                   |     0.61 kB |   0.33 kB |
| `index-DbC1_Eew.css`           |    49.75 kB |  11.16 kB |
| `rolldown-runtime-S-ySWqyJ.js` |     0.69 kB |   0.42 kB |
| `react-DyDP3OYo.js`            |   189.63 kB |  59.64 kB |
| `index-uRfbuj3f.js`            |   994.08 kB | 248.41 kB |
| `babylon-B8w6Ezoi.js`          | 3,074.74 kB | 692.72 kB |

Latest scene baseline metrics are written to:

```text
baseline/screenshots/scene-upgrades/scene-upgrade-metrics.json
```

Headless Chromium metrics from the latest baseline writer after the S10 event
cue budget and draw-call metric reset:

| Scenario                       | Pipeline   | Lighting | Meshes | Active | Materials | Particles | Active FX | Active Lights | Static Batches | Batched Meshes | Effects | Effect Meshes | Draw Calls |  Ready |
| ------------------------------ | ---------- | -------- | -----: | -----: | --------: | --------: | --------: | ------------: | -------------: | -------------: | ------: | ------------: | ---------: | -----: |
| opening desktop                | procedural | day      |     37 |      0 |         5 |         0 |         0 |             0 |              0 |              0 |       0 |             0 |        n/a |   8 ms |
| lobby desktop                  | procedural | day      |     37 |      0 |         5 |         0 |         0 |             0 |              0 |              0 |       0 |             0 |        n/a |   9 ms |
| planning desktop               | procedural | day      |    352 |    157 |        44 |        12 |         9 |             9 |             47 |            550 |       0 |             0 |        181 |  60 ms |
| planning mobile                | procedural | day      |    352 |     75 |        44 |        12 |         9 |             9 |             47 |            550 |       0 |             0 |         98 |  64 ms |
| waiting locked desktop         | procedural | day      |    303 |    114 |        47 |         6 |         6 |             6 |             23 |            270 |       0 |             0 |        135 |  38 ms |
| split party identities desktop | procedural | day      |    665 |    403 |        63 |        28 |        21 |            18 |             94 |          1,095 |       0 |             0 |        803 | 125 ms |
| resolved timeline desktop      | procedural | lantern  |    352 |    161 |        44 |        12 |         9 |             9 |             47 |            550 |       0 |             0 |        392 |  59 ms |
| finished desktop               | procedural | sunset   |    343 |    130 |        48 |        10 |         7 |             6 |             35 |            403 |       0 |             0 |        248 |  52 ms |

These browser numbers are smoke metrics, not lab-grade performance data. They
are still useful because they show the full-map visual state is still the
pressure point. S8 reduced particle-system totals and added active
particle/light budgets. S9 merged static per-room procedural meshes by material
while leaving clue, resolved, and action meshes separate. S10 resets the private
Babylon draw-call counter per rendered frame and records active scene effects,
which showed the old resolved-timeline spike was a cumulative metric artifact
rather than lingering effect meshes.

## Future Hybrid Gate

Imported glTF assets can be reconsidered when all of these are true:

- Production scene code is split so Babylon and optional asset loaders do not
  inflate unrelated app paths.
- Full-map baseline metrics have been reduced or bounded through instancing,
  particle budgets, active light budgets, and shared mesh/material reuse.
- A candidate asset set is approved with license, scale, origin, naming, and
  material conventions documented.
- The asset loader has a procedural fallback and a browser test that covers
  both loaded and failed-load paths.
- Imported assets are non-authoritative: they never own room ids, movement
  legality, relic visibility, or score state.

## Proposed Asset Structure

When the hybrid path opens, use:

```text
public/models/
    rooms/<room-role>/<piece>.glb
    avatars/<character-or-role>.glb
    relics/<relic-id>.glb
    effects/<effect-name>.glb
```

Each asset needs a sidecar note or manifest entry with:

- source URL, license, author, and local edits
- intended fallback procedural builder
- unit scale and local pivot/origin
- material role mapping to the visual palette
- expected compressed size and measured scene impact

## Follow-Up Work

- A follow-up scene-cost pass should focus on cross-room thin instances/shared
  geometry for repeated kit pieces after per-instance room picking is designed.
- Iteration 15 should code-split the disabled intro scene and any future
  optional glTF loader path.
- A later hybrid prototype can replace one non-critical visual set, such as
  banner/lantern variants or avatar skins, before replacing gameplay room
  shells.
