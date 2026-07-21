import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
    'rallar-testing',
] as const;

describe('Rallar repo skill and documentation integrity', () => {
    it('uses one directly discoverable skill tree for the plugin', () => {
        const plugin = readJson('.codex-plugin/plugin.json') as {
            skills?: string;
            interface?: { defaultPrompt?: readonly string[] };
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
                    `${skillPath} -> ${reference[1]}`,
                ).toBe(true);
            }
        }
    });

    it('provides the greenfield app workflow and audited evidence map', () => {
        const skill = readRepo('.agents/skills/building-rallar-apps/SKILL.md');
        const scaffolding = readRepo(
            '.agents/skills/building-rallar-apps/references/app-scaffolding.md',
        );
        const architecture = readRepo(
            '.agents/skills/building-rallar-apps/references/react-3d-architecture.md',
        );
        const exampleMap = readRepo(
            '.agents/skills/building-rallar-apps/references/example-map.md',
        );
        const messageExample = readRepo('examples/room-message-channel/README.md');
        const realtimeExample = readRepo('examples/room-realtime-channel/README.md');
        const examplesIndex = readRepo('examples/README.md');
        const initialBoot = scaffolding.match(
            /## Initial Boot\n([\s\S]*?)\n## Room-Bound Vertical Slice/,
        )?.[1] ?? '';
        const verticalSlice = scaffolding.match(
            /## Room-Bound Vertical Slice\n([\s\S]*?)\n## Runtime Adapter/,
        )?.[1] ?? '';
        const runtimeAdapter = scaffolding.match(
            /## Runtime Adapter\n([\s\S]*?)\n## React Adapter/,
        )?.[1] ?? '';

        expectAll(skill, [
            '`references/app-scaffolding.md`',
            '`references/react-3d-architecture.md`',
            '`references/example-map.md`',
            'rallar.setup',
            'roomRef',
        ]);
        expectAll(scaffolding, [
            'apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts',
            'rallar.rooms.enter',
            'rallar.rooms.createAndSwitch',
            'AbortController',
        ]);
        expectAll(architecture, [
            'Direct Three.js',
            'React Three Fiber',
            'no per-frame React state',
            'Rallar Motion',
            'dispose',
        ]);
        expectAll(exampleMap, [
            'examples/browser-startup-room',
            'examples/room-message-channel',
            'examples/room-realtime-channel',
            'examples/motion-smoothing',
            'apps/ar-eye-hunter-v1',
            'apps/relic-hunters-v1',
            'projects/cash-chase-arena',
        ]);
        expect.soft({
            verticalMessageTargets: verticalSlice.includes('message.raw.targets'),
            verticalMessageGroupRefCheck: verticalSlice.includes('isSameGroupRef'),
            verticalMessageCallbackValidations:
                verticalSlice.match(/isMessageForRoom\(roomRef, message\)/g)?.length === 2,
            scaffoldingRealtimePayloadRoomRef: scaffolding.includes('roomRef: GroupRef'),
            scaffoldingRealtimeGroupRefCheck: scaffolding.includes(
                'message.data.roomRef',
            ),
            messageExampleTargets: messageExample.includes('message.raw.targets'),
            messageExampleGroupRefCheck: messageExample.includes('isSameGroupRef'),
            realtimeExamplePayloadRoomRef: realtimeExample.includes(
                'message.data.roomRef',
            ),
            realtimeExampleGroupRefCheck: realtimeExample.includes('isSameGroupRef'),
            examplesIndexReceiveBoundary: examplesIndex.includes(
                'not automatically room-filtered',
            ),
        }).toEqual({
            verticalMessageTargets: true,
            verticalMessageGroupRefCheck: true,
            verticalMessageCallbackValidations: true,
            scaffoldingRealtimePayloadRoomRef: true,
            scaffoldingRealtimeGroupRefCheck: true,
            messageExampleTargets: true,
            messageExampleGroupRefCheck: true,
            realtimeExamplePayloadRoomRef: true,
            realtimeExampleGroupRefCheck: true,
            examplesIndexReceiveBoundary: true,
        });
        expect.soft({
            readyResult: scaffolding.includes('const readyResult = await ready.send'),
            poseResult: scaffolding.includes('const poseResult = await poses.send'),
            acceptedMessageStatuses: scaffolding.includes("'sent-immediate'"),
            degradedRealtimeResult: scaffolding.includes("poseResult.status !== 'sent'"),
            messageExampleResult: messageExample.includes('sendResult.status'),
            realtimeExampleResult: realtimeExample.includes("sendResult.status !== 'sent'"),
        }).toEqual({
            readyResult: true,
            poseResult: true,
            acceptedMessageStatuses: true,
            degradedRealtimeResult: true,
            messageExampleResult: true,
            realtimeExampleResult: true,
        });
        expect.soft({
            viteConfig: scaffolding.includes('vite.config.ts'),
            sharedWebAlias: scaffolding.includes("'@shared-web'"),
            bundlerResolution: scaffolding.includes('"moduleResolution": "Bundler"'),
            strictPort: scaffolding.includes('strictPort: true'),
            websocketProxy: scaffolding.includes('ws: true'),
            appLocalRenderer: scaffolding.includes('app-local renderer dependencies'),
        }).toEqual({
            viteConfig: true,
            sharedWebAlias: true,
            bundlerResolution: true,
            strictPort: true,
            websocketProxy: true,
            appLocalRenderer: true,
        });
        expect.soft({
            oneAppStartOptions:
                initialBoot.match(/const appStartOptions/g)?.length === 1,
            posesLaneConfig: initialBoot.includes('const posesLaneConfig'),
            posesLaneId: initialBoot.includes("id: 'poses'"),
            defaultRealtimeLane: initialBoot.includes(
                'DEFAULT_REALTIME_DATA_CHANNEL_LANE',
            ),
            laneBearingStartOptions: initialBoot.includes(
                'dataChannelLanes: [DEFAULT_REALTIME_DATA_CHANNEL_LANE, posesLaneConfig]',
            ),
            setupStartOptions: initialBoot.includes('start: appStartOptions'),
            postLoginStartOptions: initialBoot.includes(
                'rallar.start(appStartOptions)',
            ),
        }).toEqual({
            oneAppStartOptions: true,
            posesLaneConfig: true,
            posesLaneId: true,
            defaultRealtimeLane: true,
            laneBearingStartOptions: true,
            setupStartOptions: true,
            postLoginStartOptions: true,
        });
        expect.soft({
            runtimeMessageType: runtimeAdapter.includes('RallarMessage'),
            runtimeTargetNarrowing: runtimeAdapter.includes('message.raw.targets'),
            runtimeFullGroupRefCheck: runtimeAdapter.includes('isSameGroupRef'),
            runtimeCallbackValidation: runtimeAdapter.includes(
                'isMessageForRoom(roomSession.roomRef, message)',
            ),
        }).toEqual({
            runtimeMessageType: true,
            runtimeTargetNarrowing: true,
            runtimeFullGroupRefCheck: true,
            runtimeCallbackValidation: true,
        });
        expect.soft({
            returnsDisposer: verticalSlice.includes(
                'Promise<() => void>',
            ),
            exposesSubscriptionCleanup: verticalSlice.includes(
                'return () => subscriptions.unsubscribe()',
            ),
            capturesDisposer: verticalSlice.includes(
                'const disposeArena = await openArena()',
            ),
            invokesDisposer: verticalSlice.includes('disposeArena()'),
            failureCleansSubscriptions: verticalSlice.includes(
                'catch (error) {\n        subscriptions.unsubscribe();\n        throw error;\n    }',
            ),
        }).toEqual({
            returnsDisposer: true,
            exposesSubscriptionCleanup: true,
            capturesDisposer: true,
            invokesDisposer: true,
            failureCleansSubscriptions: true,
        });
    });

    it('routes composition and validation from the specialist skills', () => {
        const agents = readRepo('AGENTS.md');
        const convergenceArchitecture = readRepo(
            'docs/rallar-convergent-state-and-rtc-topology.md',
        );
        const platform = readRepo('.agents/skills/rallar-platform/SKILL.md');
        const codeWriting = readRepo('.agents/skills/rallar-code-writing/SKILL.md');
        const repoCodeStyle = readRepo(
            '.agents/skills/rallar-code-writing/references/repo-code-style.md',
        );
        const games = readRepo('.agents/skills/rallar-games/SKILL.md');
        const realtime = readRepo('.agents/skills/rallar-realtime/SKILL.md');
        const testing = readRepo('.agents/skills/rallar-testing/SKILL.md');
        const testCommands = readRepo(
            '.agents/skills/rallar-testing/references/test-commands.md',
        );

        expect(platform).toContain('building-rallar-apps');
        expect(games).toContain('building-rallar-apps');
        expect(games).toContain('Use the `rallar-testing` skill');
        expect(realtime).toContain('building-rallar-apps');
        expectAll(games, ['message.raw.targets', 'realtime payload', 'roomRef']);
        expectAll(realtime, ['message.raw.targets', 'realtime payload', 'roomRef']);
        expect(platform).toContain('Required fields are the default');
        expect(platform).toMatch(/absence is a meaningful domain\s+state/);
        expect(platform).toMatch(/explicitly ask\s+the human/);
        expectAll(platform, [
            'optimistic compare-and-set writes with bounded retries',
            'authoritative persisted, replicated, queued, event, snapshot, and response',
            'Database row, table, and advisory locks are not the default',
        ]);
        expectAll(codeWriting, [
            'Always read `references/repo-code-style.md`',
            'Prefer required contracts and explicit value flow',
            'No compatibility fallback unless the human explicitly approved',
        ]);
        expectAll(repoCodeStyle, [
            'discriminated union',
            'Create with conditional insert',
            'Update with expected-revision compare-and-set',
            'A stale expiry read must not delete a value that has since been refreshed',
            'Every retry must re-read and rerun authorization',
        ]);
        expectAll(realtime, [
            'optimistic reconciliation',
            'Ignore stale observations',
            'compare-and-set writes with bounded retries',
            'Database row, table, and advisory locks are not the default',
            'Re-read and re-run authorization, policy, capacity, lifecycle, and invariants',
        ]);
        expectAll(agents, [
            'Optimistic compare-and-set writes with bounded retries are the default',
            'Database row, table, and advisory locks are exceptional',
            'Authoritative persisted, replicated, queued, event, snapshot, and response',
        ]);
        expectAll(convergenceArchitecture, [
            'Required Target For Database Writes',
            'Current advisory-lock implementations are migration debt',
            'conditional insert',
            'expected-revision compare-and-set',
            'expected-revision conditional delete',
        ]);
        expect(testing).toContain('rallar-skill-integrity.test.ts');
        expect(testCommands).toContain(
            'npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts',
        );
    });

    it('routes active repo guidance through the canonical skill location', () => {
        for (const filePath of [
            'AGENTS.md',
            'docs/README.md',
            'projects/cash-chase-arena/Cash_Chase_Arena_Codex_Prompt_Pack.md',
        ]) {
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
        expect.soft({
            oneQuickstartSetup: quickstart.match(/rallar\.setup\(setup\)/g)?.length === 1,
            postLoginStart: quickstart.includes('started = await rallar.start(setup.start)'),
        }).toEqual({
            oneQuickstartSetup: true,
            postLoginStart: true,
        });
        expect.soft({
            standaloneMotionSetup: quickstart.includes('standalone initial setup'),
            sharedMotionStartOptions: quickstart.includes('const motionStartOptions'),
            setupUsesMotionStartOptions: quickstart.includes('start: motionStartOptions'),
            loginUsesMotionStartOptions: quickstart.includes(
                'rallar.start(motionStartOptions)',
            ),
            lanesConfiguredBeforeConnection: quickstart.includes('dataChannelLanes'),
        }).toEqual({
            standaloneMotionSetup: true,
            sharedMotionStartOptions: true,
            setupUsesMotionStartOptions: true,
            loginUsesMotionStartOptions: true,
            lanesConfiguredBeforeConnection: true,
        });
        expect(quickstart).not.toContain('motionLane.send(');
        expectAll(quickstart, [
            "const motionUpdates = room.realtime<PoseUpdate>",
            'await motionUpdates.send(nextPose)',
        ]);
        expect(aiExample).toContain(
            "import { rallar } from '@shared-web/browser/rallar.ts';",
        );
        expect(docsIndex).toContain(
            './rallar-api-v1-in-memory-performance-mode.md',
        );
        expect(docsIndex).not.toContain(
            '../iterations/completed/rallar-api-v1-in-memory-sql-performance-mode.md',
        );
        expect(
            existsSync(
                path.join(
                    repoRoot,
                    'docs/rallar-api-v1-in-memory-performance-mode.md',
                ),
            ),
        ).toBe(true);
    });

    it('does not expose root commands or project references for removed apps', () => {
        const packageJson = readJson('package.json') as { scripts?: Record<string, string> };
        const tsconfig = readJson('tsconfig.json') as {
            references?: readonly { path?: string }[];
        };

        expect(packageJson.scripts).not.toHaveProperty('dev:web');
        expect(packageJson.scripts).not.toHaveProperty('build:web');
        expect(packageJson.scripts).not.toHaveProperty('dev:api');
        for (const command of Object.values(packageJson.scripts ?? {})) {
            expect(command).not.toContain('apps/web');
            expect(command).not.toMatch(/\bapps\/api(?:\s|$)/);
        }
        expect(tsconfig.references?.map((reference) => reference.path)).not.toContain(
            'apps/web',
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
    filePath: string,
): Readonly<{ name: string; description: string }> {
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
