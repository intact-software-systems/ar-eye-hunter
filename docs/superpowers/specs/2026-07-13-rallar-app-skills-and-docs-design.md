# Rallar App Skills And Documentation Design

Date: 2026-07-13

## Objective

Make the repository's Rallar guidance reliably discoverable by Codex and give
an AI agent a clear, testable path for creating a new Rallar-first browser app,
including React applications with direct Three.js, React Three Fiber, or another
3D renderer.

The iteration also aligns current-facing documentation and root configuration
with the repository that exists today. It does not create a new application,
publish Rallar packages, or introduce a scaffold generator.

## Evidence And Current State

The design follows a repository-wide read-only audit of all tracked authored
text files, with deeper inspection of active skills, public Rallar surfaces,
examples, both game SPAs, current documentation, relevant tests, root config,
and the Cash Chase architecture documents.

The current repository provides strong feature-specific guidance:

- `skills/rallar-platform` maps package ownership and public surfaces.
- `skills/rallar-realtime` covers rooms, scoped identity, WS, and RTC.
- `skills/rallar-games` covers AR Eye Hunter, Relic Hunters, Rallar Game, and
  Motion.
- `skills/rallar-ai`, `rallar-code-writing`, `rallar-testing`, and
  `rallar-hetzner-ops` cover their named specialist areas.
- `examples/**` provides small, copyable recipes for individual Rallar
  capabilities.
- `apps/relic-hunters-v1` demonstrates a testable browser runtime adapter and
  explicit authority/presentation contracts.
- `apps/ar-eye-hunter-v1` demonstrates broad Rallar Game, director, Motion,
  diagnostics, presence, and AI integration.
- `projects/cash-chase-arena` contains a detailed Rallar-first React and 3D
  architecture, but its renderer decisions are intentionally product-specific.

The missing path is composition: a fresh agent is not told how to turn those
pieces into a new application architecture. The main skills also live under
`skills/**`, which requires the repo plugin to be installed, while the existing
performance skill under `.agents/skills/**` is directly discoverable from the
repository.

Current-facing consistency issues include:

- the quickstart's Motion send example calls `send` on an RTC lane config;
- initial startup guidance alternates between `setup()` and manual
  `configure()`/`setDefaults()`/`start()` without explaining the lifecycle
  distinction;
- the RallarAI game event example uses `rallar` without importing it;
- the documentation index links to a moved iteration file;
- root scripts and the root TypeScript project still reference removed
  `apps/web` and `apps/api` paths;
- cross-skill references and the `AGENTS.md` performance section contain
  ambiguous paths or placeholders;
- skill/plugin correctness is not covered by a general integrity test.

## Scope

### In scope

- Make one canonical repo skill tree directly discoverable and plugin-packaged.
- Add one greenfield Rallar app-building skill.
- Add reusable app-scaffolding, React/3D architecture, and example-routing
  references.
- Update existing Rallar skills to route greenfield app work to the new skill.
- Align active documentation with current APIs and repository paths.
- Remove stale root application scripts and TypeScript references.
- Add automated integrity tests for skills, plugin metadata, references,
  examples, and the corrected documentation contracts.
- Forward-test the new/changed skill behavior with fresh agents.

### Out of scope

- Creating `apps/cash-chase-arena` or any other new SPA.
- Adding Three.js, React Three Fiber, or Babylon dependencies.
- Choosing one 3D renderer for every Rallar application.
- Building a CLI generator or copying a maintained application template.
- Publishing the private workspace packages or changing their import model.
- Rewriting completed iteration records, historical plans, or measurement
  reports solely to modernize old path references.
- Adding a repo marketplace layout or symlink-based plugin installation path.
- Refactoring either existing game SPA.

## Architecture

### 1. Canonical skill discovery

Move the existing repository skills into `.agents/skills/**`. The final tree is
the single source of skill content:

```text
.agents/skills/
  building-rallar-apps/
  performance-analysis/
  rallar-ai/
  rallar-code-writing/
  rallar-games/
  rallar-hetzner-ops/
  rallar-platform/
  rallar-realtime/
  rallar-testing/
```

`.codex-plugin/plugin.json` points its `skills` field to
`./.agents/skills/`. This gives the same canonical files two supported entry
paths:

1. repository discovery when Codex opens this checkout;
2. namespaced plugin packaging when the Rallar plugin is installed elsewhere.

`AGENTS.md`, docs, tests, and current prompt packs must reference
`.agents/skills/**`. No copied skill tree, `SKILLS.md`, repo marketplace, or
symlink is added.

The plugin metadata remains `rallar-repo`, adds app-building/React/3D terms to
its discovery text, and exposes no more than three supported default prompts.

### 2. Greenfield app-building skill

Add `.agents/skills/building-rallar-apps/SKILL.md` with a trigger description
covering these concrete requests:

- create, start, bootstrap, or scaffold a Rallar browser app;
- build a Rallar React or Vite SPA;
- combine Rallar with Three.js, React Three Fiber, Babylon, or another renderer;
- decide browser-director versus server-authoritative game ownership;
- establish app/package/runtime/renderer boundaries before implementation.

The skill remains concise. It gives the required workflow and routes detailed
decisions to three one-level references:

- `references/app-scaffolding.md`
- `references/react-3d-architecture.md`
- `references/example-map.md`

The skill requires an agent to inspect the actual public APIs and chosen
examples before writing code. It treats docs as guidance and repository code
and tests as authority.

When compatible ecosystem skills are available, the Rallar skill may route
renderer implementation, asset preparation, or playtesting to them by skill
name. The Rallar skill cannot depend on those optional skills being installed,
and it remains authoritative for Rallar ownership and integration boundaries.

### 3. App-scaffolding reference

`app-scaffolding.md` defines a procedural in-repo scaffold rather than a file
copy operation. It covers:

1. choose the authority and data model before choosing transports;
2. create an app workspace plus a pure package when reusable rules exist;
3. add Vite/TypeScript aliases consistent with current apps;
4. configure the API URL and call `rallar.setup(...)` for initial boot;
5. restore/login, then enter a scoped room and keep its `roomRef`;
6. create a runtime adapter with injected dependencies and explicit disposal;
7. adapt that runtime into React state without moving transport logic into UI
   components;
8. add one vertical slice using a room-bound message or realtime channel;
9. add focused runtime, pure-domain, build, and visible browser tests;
10. expand to Game, Motion, Data, CRDT, AI, or server authority only when the
    product needs them.

The reference explicitly distinguishes:

- `rallar.setup(...)`: initial application configuration plus startup;
- `rallar.start(...)`: restart/continue the lifecycle after the facade is
  already configured, including after login;
- `rooms.enter(...)`: join and bind a room session;
- `rooms.session(...)`: bind an already-known/current room without joining;
- `createAndSwitch(...)`: create a replacement current room.

It preserves the repository product truths: Data is browser-local latest-value
state, CRDT is authored collaboration, Motion is presentation smoothing, and
RallarAI output is proposal data until domain acceptance.

### 4. React and 3D architecture reference

`react-3d-architecture.md` defines renderer-neutral ownership:

| Layer                  | Owns                                                                 | Must not own                                      |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------------------------- |
| Pure domain            | rules, validation, simulation, snapshots                             | React, Rallar runtime, renderer objects           |
| Rallar runtime adapter | startup, auth, rooms, subscriptions, commands, diagnostics, disposal | scene objects and React components                |
| React adapter/UI       | app phases, menus, HUD, accessible controls, low-frequency status    | per-frame transforms and authoritative simulation |
| Presentation model     | accepted snapshots, Motion mapping, renderer-neutral frames          | transport authority and React rendering           |
| Renderer               | scene, camera, meshes, materials, animation, effects, GPU resources  | game rules, room membership, network sends        |

The reference includes these invariants:

- no per-frame `setState` loop for scene entities;
- use renderer-local state, refs, or an external frame store for hot transforms;
- sender identity and authority come from validated Rallar envelopes/context,
  not trusted duplicate payload fields;
- receiver-local timestamps feed Motion samples unless explicit clock sync
  exists;
- room switch, logout, unmount, hot reload, and renderer replacement abort
  stale work and dispose subscriptions, timers, workers, listeners, scene
  resources, and WebGL resources idempotently;
- renderer code consumes presentation frames and cannot mutate domain truth;
- React exposes low-frequency diagnostics and accessibility UI around the
  canvas.

Renderer selection remains conditional:

- Prefer direct Three.js for imperative game loops, explicit resource
  ownership, many hot transforms, and a renderer-adapter architecture.
- Prefer React Three Fiber when the scene is naturally declarative, the team
  already uses the pmndrs ecosystem, and hot transforms remain outside normal
  React state updates.
- Use Babylon when its tooling or existing application expertise is the better
  measured fit.
- For significant applications, compare bundle, first-frame, frame-time,
  lifecycle/disposal, asset, and team-operability costs before locking the
  renderer.

The existing Babylon apps are architectural evidence, not Three.js templates.
Relic's runtime adapter and scene contracts are the preferred structural
references; AR Eye is the preferred capability-integration reference.

### 5. Example map

`example-map.md` maps product needs to the smallest useful evidence source:

- startup, auth, rooms: `examples/browser-startup-room`;
- typed reliable/fallback room traffic: `examples/room-message-channel`;
- low-latency room traffic: `examples/room-realtime-channel`;
- browser director: `examples/director-relay` and AR Eye;
- server authority: `examples/server-authoritative-game`, Relic runtime, and
  Relic server;
- smoothing: `examples/motion-smoothing` and Relic scene networking;
- local data, CRDT, media, AI, server middleware, and app data: their matching
  top-level examples;
- complete runtime boundary: Relic Hunters;
- broad game capability composition: AR Eye Hunter;
- renderer-neutral React/Three planning: Cash Chase documents.

The map tells agents to copy the smallest pattern and reconcile it with current
code/tests. It explicitly warns against copying either large SPA wholesale.

### 6. Existing skill routing

Update existing skill descriptions and entry-point references only where doing
so improves activation or removes ambiguity:

- `rallar-platform` routes new consumer application work to
  `building-rallar-apps` and adds `examples/**` and Cash Chase to its map.
- `rallar-games` routes greenfield game architecture to the new skill while
  retaining authority over existing game changes.
- `rallar-realtime` keeps transport guidance but directs app composition to the
  new skill.
- `rallar-testing` gains the skill integrity command and keeps visible browser
  workflow requirements.
- ambiguous cross-skill filesystem references are replaced with explicit skill
  names and direct references.

Existing specialist skills are not merged into the app-building skill.

## Documentation And Configuration Alignment

Update current-facing sources as one consistency pass:

- `AGENTS.md`: canonical skill location, new skill, example routing, and real
  performance guidance without `...` placeholders.
- `docs/README.md`: direct discovery/plugin packaging explanation, new
  app-building entry, examples, and corrected completed-iteration link.
- `docs/rallar-ai-skill.md` and prompting guidance: `setup()` for initial app
  boot, `start()` after configuration/login or for advanced lifecycle control.
- `docs/rallar-quickstart-and-recipes.md`: create a room-bound motion channel
  and send through that channel rather than the RTC lane configuration object.
- `examples/rallar-ai-game-event/README.md`: import the `rallar` facade used by
  the example.
- `.codex-plugin/plugin.json`: canonical skills path and aligned interface
  metadata/default prompts.
- `package.json`: remove `dev:web`, `build:web`, and `dev:api`, which target
  missing applications. Keep the current `*-v1` commands.
- `tsconfig.json`: remove the missing `apps/web` project reference.
- current prompt packs and tests: point at `.agents/skills/**`.

Historical plans, completed iteration records, and performance reports keep
their historical wording unless a current index points to them incorrectly.

## Error Handling And Lifecycle Guidance

The app-building guidance must distinguish validation failures from delivery
or readiness outcomes:

- invalid caller input may throw `RallarValidationError`;
- RTC/WS helpers return statuses such as `not-ready`, `no-targets`, `partial`,
  or transport-specific failure results;
- UI state should expose typed/redacted errors and actionable degraded status;
- login expiry, room switch, logout, and unmount invalidate earlier async work;
- teardown is idempotent and safe after partial startup.

Examples must not hide a failed send or imply that RTC is reliable authority.
Fallback behavior is chosen from the product's reliability/latency needs.

## Test Strategy

### Test-first skill and documentation integrity

Before moving or creating skills, add a failing Vitest contract for the desired
state. The final test verifies:

- `.codex-plugin/plugin.json` parses and points to `./.agents/skills/`;
- every immediate skill directory contains valid `name` and `description`
  frontmatter and its name matches the folder;
- local references named by the skills exist;
- the expected nine repository skills are present;
- `building-rallar-apps` links all three references and the references link the
  audited example/app paths;
- root package scripts and TypeScript references do not mention removed apps;
- active docs use the intended startup distinction;
- the quickstart no longer calls `send` on the lane configuration;
- the RallarAI game-event example imports `rallar`;
- the docs index link resolves.

The test must use existing Node/Vitest dependencies and must not depend on
globally installed Python or PyYAML. The upstream skill/plugin validators remain
supplementary checks when their Python dependencies are available.

### Forward testing

Follow the skill-writing red/green/refactor process with fresh-agent scenarios:

1. baseline without the new skill: ask for a Rallar React + Three app plan and
   record missed boundaries or discovery failures;
2. new skill enabled: run the same task and verify correct Rallar startup,
   runtime, authority, Motion, React, renderer, and cleanup boundaries;
3. variation: a declarative scene where React Three Fiber is reasonable;
4. variation: a server-authoritative app where RTC is presentation-only;
5. retrieval: ask the agent to find the smallest example for Data, CRDT,
   Motion, messages, and realtime.

The prompts provide task context but not the expected answer. Each result is
read manually; keyword counts alone are not acceptance evidence.

### Repository verification

Run, at minimum:

```sh
npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts
npx vitest run packages/tests/rallar-black-box/rallar-testing-skill.test.ts
npx vitest run packages/tests/shared-web/rallar-group-docs-compat.test.ts
npm run build:ar-eye-hunter-v1
npm run build:relic-hunters-v1
npm run test:unit
```

Run the plugin validator if a Python environment with PyYAML is available. If
it is unavailable, report the skipped validator and rely on the dependency-free
contract plus direct manifest parsing; do not install an undeclared global
dependency merely to satisfy the optional validator.

## Compatibility And Migration

- Rallar runtime APIs and public exports do not change.
- Existing app import paths do not change.
- Moving skills changes repository documentation paths only; plugin consumers
  receive the same skill names through the new manifest path.
- The existing `rallar-testing` skill test moves to the canonical location.
- A new Codex task is required to observe the updated repository skill catalog
  after the change.
- No marketplace or global Codex configuration is modified.

## Completion Criteria

The iteration is complete when:

1. all repo skills have one canonical home under `.agents/skills/**`;
2. the plugin points to and validates that canonical tree;
3. `building-rallar-apps` and its three references exist and pass integrity and
   forward-use tests;
4. current docs explain the startup and React/3D boundaries consistently;
5. audited current-facing snippet/path/config defects are fixed;
6. stale root app references are removed;
7. both example SPAs still build;
8. the focused and broader unit tests pass, with any environment-only skipped
   validator reported explicitly.
