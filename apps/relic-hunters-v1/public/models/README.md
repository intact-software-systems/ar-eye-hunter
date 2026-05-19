# Future GLB Models

The active Relic Hunters scene currently uses the procedural castle kit. Do not
drop gameplay-critical GLB files here and expect them to load automatically.
The S7 asset decision keeps the game procedural-first until a measured hybrid
asset boundary is implemented.

When imported assets are introduced, use this folder only for approved
experiments that have a procedural fallback. Candidate files should follow this
shape:

- `rooms/<role>/<piece>.glb` for room shell or landmark variants
- `avatars/<character-or-role>.glb` for non-authoritative avatar skins
- `relics/<relic-id>.glb` for inspectable relic variants
- `effects/<effect-name>.glb` only for visual effects that can fail closed

Required conventions before any file ships:

- Keep each modular gameplay file under 1 MB compressed unless there is a
  measured exception.
- Put the origin at the room-local or avatar-local pivot expected by the
  procedural fallback.
- Use meters/Babylon units matching the current room grid.
- Avoid baked text in textures.
- Keep material names stable and map them to the palette in
  `docs/visual-direction.md`.
- Document license, source, author, and any edits next to the asset.

The current decision and measurements live in
`apps/relic-hunters-v1/docs/asset-pipeline-decision.md`.
