# Visual concept generation prompts

The original three options were generated independently with Imagegen on
15 November 2026, without image references. Numbers follow their display order
in the chat. **Option 2 is selected.** Refinement used the selected image as its
style reference; see the appended provenance and [current reference](README.md).

## 1. Paper Market Caper

```text
Use case: ui-mockup. Create one polished, believable GAMEPLAY SCREEN for Cash Chase Arena 2D, a browser multiplayer chase-and-bank party game. Direction name for your reference: Paper Market Caper. This must look like a production game paused mid-play on a smartphone, NOT promotional concept art, a poster, title screen or app dashboard.
TARGET: portrait smartphone app content, 390 x 844 CSS pixel proportions, high-resolution rendering at the same aspect ratio. No device bezel, notch, OS chrome, browser chrome, hands, external captions or watermark.
LAYOUT: compact HUD at top, a large square 390 x 390 top-down gameplay viewport immediately below the HUD, short event status below it, then generous reserved thumb-control area filling the lower portion. Game and controls fill the screen naturally. Never extend the world behind touch controls. HUD shows timer "1:42", "BANKED 120", "BAG 16/30" and a simple two-of-three heat indicator. A tiny settings button is the only auxiliary control. Readable type equivalent to 14-16px mobile UI.
GAMEPLAY: an orthographic top-down market with generous navigable lanes, striped stalls that serve as obstacles, two teal pneumatic bank booths, gold token trails, a central jackpot stall. Four small distinct animal thief sprites, each only about 28-34 CSS pixels tall, with readable head/body/feet. The local raccoon thief with a bulging loot bag has a small YOU marker and is dashing around a stall, pursued by a square wind-up security guard with an amber warning/detection cone. Another guard patrols, the three rival thieves collect or bank. Show at least one visible deposit ring and a short dash streak. The avatars must stay tiny relative to the map like real top-down game sprites, not giant illustrated characters. Simple non-overlapping HUD, no panels obscuring gameplay.
ART: premium hand-cut coloured paper illustration translated to actual sprite game art. Chunky dark plum outlines, textured cream ground, mint lanes, coral stall awnings, golden tokens, muted teal banks, tactile layered cardstock with subtle consistent offset shadows. Charming mischievous shapes, warm daylight, highly intentional palette, rich detail at real game scale but very readable navigation. No neon, no photorealism, no isometric perspective, no elaborate 3D lighting.
TOUCH CONTROLS: lower left a large translucent 112px circular thumb joystick with a visibly displaced thumb puck; lower right two distinct very large 64-72px circular buttons labelled "DASH" with a boot/arrow icon and "BANK" with a coin/deposit icon. Bank secondary to Dash, comfortably separated, not overlapping world. Small event line "JACKPOT IN 3s". Keep controls thumb-reachable with generous bottom margin. All UI uses the same paper/ink visual language.
Create realistic production-quality hierarchy, typography and spacing. One focused active match screen, no invented tabs/cards/shop features. No style-title text in the image. It is essential that this is a plausible playable smartphone GAME SCREEN with touch controls, not just a painting of the arena.
```

## 2. Pocket Arcade Market

```text
Use case: ui-mockup. Create ONE production-quality portrait smartphone GAMEPLAY SCREEN for Cash Chase Arena 2D. This is a graphical style alternative called Pocket Arcade Market. It must look like an actual crisp 2D pixel-art browser game in the middle of a four-player round, with visible touch controls, not a poster or splash screen.
Target proportions exactly 390 x 844 mobile CSS pixels, high resolution same ratio, full app content only. No phone bezel, notch, OS/browser chrome, hand, watermark, external captions or style-name text.
Composition: top 78 CSS pixels compact HUD with timer "1:42", "BANKED 120", "BAG 16/30", two-of-three heat indicators and tiny settings icon. Immediately beneath this is a SQUARE playable world view 390 CSS pixels wide AND 390 CSS pixels tall. Constrain the map inside that square. Below world, short text "JACKPOT IN 3s". The rest of the bottom area is a comfortable reserved control deck: large 112px joystick bottom-left with displaced puck and 64-72px DASH and BANK buttons on right, separated enough for thumbs. Controls must not cover the world. Deliberate breathing room, no invented feature panels.
Same gameplay situation: warm bustling street market, two clearly legible teal bank kiosks and their deposit rings, striped awning stalls as chunky obstacles with wide traversable paths between them, gold token trails, an open central jackpot cart. Four tiny distinct animal thieves: local raccoon tagged YOU carries a bulging loot bag and dashes around a stall; fox deposits, rabbit collects, hedgehog moves elsewhere. Two squat wind-up security robots with keys and amber directional warning wedges; one is chasing the raccoon. Character sprites about 24-32 CSS pixels tall, sensible scale relative to the map. Show motion through a few dash pixels, no dramatic camera perspective. Environment must read as usable actual collision/navigation geometry.
GRAPHICS STYLE: exquisite modern handheld 16-bit pixel art, visibly deliberate square pixel clusters, 3-4 shade ramps per material, clean silhouette outlines, cobalt-blue ink, warm terracotta roofs, peach stone, jade foliage, golden loot, creamy highlights. Cheerful late-afternoon seaside-market colour, absolutely no cyberpunk neon, no paper texture, no painted smoothing. Orthographic overhead map with sprite faces readable, modest fake vertical sprite depth only. High-quality densely authored tile set, lively cute chunky sprites, not generic geometric placeholders. Minimal two-frame-style coin sparkle. UI uses crisp pixel-edged panels and smooth readable text equivalent to at least14-16 CSS px. The touchscreen controls look professionally designed in the same retro visual system with clear boot/arrow and deposit icons.
Strong hierarchy: game situation first, scores next, usable thumb controls. No huge hero characters. No long instructions. Only one complete mobile screen.
```

## 3. Toybox Heist

```text
Use case: ui-mockup. Make one high-fidelity portrait smartphone GAMEPLAY SCREEN for Cash Chase Arena 2D. Art direction: Toybox Heist. Show a believable shipped 2D sprite game mid-match with real touch-control UI, not a title page, poster, painting or app dashboard. The art uses pre-rendered toy-like sprites that could be packed into a 2D texture atlas; do not suggest a free-camera 3D game.
TARGET DIMENSIONS: 390 x 844 CSS pixel portrait smartphone proportions, rendered at high resolution at that ratio. App content only, no device frame, notch, OS status, browser bar, hand, watermark, external captions or style title.
LAYOUT: a compact 74px-tall HUD, then a 390px by390px SQUARE gameplay view. No horizon or scenic backdrop in the playable view. Below it a slim "JACKPOT IN 3s" event strip. Entire lower region a comfortable muted lavender control deck with a large 112px circular joystick left, thumb puck visibly displaced, and two distinct right-side action buttons at least64px labelled "DASH" with boot/arrow icon and "BANK" with deposit icon. The buttons are nicely separated for thumbs and have satisfying molded toy surfaces, but not excessive fake reflections. No controls overlap the world.
HUD verbatim: timer "1:42", "BANKED 120", "BAG 16/30", a two-of-three simple heat icon, tiny settings button. Readable type at least14-16px equivalent, clear hierarchy.
GAMEPLAY: very readable orthographic OVERHEAD toy market, broad clean paths among striped market stalls, two teal bank booths with bright circular deposit zones, a central golden jackpot cart, trails of coins. Four small distinct animal thief sprites: a raccoon marked YOU with a large loot bag making a short dash around an obstacle, a fox banking, a rabbit collecting, a hedgehog crossing the map. Two little wind-up security robots with square bodies and winding keys; one chases the raccoon with a short amber directional warning wedge, another patrols. Runner height around28CSSpx; sensible tile-and-sprite scale, do not enlarge a character into a poster hero.
STYLE: playful premium miniature toy figures and chunky molded wooden/plastic props baked into 2D game sprites. Rounded silhouettes, clear matte materials, soft contact shadows, peach and butter-yellow ground, lavender blue edging, mint green bank booths, apricot/coral awnings, warm golden tokens. Clean contours without dark comic outlines. Animal faces highly readable, simple forms and restrained highlights. Beautiful polished toy-board-game quality, cheerful daylight, no photorealism, no neon, no bloom, no deep depth of field, no fake lens. Flat overhead level geometry with slightly angled sprites for face readability only. Distinct from paper collage and pixel art.
Focus on a real active chase situation with visible routes and usable phone controls. One focused primary screen, coherent spacing, clear typography, no extra navigation tabs/cards/shops. A viewer must instantly understand that this is a playable mobile multiplayer chase game.
```

## Selected direction refinement provenance

Two full-screen Imagegen edits of option 2 removed the horizon, closed the jackpot,
and reduced the controls. Their generated geometry still deviated from a square,
so neither is the measured layout baseline. The second edit supplied the visual
reference for the arena-only generation below. No production assets were derived.

The resulting `pocket-arcade-arena-reference.png` is placed inside a square DOM
frame in `pocket-arcade-layout.html`. Actual CSS dimensions define the HUD and
control references. `pocket-arcade-refined.jpg` is the browser capture of that
fixture at 390 × 844 CSS pixels. This separates illustration from layout evidence.

Arena-only edit prompt:

```text
Use the attached image as the exact pixel-art style reference. Extract/recompose ONLY the gameplay arena into a standalone perfectly SQUARE 1024 by 1024 pixel image, no phone, no HUD, no controls, no UI outside the arena. Entire square filled by overhead market floor, teal striped stalls along upper corners, colorful fruit crates, warm cream and salmon cobblestones, chunky pixel-art edges, jewel tone animal thieves, navy guard with amber vision wedge. Keep visual clarity: small cream cat player near center-left with subtle pale teal ring, purple raccoon opponent upper-left, orange fox right-center, small teal animal lower-right, two navy guards in lower half. Central upper locked jackpot cart has a closed chest, no coins overflowing, small sign JACKPOT. Small lime bank kiosk lower-right with BANK sign and green deposit apron. Cash token trail across center. Consistent orthographic top-down camera, no horizon, no skyline, no perspective walls. Reference screenshot only, no device border. Bright friendly Pocket Arcade Market pixel art. Avoid blur or painterly textures. Square outer boundary and square composition mandatory.
```
