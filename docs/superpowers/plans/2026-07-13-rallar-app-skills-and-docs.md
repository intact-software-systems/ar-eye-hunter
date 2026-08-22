# Rallar App Skills And Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Rallar's repo skills directly discoverable, add a tested greenfield React/3D app-building skill, and align active documentation and root configuration with the current repository.

**Architecture:** Keep one canonical skill tree under `.agents/skills/**` and point the existing `rallar-repo` plugin at it. Add one composition skill with focused references for scaffolding, React/3D ownership, and example selection; keep existing specialist skills separate. Protect discovery, documentation snippets, paths, and root config with a dependency-free Vitest contract plus fresh-agent forward tests.

**Tech Stack:** Markdown Agent Skills, Codex plugin JSON, TypeScript, Vitest, React/Vite app builds, Node filesystem APIs.

## Global Constraints

- Do not change Rallar runtime APIs, package exports, or existing app import paths.
- Do not create a new SPA, generator, template app, or renderer dependency.
- Keep exactly one copy of each repo skill under `.agents/skills/**`.
- Keep `.codex-plugin/plugin.json` as the plugin packaging manifest and point it at the canonical skill tree.
- Treat `rallar.setup(...)` as initial app configuration/startup and `rallar.start(...)` as configured lifecycle continuation/restart.
- Keep Data browser-local, CRDT for authored collaboration, Motion presentation-only, and AI proposal-only until domain acceptance.
- Preserve historical plans, completed iteration records, and performance reports unless a current index points to them incorrectly.
- Write the skill/documentation integrity test before moving or creating skills.
- Forward-test every new or materially changed skill before accepting it.
- Report the Python skill/plugin validator as skipped if PyYAML remains unavailable; do not install a global dependency.

## File Structure

### Create

- `packages/tests/repo/rallar-skill-integrity.test.ts`: dependency-free contract for skill discovery, plugin metadata, local references, active docs, examples, and root config.
- `.agents/skills/building-rallar-apps/SKILL.md`: greenfield Rallar application workflow and routing.
- `.agents/skills/building-rallar-apps/references/app-scaffolding.md`: in-repo React/Vite/Rallar scaffold sequence and lifecycle contract.
- `.agents/skills/building-rallar-apps/references/react-3d-architecture.md`: renderer-neutral React/Three/R3F/Babylon ownership guidance.
- `.agents/skills/building-rallar-apps/references/example-map.md`: route product needs to the smallest current example or app evidence.

### Move without copying

- `skills/rallar-ai/**` -> `.agents/skills/rallar-ai/**`
- `skills/rallar-code-writing/**` -> `.agents/skills/rallar-code-writing/**`
- `skills/rallar-games/**` -> `.agents/skills/rallar-games/**`
- `skills/rallar-hetzner-ops/**` -> `.agents/skills/rallar-hetzner-ops/**`
- `skills/rallar-platform/**` -> `.agents/skills/rallar-platform/**`
- `skills/rallar-realtime/**` -> `.agents/skills/rallar-realtime/**`
- `skills/rallar-testing/**` -> `.agents/skills/rallar-testing/**`

### Modify

- `.codex-plugin/plugin.json`: canonical skill path, app-building discovery terms, maximum three default prompts.
- `AGENTS.md`: canonical skill location, new skill routing, examples, concrete performance guidance.
- `.agents/skills/rallar-platform/SKILL.md`: route new consumer apps to `building-rallar-apps`.
- `.agents/skills/rallar-platform/references/package-map.md`: add examples and Cash Chase planning evidence.
- `.agents/skills/rallar-games/SKILL.md`: route greenfield game architecture and fix the testing-skill reference.
- `.agents/skills/rallar-games/references/game-entrypoints.md`: distinguish structural and capability examples.
- `.agents/skills/rallar-realtime/SKILL.md`: route whole-app composition to the new skill.
- `.agents/skills/rallar-testing/SKILL.md`: include repo skill/documentation integrity selection.
- `.agents/skills/rallar-testing/references/test-commands.md`: add the focused integrity command.
- `packages/tests/rallar-black-box/rallar-testing-skill.test.ts`: use canonical skill paths and assert the new command.
- `docs/README.md`: direct discovery/plugin packaging, new skill/examples, repaired iteration link.
- `docs/rallar-ai-skill.md`: initial `setup` versus configured `start` lifecycle.
- `docs/rallar-ai-prompting-guide.md`: initial app startup prompt uses `setup`.
- `docs/rallar-troubleshooting-checklist.md`: initial startup distinction.
- `docs/rallar-quickstart-and-recipes.md`: send Motion updates through a room-bound realtime channel.
- `examples/rallar-ai-game-event/README.md`: import the `rallar` facade used by the example.
- `projects/cash-chase-arena/Cash_Chase_Arena_Codex_Prompt_Pack.md`: canonical skill path.
- `package.json`: remove scripts for missing `apps/web` and `apps/api`.
- `tsconfig.json`: remove the missing `apps/web` project reference.

---

### Task 1: Add the failing repository skill integrity contract

**Files:**

- Create: `packages/tests/repo/rallar-skill-integrity.test.ts`

**Interfaces:**

- Consumes: repository files through Node `fs`/`path`; no Python/YAML dependency.
- Produces: named Vitest contracts that later tasks can make green independently.

- [ ] **Step 1: Write the failing integrity test**

Create `packages/tests/repo/rallar-skill-integrity.test.ts` with:

```ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const skillsRoot = path.join(repoRoot, '.agents/skills');
const expectedSkills = [
    'building-rallar-apps',
    'performance-analysis',
    'rallar-ai',
    'rallar-code-writing',
    'rallar-games',
    'rallar-hetzner-ops',
    'rallar-platform',
    'rallar-realtime',
    'rallar-testing'
] as const;

describe('Rallar repo skill and documentation integrity', () => {
    it('uses one directly discoverable skill tree for the plugin', () => {
        const plugin = readJson('.codex-plugin/plugin.json') as {
            skills?: string;
            interface?: { defaultPrompt?: readonly string[]; };
        };
        const skillDirectories = readdirSync(skillsRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();

        expect(plugin.skills).toBe('./.agents/skills/');
        expect(plugin.interface?.defaultPrompt?.length).toBeLessThanOrEqual(3);
        expect(skillDirectories).toEqual([...expectedSkills].sort());
        expect(existsSync(path.join(repoRoot, 'skills'))).toBe(false);
    });

    it('keeps skill frontmatter and local references valid', () => {
        for (const skillName of expectedSkills) {
            const skillPath = path.join(skillsRoot, skillName, 'SKILL.md');
            const source = readAbsolute(skillPath);
            const frontmatter = readFrontmatter(source, skillPath);

            expect(frontmatter.name, skillPath).toBe(skillName);
            expect(frontmatter.description.length, skillPath).toBeGreaterThan(20);

            for (const reference of source.matchAll(/`(references\/[a-z0-9./-]+\.md)`/g)) {
                expect(
                    existsSync(path.join(skillsRoot, skillName, reference[1])),
                    `${skillPath} -> ${reference[1]}`
                ).toBe(true);
            }
        }
    });

    it('provides the greenfield app workflow and audited evidence map', () => {
        const skill = readRepo('.agents/skills/building-rallar-apps/SKILL.md');
        const scaffolding = readRepo(
            '.agents/skills/building-rallar-apps/references/app-scaffolding.md'
        );
        const architecture = readRepo(
            '.agents/skills/building-rallar-apps/references/react-3d-architecture.md'
        );
        const exampleMap = readRepo(
            '.agents/skills/building-rallar-apps/references/example-map.md'
        );

        expectAll(skill, [
            '`references/app-scaffolding.md`',
            '`references/react-3d-architecture.md`',
            '`references/example-map.md`',
            'rallar.setup',
            'roomRef'
        ]);
        expectAll(scaffolding, [
            'apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts',
            'rallar.rooms.enter',
            'rallar.rooms.createAndSwitch',
            'AbortController'
        ]);
        expectAll(architecture, [
            'Direct Three.js',
            'React Three Fiber',
            'no per-frame React state',
            'Rallar Motion',
            'dispose'
        ]);
        expectAll(exampleMap, [
            'examples/browser-startup-room',
            'examples/room-message-channel',
            'examples/room-realtime-channel',
            'examples/motion-smoothing',
            'apps/ar-eye-hunter-v1',
            'apps/relic-hunters-v1',
            'projects/cash-chase-arena'
        ]);
    });

    it('routes composition and validation from the specialist skills', () => {
        const platform = readRepo('.agents/skills/rallar-platform/SKILL.md');
        const games = readRepo('.agents/skills/rallar-games/SKILL.md');
        const realtime = readRepo('.agents/skills/rallar-realtime/SKILL.md');
        const testing = readRepo('.agents/skills/rallar-testing/SKILL.md');
        const testCommands = readRepo(
            '.agents/skills/rallar-testing/references/test-commands.md'
        );

        expect(platform).toContain('building-rallar-apps');
        expect(games).toContain('building-rallar-apps');
        expect(games).toContain('Use the `rallar-testing` skill');
        expect(realtime).toContain('building-rallar-apps');
        expect(testing).toContain('rallar-skill-integrity.test.ts');
        expect(testCommands).toContain(
            'npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts'
        );
    });

    it('routes active repo guidance through the canonical skill location', () => {
        for (
            const filePath of [
                'AGENTS.md',
                'docs/README.md',
                'projects/cash-chase-arena/Cash_Chase_Arena_Codex_Prompt_Pack.md'
            ]
        ) {
            const source = readRepo(filePath);
            expect(source, filePath).toContain('.agents/skills');
            expect(source, filePath).not.toMatch(/(?<!\.agents\/)skills\/\*\*/);
        }

        expect(readRepo('AGENTS.md')).not.toContain('  - `...`');
    });

    it('keeps current startup and recipe documentation internally consistent', () => {
        const aiSkill = readRepo('docs/rallar-ai-skill.md');
        const prompting = readRepo('docs/rallar-ai-prompting-guide.md');
        const troubleshooting = readRepo('docs/rallar-troubleshooting-checklist.md');
        const quickstart = readRepo('docs/rallar-quickstart-and-recipes.md');
        const aiExample = readRepo('examples/rallar-ai-game-event/README.md');
        const docsIndex = readRepo('docs/README.md');

        expectAll(aiSkill, ['initial app boot', '`rallar.setup(...)`', '`rallar.start(...)`']);
        expectAll(prompting, ['rallar.setup({', 'After login, call rallar.start']);
        expect(troubleshooting).toContain('`rallar.setup(...)`');
        expect(quickstart).not.toContain('motionLane.send(');
        expectAll(quickstart, [
            'const motionUpdates = room.realtime<PoseUpdate>',
            'await motionUpdates.send(nextPose)'
        ]);
        expect(aiExample).toContain(
            'import { rallar } from \'@shared-web/browser/rallar.ts\';'
        );
        expect(docsIndex).toContain(
            '../iterations/completed/rallar-api-v1-in-memory-sql-performance-mode.md'
        );
        expect(
            existsSync(
                path.join(
                    repoRoot,
                    'iterations/completed/rallar-api-v1-in-memory-sql-performance-mode.md'
                )
            )
        ).toBe(true);
    });

    it('does not expose root commands or project references for removed apps', () => {
        const packageJson = readJson('package.json') as { scripts?: Record<string, string>; };
        const tsconfig = readJson('tsconfig.json') as {
            references?: readonly { path?: string; }[];
        };

        expect(packageJson.scripts).not.toHaveProperty('dev:web');
        expect(packageJson.scripts).not.toHaveProperty('build:web');
        expect(packageJson.scripts).not.toHaveProperty('dev:api');
        for (const command of Object.values(packageJson.scripts ?? {})) {
            expect(command).not.toContain('apps/web');
            expect(command).not.toMatch(/\bapps\/api(?:\s|$)/);
        }
        expect(tsconfig.references?.map((reference) => reference.path)).not.toContain(
            'apps/web'
        );
    });
});

function readRepo(filePath: string): string {
    return readAbsolute(path.join(repoRoot, filePath));
}

function readAbsolute(filePath: string): string {
    return readFileSync(filePath, 'utf8');
}

function readJson(filePath: string): unknown {
    return JSON.parse(readRepo(filePath));
}

function readFrontmatter(
    source: string,
    filePath: string
): Readonly<{ name: string; description: string; }> {
    const block = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1];
    expect(block, filePath).toBeDefined();
    const name = block?.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? '';
    const description = block?.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
    return { name, description };
}

function expectAll(haystack: string, needles: readonly string[]): void {
    for (const needle of needles) {
        expect(haystack, needle).toContain(needle);
    }
}
```

- [ ] **Step 2: Run the test and confirm the intended red state**

Run:

```sh
npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts
```

Expected: FAIL because `.agents/skills` does not yet contain the eight expected Rallar skills or `building-rallar-apps`, the plugin still points at `./skills/`, and active docs/config still contain the audited defects.

- [ ] **Step 3: Commit the red contract**

```sh
git add packages/tests/repo/rallar-skill-integrity.test.ts
git commit -m "test: define Rallar skill integrity contract"
```

---

### Task 2: Make the existing skill tree directly discoverable

**Files:**

- Move: `skills/rallar-*/**` -> `.agents/skills/rallar-*/**`
- Modify: `.codex-plugin/plugin.json`
- Modify: `packages/tests/rallar-black-box/rallar-testing-skill.test.ts`

**Interfaces:**

- Consumes: existing skill names and content without semantic changes.
- Produces: canonical `.agents/skills/**` paths used by the plugin, tests, and later documentation changes.

- [ ] **Step 1: Move each existing Rallar skill with history preserved**

Run:

```sh
git mv skills/rallar-ai .agents/skills/rallar-ai
git mv skills/rallar-code-writing .agents/skills/rallar-code-writing
git mv skills/rallar-games .agents/skills/rallar-games
git mv skills/rallar-hetzner-ops .agents/skills/rallar-hetzner-ops
git mv skills/rallar-platform .agents/skills/rallar-platform
git mv skills/rallar-realtime .agents/skills/rallar-realtime
git mv skills/rallar-testing .agents/skills/rallar-testing
```

Expected: `skills/` is empty and disappears from the Git index; `.agents/skills/performance-analysis` is preserved.

- [ ] **Step 2: Point the plugin at the canonical tree and align discovery metadata**

In `.codex-plugin/plugin.json`:

- change `"skills": "./skills/"` to `"skills": "./.agents/skills/"`;
- add `"app-scaffolding"`, `"react"`, and `"three.js"` to `keywords`;
- change `shortDescription` to `"Build and change Rallar packages and apps."`;
- change `longDescription` to `"Repo-local skills for Rallar package boundaries, greenfield browser apps, React/3D architecture, realtime infrastructure, games, AI, operations, performance, and validation."`;
- replace `defaultPrompt` with exactly:

```json
[
  "Scaffold a Rallar-first browser app.",
  "Plan a Rallar React and 3D architecture.",
  "Find and test the right Rallar package change."
]
```

- [ ] **Step 3: Update the existing rallar-testing contract path**

In `packages/tests/rallar-black-box/rallar-testing-skill.test.ts`, replace both
`skills/rallar-testing` path prefixes with `.agents/skills/rallar-testing` and
add:

```ts
expect(commands).toContain(
    'npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts'
);
```

This new expectation remains red until Task 4 updates the testing reference.

- [ ] **Step 4: Verify the migration boundary**

Run:

```sh
npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts -t "uses one directly discoverable skill tree"
```

Expected: FAIL only because `building-rallar-apps` has not been added yet; the plugin path and moved existing skills are otherwise visible.

Run:

```sh
npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts -t "keeps skill frontmatter"
```

Expected: FAIL only for the missing `building-rallar-apps` skill.

- [ ] **Step 5: Commit the canonical discovery migration**

```sh
git add .agents/skills .codex-plugin/plugin.json packages/tests/rallar-black-box/rallar-testing-skill.test.ts
git commit -m "chore: make Rallar repo skills directly discoverable"
```

---

### Task 3: Add and forward-test `building-rallar-apps`

**Files:**

- Create: `.agents/skills/building-rallar-apps/SKILL.md`
- Create: `.agents/skills/building-rallar-apps/references/app-scaffolding.md`
- Create: `.agents/skills/building-rallar-apps/references/react-3d-architecture.md`
- Create: `.agents/skills/building-rallar-apps/references/example-map.md`

**Interfaces:**

- Consumes: current Rallar public APIs, examples, Relic runtime/scene contracts, AR Eye integration, and Cash Chase renderer planning.
- Produces: one discoverable composition workflow and three references whose exact paths are asserted by the integrity contract.

- [ ] **Step 1: Record the baseline forward-test failures before adding the skill**

Run fresh-agent scenarios without providing the intended design answer:

```text
Plan the first vertical slice for a new React + direct Three.js browser game in this repository. Rallar must own auth, rooms, messages, and realtime. Identify files, lifecycle, ownership boundaries, and tests. Do not implement it.
```

```text
Plan a Rallar React Three Fiber collaborative 3D app. Decide where React state, realtime traffic, renderer state, and authored shared data belong. Do not implement it.
```

```text
Find the smallest current repository examples for Rallar startup, reliable room messages, low-latency room traffic, Motion, Data, CRDT, and server authority.
```

Save the raw agent responses in the task transcript, not in the repository. Manually record whether each response finds the existing repo skills, preserves `roomRef`, separates authority from presentation, avoids per-frame React state, and selects the smallest examples.

- [ ] **Step 2: Create the concise skill entry point**

Create `.agents/skills/building-rallar-apps/SKILL.md` with this structure and requirements:

```markdown
---
name: building-rallar-apps
description: Use when creating, bootstrapping, scaffolding, or architecting a new Rallar browser application, React/Vite SPA, or Three.js, React Three Fiber, or Babylon game, including authority, runtime, room, renderer, lifecycle, and test boundaries.
---

# Building Rallar Apps

## Start Here

Read `references/app-scaffolding.md` before creating files. For a 3D app, also
read `references/react-3d-architecture.md`. Use
`references/example-map.md` to inspect the smallest current examples that match
the requested capabilities.

Inspect the public code and focused tests behind every selected example. Code
and tests are authoritative when prose differs.

## Required Decisions

1. Choose browser-director, server-authoritative, or collaborative authored
   state before selecting transports.
2. Define the pure domain, Rallar runtime, React UI, presentation, and renderer
   boundaries.
3. Use `rallar.setup(...)` for initial boot and preserve `roomRef` in scoped
   application/workspace flows.
4. Prefer room-bound `room.message<T>(...)` and `room.realtime<T>(...)`
   handles before low-level transport wiring.
5. Make logout, room switch, unmount, hot reload, and renderer replacement
   cancel stale work and dispose resources idempotently.
6. Add one end-to-end vertical slice and focused tests before expanding the
   capability set.

## Product Boundaries

- Rallar Data is browser-local latest-value state.
- Rallar CRDT is collaborative authored state.
- Rallar Game or server domain code owns match authority.
- Rallar Motion smooths accepted presentation state only.
- RallarAI output remains proposal data until validated and accepted.

For renderer implementation, asset processing, or playtesting, use an
appropriate ecosystem skill when available. Those skills do not override the
Rallar ownership rules above.

## Validation

Use the `rallar-testing` skill. Include pure-domain tests, runtime tests with
injected dependencies, the app build, and visible browser coverage for changed
human workflows.
```

- [ ] **Step 3: Create the procedural scaffolding reference**

Create `references/app-scaffolding.md` with these sections:

- `# Rallar App Scaffolding`
- `## Decisions Before Files`: authority, durable/shared/local state, latency/reliability, 3D renderer.
- `## Recommended Repository Shape`: use `apps/example-rallar-app`, optional `packages/example-rallar-app`, `src/rallar`, `src/runtime`, `src/ui`, `src/renderer`, and tests as concrete illustrative names.
- `## Workspace, Vite, And TypeScript Wiring`: explain the existing `apps/*`
  workspace, app-local renderer dependencies, matching `vite.config.ts` aliases
  and TypeScript `paths`, strict `"moduleResolution": "Bundler"`, an unused
  strict port, and the `/api` proxy with `ws: true`; do not add a root
  TypeScript project reference.
- `## Initial Boot`: a complete `rallar.setup({ apiBaseUrl, applicationId, workspaceId, start: { refreshPeople: true } })` example followed by login and configured `rallar.start(...)`.
- `## Room-Bound Vertical Slice`: `rooms.createAndSwitch`, `rooms.enter`, `rooms.session`, `room.message`, and `room.realtime` with `roomRef` retained.
- `## Runtime Adapter`: an injected `RallarAppRuntimeDeps` example with `start`, `enterRoom`, `subscriptions`, and idempotent `dispose`; cite `apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts`.
- `## React Adapter`: React reads low-frequency runtime state and cleans up in `useEffect`; transport code remains in the runtime.
- `## Cancellation And Cleanup`: one `AbortController`/generation per active lifecycle; clear subscriptions, timers, workers, room-bound handles, and stale completions.
- `## Capability Expansion`: route Game, Motion, Data, CRDT, AI, media, and server authority to the corresponding specialist skills/examples.
- `## Minimum Validation`: pure tests, fake-dependency runtime tests, build/typecheck, visible browser vertical slice.

Include this exact lifecycle distinction:

```markdown
Use `rallar.setup(...)` once for initial API configuration, defaults, session
restore, connection, and room refresh. After a login on an already configured
facade, use `rallar.start(...)` to connect and refresh. Use
`rallar.rooms.enter(...)` to join and bind a room; use
`rallar.rooms.session(...)` only when the room is already current/known.
```

- [ ] **Step 4: Create the React/3D architecture reference**

Create `references/react-3d-architecture.md` with:

- a responsibility table for pure domain, Rallar runtime, React adapter/UI, presentation model, and renderer;
- the explicit phrase `no per-frame React state`;
- a direct Three.js versus React Three Fiber versus Babylon decision table;
- a renderer-neutral interface with `mount`, `render`, `resize`, `diagnostics`, and `dispose`;
- Motion mapping using receiver-local time and validated accepted snapshots;
- resource ownership and idempotent teardown;
- renderer contract tests, context-loss/lifecycle tests, and browser performance measurements.

Use this exact interface:

```ts
export interface AppRenderer<TFrame, TDiagnostics> {
    mount(canvas: HTMLCanvasElement): Promise<void>;
    render(frame: TFrame): void;
    resize(width: number, height: number, pixelRatio: number): void;
    diagnostics(): TDiagnostics;
    dispose(): Promise<void>;
}
```

State that Direct Three.js is preferred for imperative hot loops and explicit
resource ownership; React Three Fiber is appropriate for naturally declarative
scenes when hot transforms stay outside ordinary React state; Babylon remains
valid when tooling/expertise wins a measured comparison.

- [ ] **Step 5: Create the example routing reference**

Create `references/example-map.md` with a table mapping:

| Need                            | Primary evidence                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Initial browser boot and rooms  | `examples/browser-startup-room`                                                                            |
| Reliable/fallback room messages | `examples/room-message-channel`                                                                            |
| Low-latency room data           | `examples/room-realtime-channel`                                                                           |
| Browser director                | `examples/director-relay`, `apps/ar-eye-hunter-v1`                                                         |
| Motion presentation             | `examples/motion-smoothing`, `apps/relic-hunters-v1/src/game/scene/networking.ts`                          |
| Browser local state             | `examples/browser-data-store`                                                                              |
| Authored collaboration          | `examples/room-crdt-document`                                                                              |
| Server authority                | `examples/server-authoritative-game`, `apps/relic-hunter-server-v1`                                        |
| Server middleware/app data      | `examples/server-middleware`, `examples/server-app-data`                                                   |
| AI proposals                    | `examples/rallar-ai-game-event`, `examples/rallar-ai-server-ollama`                                        |
| Complete runtime boundary       | `apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts`, `apps/relic-hunters-v1/docs/scene-contracts.md` |
| Broad game composition          | `apps/ar-eye-hunter-v1/src/game/useRallarArena.ts`                                                         |
| Renderer-neutral planning       | `projects/cash-chase-arena/Cash_Chase_Arena_Rallar_React_Three_Plans.md`                                   |

End with: inspect the smallest matching source and its tests; do not copy either
large SPA wholesale.

- [ ] **Step 6: Run the skill integrity tests**

Run:

```sh
npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts -t "frontmatter|greenfield"
```

Expected: PASS.

- [ ] **Step 7: Re-run the fresh-agent scenarios with the new skill available**

Use the same three prompts from Step 1 plus this server-authority variation:

```text
Plan a server-authoritative Rallar React 3D game where RTC pose traffic is cosmetic and server snapshots are truth. Identify the smallest repo examples and the React/renderer boundaries. Do not implement it.
```

Expected manual evidence:

- Direct Three and R3F are chosen conditionally rather than categorically.
- React owns UI but not per-frame entity state.
- The runtime owns Rallar subscriptions and cleanup.
- Domain/server state owns authority; Motion is presentation-only.
- `rallar.setup`, `roomRef`, room-bound channels, and smallest examples appear.

If a scenario misses a required boundary, tighten only the relevant skill/reference wording and rerun that scenario.

- [ ] **Step 8: Commit the new tested skill**

```sh
git add .agents/skills/building-rallar-apps packages/tests/repo/rallar-skill-integrity.test.ts
git commit -m "feat: add greenfield Rallar app skill"
```

---

### Task 4: Route existing skills and repo orientation to the new workflow

**Files:**

- Modify: `AGENTS.md`
- Modify: `.agents/skills/rallar-platform/SKILL.md`
- Modify: `.agents/skills/rallar-platform/references/package-map.md`
- Modify: `.agents/skills/rallar-games/SKILL.md`
- Modify: `.agents/skills/rallar-games/references/game-entrypoints.md`
- Modify: `.agents/skills/rallar-realtime/SKILL.md`
- Modify: `.agents/skills/rallar-testing/SKILL.md`
- Modify: `.agents/skills/rallar-testing/references/test-commands.md`
- Modify: `projects/cash-chase-arena/Cash_Chase_Arena_Codex_Prompt_Pack.md`

**Interfaces:**

- Consumes: the verified `building-rallar-apps` skill name and integrity command.
- Produces: reliable implicit activation/routing without duplicating specialist content.

- [ ] **Step 1: Update `AGENTS.md` orientation and performance guidance**

Replace root `skills/**` references with `.agents/skills/**`, add
`building-rallar-apps` first for greenfield apps/React/3D architecture, and add
`examples/**` to the initial inspection guidance.

Replace the placeholder performance section with concrete guidance:

```markdown
## Performance analysis repo guidance

When using the `performance-analysis` skill:

- Start static audits from `packages/**`, `apps/api-v1`,
  `apps/rallar-black-box-control-server`, and
  `apps/rallar-black-box-headless`.
- Read `scripts/perf/README.md` and the relevant existing harness under
  `scripts/perf/**` before adding a benchmark.
- Run focused correctness tests from the `rallar-testing` skill before
  accepting an optimization.
- Put generated profiles under `tmp/perf/` and do not commit them unless
  explicitly requested.
- Treat `packages/shared/webrtc`, `packages/shared/multicast`,
  `packages/shared-web/browser`, and shared-server queue/state paths as
  performance-sensitive when they are on the measured workload.
- Treat historical plans and generated black-box artifacts as context, not a
  runtime baseline unless the environment and workload match.
```

- [ ] **Step 2: Update platform routing and map**

Add `new app`, `greenfield`, `React`, `Vite`, and `Three.js` to the
`rallar-platform` description. At the start of its body, require
`building-rallar-apps` for new consumer application scaffolding; keep
`rallar-platform` responsible for package/public-surface changes.

Add these entries to `package-map.md`:

```markdown
## Consumer App Evidence

- `examples/**`: smallest copyable capability recipes; start here for one
  Rallar surface.
- `apps/relic-hunters-v1`: preferred runtime-adapter and authority/presentation
  boundary example.
- `apps/ar-eye-hunter-v1`: broad Rallar Game, director, diagnostics, Motion,
  presence, and AI composition example.
- `projects/cash-chase-arena`: renderer-neutral Rallar/React/3D planning;
  product decisions are not universal defaults.
```

- [ ] **Step 3: Update game and realtime routing**

In `rallar-games`:

- extend the description with `greenfield browser game architecture`;
- require `building-rallar-apps` when creating a new game, while retaining
  `rallar-games` for existing games/Rallar Game/Motion behavior;
- replace `Use references/test-commands.md from the rallar-testing skill` with
  `Use the rallar-testing skill to select validation commands.`

In `game-entrypoints.md`, label Relic's runtime/scene contracts as the preferred
structural example and AR Eye as the broad capability example. Add the Cash
Chase plan as renderer-neutral planning evidence, not a universal renderer
decision.

In `rallar-realtime`, add one sentence: use `building-rallar-apps` when deciding
how realtime fits into a whole new app; this skill remains authoritative for
rooms, scope, messages, WS/RTC, identity, routing, and readiness.

- [ ] **Step 4: Add the integrity command to testing guidance**

In `rallar-testing/SKILL.md`, add a selection rule for changes to
`.agents/skills/**`, `.codex-plugin/plugin.json`, active Rallar docs/examples,
or root skill/config routing.

In `references/test-commands.md`, add:

````markdown
## Skills And Active Documentation

```sh
npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts
```
````

Run this after changing repo skills, plugin metadata, active Rallar examples,
startup guidance, or root app-path configuration.

````
- [ ] **Step 5: Update the Cash Chase prompt pack path**

Replace `skills/**` with `.agents/skills/**` in the orientation prompt. Do not
alter Cash Chase product or renderer decisions.

- [ ] **Step 6: Run routing and existing-skill tests**

Run:

```sh
npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts -t "routes active repo guidance"
npx vitest run packages/tests/rallar-black-box/rallar-testing-skill.test.ts
````

Expected: PASS.

- [ ] **Step 7: Forward-test implicit routing**

Give a fresh agent only this prompt:

```text
Create a plan for a new Rallar React + Three.js app in this repository. Do not name any skill manually and do not implement it.
```

Expected: the agent discovers `building-rallar-apps`, then uses specialist
Rallar skills for the selected authority/realtime/testing surfaces.

- [ ] **Step 8: Commit routing changes**

```sh
git add AGENTS.md .agents/skills/rallar-platform .agents/skills/rallar-games .agents/skills/rallar-realtime .agents/skills/rallar-testing packages/tests/rallar-black-box/rallar-testing-skill.test.ts projects/cash-chase-arena/Cash_Chase_Arena_Codex_Prompt_Pack.md
git commit -m "docs: route greenfield work through Rallar app skill"
```

---

### Task 5: Align active startup, Motion, AI example, and docs-index guidance

**Files:**

- Modify: `docs/README.md`
- Modify: `docs/rallar-ai-skill.md`
- Modify: `docs/rallar-ai-prompting-guide.md`
- Modify: `docs/rallar-troubleshooting-checklist.md`
- Modify: `docs/rallar-quickstart-and-recipes.md`
- Modify: `examples/rallar-ai-game-event/README.md`

**Interfaces:**

- Consumes: current `setup`, `start`, room session, realtime, Motion, and browser AI APIs.
- Produces: one current startup story and copyable snippets that use defined values.

- [ ] **Step 1: Update the documentation index and discovery explanation**

In `docs/README.md`:

- describe `.agents/skills/**` as directly discoverable repo skills;
- explain that `.codex-plugin/plugin.json` packages the same canonical tree;
- list `building-rallar-apps` and `examples/**` as the starting points for new
  consumer applications;
- keep explicit skill naming as the way to guarantee specialist use;
- repair the iteration link to
  `../iterations/completed/rallar-api-v1-in-memory-sql-performance-mode.md` and
  label it completed implementation context rather than work in progress.

- [ ] **Step 2: Align the AI skill guide startup contract**

In `docs/rallar-ai-skill.md`, replace the startup rule with:

```markdown
4. Use `setup()` for initial app boot and `start()` for configured lifecycle continuation.
   Prefer `rallar.setup({ apiBaseUrl, applicationId, workspaceId, start })`
   when the app first configures the facade. After login or when configuration
   already exists, use `rallar.start({ connect: true, refreshRooms: true,
   refreshPeople: true })`.
```

Change the browser implementation workflow to call:

```ts
await rallar.setup({
    apiBaseUrl,
    applicationId: 'app',
    workspaceId: 'default',
    start: {
        refreshPeople: true
    }
});
```

State explicitly that this is `initial app boot`. Keep the after-login use of
`rallar.start(...)` in the auth guidance.

- [ ] **Step 3: Align prompting and troubleshooting**

In the App Startup section of `docs/rallar-ai-prompting-guide.md`, replace the
expected `configure`/`setDefaults`/`start` sequence with:

```ts
await rallar.setup({
    apiBaseUrl,
    applicationId,
    workspaceId,
    start: {
        refreshPeople: true
    }
});
```

Keep the Auth Flow requirement: `After login, call rallar.start with
refreshRooms and refreshPeople.`

In `docs/rallar-troubleshooting-checklist.md`, say initial configuration uses
`rallar.setup(...)`; configured reconnect/after-login flows may use
`rallar.start(...)`.

- [ ] **Step 4: Repair the Motion recipe**

In the Motion section of `docs/rallar-quickstart-and-recipes.md`:

- rename the RTC config object to `motionLaneConfig`;
- pass `motionLaneConfig` in `dataChannelLanes`;
- after startup, bind a room and typed channel:

```ts
const room = await rallar.rooms.enter('lobby');
const motionUpdates = room.realtime<PoseUpdate>({
    laneId: 'motion',
    waitTimeoutMs: 1000,
    key: `pose:${sessionId}`
});

motionUpdates.on((message) => {
    motion.push({
        entityId: message.peerId,
        observedAtEpochMs: message.receivedAtEpochMs,
        position: message.data.position,
        velocity: message.data.velocity,
        seq: message.data.seq,
        metadata: message.data
    });
});
```

Replace the send call with:

```ts
await motionUpdates.send(nextPose);
```

- [ ] **Step 5: Repair the RallarAI example import**

Add before the browser AI import in
`examples/rallar-ai-game-event/README.md`:

```ts
import { rallar } from '@shared-web/browser/rallar.ts';
```

Do not change proposal/validation/acceptance semantics.

- [ ] **Step 6: Run active documentation contracts**

Run:

```sh
npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts -t "startup and recipe"
npx vitest run packages/tests/shared-web/rallar-group-docs-compat.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the active documentation cleanup**

```sh
git add docs/README.md docs/rallar-ai-skill.md docs/rallar-ai-prompting-guide.md docs/rallar-troubleshooting-checklist.md docs/rallar-quickstart-and-recipes.md examples/rallar-ai-game-event/README.md
git commit -m "docs: align Rallar startup and app recipes"
```

---

### Task 6: Remove stale root application configuration

**Files:**

- Modify: `package.json`
- Modify: `tsconfig.json`

**Interfaces:**

- Consumes: current `*-v1` and Rallar black-box workspace commands.
- Produces: root commands and TypeScript references that target only existing applications/packages.

- [ ] **Step 1: Remove nonexistent app scripts**

Delete these exact `package.json` entries:

```json
"dev:web": "npm --workspace apps/web run dev",
"build:web": "npm --workspace apps/web run build",
"dev:api": "cd apps/api && deno task dev",
```

Keep `dev:api-v1`, both game app scripts, and all Rallar black-box aliases.

- [ ] **Step 2: Remove the nonexistent TypeScript project reference**

Delete this entry from root `tsconfig.json`:

```json
{
  "path": "apps/web"
}
```

Do not add app references whose own build is already owned by workspace scripts.

- [ ] **Step 3: Verify root config parsing and path integrity**

Run:

```sh
node -e "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')); JSON.parse(require('node:fs').readFileSync('tsconfig.json', 'utf8'))"
npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts -t "removed apps"
```

Expected: both commands PASS.

- [ ] **Step 4: Commit root config cleanup**

```sh
git add package.json tsconfig.json
git commit -m "chore: remove stale root app targets"
```

---

### Task 7: Complete validation and requirement-by-requirement audit

**Files:**

- Modify only if verification exposes a scoped defect in a file already named by this plan.

**Interfaces:**

- Consumes: the final canonical skill tree, docs, examples, tests, and root config.
- Produces: evidence for every completion criterion in the design specification.

- [ ] **Step 1: Run the full skill/documentation integrity contract**

```sh
npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts
```

Expected: PASS with all seven contracts green.

- [ ] **Step 2: Run focused existing contracts**

```sh
npx vitest run packages/tests/rallar-black-box/rallar-testing-skill.test.ts
npx vitest run packages/tests/shared-web/rallar-group-docs-compat.test.ts
```

Expected: PASS.

- [ ] **Step 3: Validate skill frontmatter and plugin metadata with available tooling**

Try:

```sh
python3 /Users/knuthelge/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/building-rallar-apps
python3 /Users/knuthelge/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

Expected in the current environment: SKIP with `ModuleNotFoundError: yaml` if
PyYAML remains unavailable. If available, both commands must PASS. In either
case, the dependency-free Vitest contract from Step 1 must pass.

- [ ] **Step 4: Build both audited example SPAs**

```sh
npm run build:ar-eye-hunter-v1
npm run build:relic-hunters-v1
```

Expected: both builds PASS. Existing bundle-size warnings are reported but are
not failures unless a build exits nonzero.

- [ ] **Step 5: Run the broader unit suite**

```sh
npm run test:unit
```

Expected: PASS.

- [ ] **Step 6: Search for migration and documentation regressions**

```sh
rg -n "apps/web|apps/api(?!-v1)|(?<!\.agents/)skills/\*\*|motionLane\.send" AGENTS.md docs examples projects/cash-chase-arena package.json tsconfig.json .codex-plugin .agents/skills --pcre2
```

Expected: no active stale config/discovery/Motion matches. Historical evidence
inside the committed design/spec is allowed only when it explicitly describes
the former state.

- [ ] **Step 7: Perform the completion audit**

Confirm with direct file/test evidence:

1. exactly nine canonical skill directories exist under `.agents/skills`;
2. the plugin points to the canonical tree and has at most three prompts;
3. `building-rallar-apps` and all three references pass retrieval and forward
   scenarios;
4. active docs consistently explain setup/start and React/3D boundaries;
5. the Motion snippet, AI import, docs link, cross-skill references, and
   performance placeholders are fixed;
6. stale root app scripts/reference are absent;
7. both SPAs build;
8. focused and broad tests pass, with the optional Python validator accurately
   reported as passed or skipped.

- [ ] **Step 8: Resolve any verification failure at its owning task**

If verification fails, return to the task that owns the named file, add the
smallest regression assertion to that task's focused test, apply the correction,
rerun that task's exact focused commands, and then rerun Task 7 from Step 1.
Do not create a verification-only commit when no correction was needed.
