# Pocket Arcade Market runtime seed art

Generated with the built-in Imagegen tool on 15 November 2026 from the selected
[arena style reference](../../../../projects/cca-2d/visual-concepts/pocket-arcade-arena-reference.png).
These are single-frame prototype sprites, not an approved animation set.

All sources are 1254 × 1254 PNGs. The three object sprites have genuine alpha;
the ground tile is opaque. The tool did not honor
requested 128-square output. Runtime files are lossless WebP encodings; no visual
editing, resampling, cropping, or background removal was performed. Sources remain
in the local Codex generated-image directory. Each asset is individually loadable;
do not load the full concept screenshot into the game.

## Rendering contract

| Asset       | Suggested image box           | Opaque visual size | Anchor                                          |
| ----------- | ----------------------------- | ------------------ | ----------------------------------------------- |
| runner.webp | 40 × 40 CSS px                | about 32 px        | bottom-center; feet around 92% of source height |
| stall.webp  | 88 × 88 CSS px                | about 70 px        | bottom-center; feet around 88% of source height |
| bank.webp   | 64 × 64 CSS px                | about 50 px        | bottom-center; base around 90% of source height |
| ground.webp | repeat at 96 × 96 world units | full tile          | top-left                                        |

These are starting visual sizes. Main gameplay owns the physics footprint,
consistent world scale, bank eligibility ring, facing, tint and animation. Use
nearest texture filtering. A mirrored or tinted runner can identify the second
player in this slice, but a later release needs shape-distinct identities and
reviewed animation strips. Preserve alpha and use generated art only for visuals.

The asset set needs production downsampling/pixel-grid normalization before its
texture budget is qualified. Lossless delivery compression does not reduce decoded
memory. The four original-size RGBA textures occupy about 24 MiB before overhead.

## Generation provenance

### ground.webp

Source: `exec-01a10412-93d3-46ae-a14b-1ccc32a95d2f.png`, created under
`$CODEX_HOME/generated_images/01a1df61-fba6-7213-bea9-ee8ae50e45eb/`.
Requested seamless repetition; inspect edge seams in the actual rendered scene
before claiming the tile is seamless. The source retains slight shade variation.

```text
Use case: stylized-concept. Asset type: seamless repeating top-down ground tile for a Phaser 2D pixel-art game. Input is STYLE REFERENCE ONLY. Create one completely square edge-to-edge seamless tile of warm peach cobblestone paving. Low contrast muted peach and warm cream colors, quiet flat ground with a simple regular staggered rectangular stone grid. NO objects, characters, coins, grass, plants, shadows, UI, letters, frame, border, edge fading or vignette. Orthogonal overhead, no perspective. Deliberate chunky square pixel clusters, 3 flat shades, NO noise, grain, gradient, antialias blur or painterly texture. Tiles seamlessly on all sides with consistent stone period. Intended to repeat at 96x96 world units; art must not compete with navy outlined runners. Request compact 128x128 output if possible.
```

### runner.webp

Source: `exec-21b75657-50c0-4e35-9e08-10aa41ec2667.png`, created under
`$CODEX_HOME/generated_images/01a1df61-fba6-7213-bea9-ee8ae50e45eb/`.

```text
Use case: stylized-concept. Asset type: single runtime sprite for a 2D top-down Phaser browser game. Input image is STYLE REFERENCE ONLY. Create ONLY the cream cat thief with bright green scarf and small brown loot sack, one isolated character on genuine TRANSPARENT background. No world, UI, ground, shadow ellipse, text, frame, or other characters. Friendly tiny animal, facing right in a readable three-quarter overhead walking pose with feet near bottom center. Chunky modern handheld 16-bit pixel art, deliberate square clusters and navy outline, cream/tan fur, 3 shade ramps, no blur or anti-aliased painted curves. Designed to remain legible at 32 CSS pixels. Fill 85 percent of a compact square canvas, centered, entire ears/bag/feet within image. Request 128x128 output if possible. Single frame, no sprite strip.
```

### stall.webp

Source: `exec-351ad784-c7df-4a0d-a604-1cf54d70b42b.png`, created under
`$CODEX_HOME/generated_images/01a1df61-fba6-7213-bea9-ee8ae50e45eb/`.

```text
Use case: stylized-concept. Asset type: single runtime prop sprite for a 2D top-down Phaser browser game. Input image is STYLE REFERENCE ONLY. Create ONLY one small wooden fruit market stall with teal and cream striped awning, three simple piles of orange and green fruit, warm wood, dark navy outline, facing downward with modest overhead view. Genuine TRANSPARENT background. No floor, plants outside the stall, people, UI, ground shadow, text, frame, or other props. Modern handheld 16-bit pixel art with deliberate chunky square clusters and 3 shades per material. Designed to remain clear at 70 CSS pixels, no photoreal or painterly smoothing. Entire single compact stall centered with all roof and feet visible, filling 85 percent of a square canvas. Request 128x128 output if possible.
```

### bank.webp

Source: `exec-0c82adf5-80cc-4a58-9ab2-f5e5393c1a35.png`, created under
`$CODEX_HOME/generated_images/01a1df61-fba6-7213-bea9-ee8ae50e45eb/`.

```text
Use case: stylized-concept. Asset type: single runtime banking prop sprite for a 2D top-down Phaser browser game. Input image is STYLE REFERENCE ONLY. Create ONLY one compact jade/teal coin-deposit bank kiosk, small roof peaked over a dark coin slot, large gold coin emblem above roof, cream sign reading exactly BANK. Genuine TRANSPARENT background. No floor, deposit ring, scenery, people, UI, ground shadow, frame, or other props. Face downward with modest overhead view, matching the market reference. Modern handheld 16-bit pixel art: deliberate chunky square clusters, bold navy outline, 3 flat shade ramps, no blur or painted smoothing. Designed to remain legible at 50 CSS pixels. Single compact kiosk centered, whole coin and bottom visible, filling 85 percent of a square canvas. Request 128x128 output if possible.
```
