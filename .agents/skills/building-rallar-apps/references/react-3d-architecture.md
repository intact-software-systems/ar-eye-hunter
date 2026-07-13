# React And 3D Architecture

## Responsibility Boundaries

| Boundary | Owns | Does not own |
| --- | --- | --- |
| Pure domain | Deterministic rules, accepted inputs, authority decisions, snapshots, validation | React, Rallar facade, browser clocks, transports, renderer objects |
| Rallar runtime | Initial lifecycle handoff, room sessions and `roomRef`, subscriptions, traffic, cancellation, accepted snapshot flow | DOM layout, scene graph, per-frame transforms, game-rule invention |
| React adapter/UI | Routes, forms, menus, HUD, accessibility, low-frequency runtime projections | Transport callbacks, authoritative match truth, renderer objects, per-frame entity state |
| Presentation model | Accepted snapshot mapping, Rallar Motion tracks, interpolation, prediction correction, renderer-neutral frames | Authority, collision, scoring, durable authored truth |
| Renderer | Canvas/context, camera, scene graph, meshes, materials, assets, effects, frame drawing, renderer diagnostics | Rallar traffic, domain mutation, match authority, ordinary React state |

The invariant is **no per-frame React state**. React may mount the canvas and
show bounded low-frequency diagnostics; the presentation model and renderer own
hot transforms and the frame loop.

## Renderer Decision

| Choice | Prefer when | Guardrail |
| --- | --- | --- |
| Direct Three.js | The app has imperative hot loops and needs explicit scene/resource ownership, a small adapter, or tight lifecycle/performance control. | Keep Three types behind the renderer and measure asset/camera ergonomics. |
| React Three Fiber | The scene is naturally declarative and React composition materially helps. | Keep hot transforms outside ordinary React state; use refs/frame hooks or an external presentation model. |
| Babylon | Its tooling, loaders, diagnostics, or team expertise wins a measured comparison. | Preserve the renderer-neutral contract and compare lifecycle, bundle, memory, and frame budgets. |

Direct Three.js is preferred for imperative hot loops and explicit resource
ownership. React Three Fiber is appropriate for naturally declarative scenes
when hot transforms stay outside ordinary React state. Babylon remains valid
when tooling/expertise wins a measured comparison.

Choose conditionally from the actual scene and measured constraints. Do not
select a renderer merely because React is present or because another app uses
one.

## Renderer-Neutral Contract

Keep Rallar and domain types outside the renderer implementation. Pass an
accepted, renderer-neutral presentation frame through this boundary:

```ts
export interface AppRenderer<TFrame, TDiagnostics> {
    mount(canvas: HTMLCanvasElement): Promise<void>;
    render(frame: TFrame): void;
    resize(width: number, height: number, pixelRatio: number): void;
    diagnostics(): TDiagnostics;
    dispose(): Promise<void>;
}
```

React mounts and replaces this adapter. The runtime supplies validated accepted
snapshots to a presentation model; the render loop samples that model and calls
`render` without routing frames through React state.

## Motion Mapping

Rallar Motion is presentation-only. First validate and accept a domain or
server snapshot for the current `roomRef`, match, authority epoch, revision,
and sequence. Then:

1. Map accepted entity position, rotation, optional velocity, and
   discontinuity metadata into Motion samples.
2. Use receiver-local `receivedAtEpochMs`/`observedAtEpochMs` as sample time;
   keep sender timestamps only as metadata unless explicit clock sync exists.
3. Sample Motion from the renderer's current local time and produce a
   renderer-neutral frame.
4. Blend small prediction errors, snap validated discontinuities, and remove
   tracks when an entity, room, match, or authority epoch changes.

Never feed unvalidated RTC pose traffic into authoritative domain state.
Cosmetic pose traffic may improve presentation, while accepted domain/server
snapshots remain truth.

## Resource Ownership And Teardown

Assign one owner for every Rallar subscription, frame request, timer, worker,
Motion track, asset load, canvas/context, scene, camera, mesh, geometry,
material, texture, render target, control, and audio/media resource. Renderer
replacement aborts pending loads and advances a generation before mounting the
replacement.

Make teardown idempotent after partial mount: stop frame production, detach
observers and events, dispose children and GPU resources, release the
canvas/context, then clear references. Context loss pauses or reconstructs
presentation without mutating authoritative state. A stale mount or asset load
must not publish into a disposed renderer.

## Validation

- Renderer contract tests: mount, render accepted frames, resize, bounded
  diagnostics, and repeated `dispose` after full and partial initialization.
- Context-loss/lifecycle tests: loss and restore, aborted asset loads, renderer
  replacement, room switch, hot reload, and stale async completion.
- Browser performance measurements: lazy renderer bundle size, setup to first
  frame, p50/p95 frame time, heap/resource counts, draw calls, and repeated
  mount/load/dispose cycles on representative and throttled hardware.

Keep performance budgets and diagnostics bounded. Inspect the renderer-neutral
planning evidence in
`projects/cash-chase-arena/Cash_Chase_Arena_Rallar_React_Three_Plans.md`, but
choose the renderer for the new app's measured needs.
