import { describe, expect, it } from 'vitest';
import {
    buildDistributedRunManifest,
    compareDistributedRuns,
    defaultDistributedRecipeTargetIds,
    deriveDistributedRunMonitor,
    distributedRecipeCommandKinds,
    distributedRecipeCommandPreview,
    distributedRecipePreflight,
    distributedRecipeStateTone,
    distributedRecipeTargetRows,
    filterDistributedRuns,
    type DistributedRecipeCatalogItem,
} from '../../../apps/rallar-black-box/src/distributed-recipes.ts';
import {
    RALLAR_BLACK_BOX_RECIPE_FIXTURES,
    RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS,
    RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
    createRallarBlackBoxRtcRealtimeRecipe,
} from '../../../apps/rallar-black-box/src/recipe-fixtures.ts';
import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
} from '../../../apps/rallar-black-box/src/control-run-manager.ts';
import {
    createRallarBlackBoxTestRuntime,
    selectRallarBlackBoxCommandHistory,
} from '../../shared-test/rallar-bb-test/mod.ts';

const runSnapshot: ControlRunSnapshot = {
    runId: 'run-1',
    createdAtEpochMs: 1_000,
    updatedAtEpochMs: 2_000,
    agents: [
        {
            runId: 'run-1',
            agentId: 'agent-a',
            connected: true,
            lastHeartbeatAtEpochMs: 2_000,
            identity: {
                principalId: 'alice',
                sessionId: 'session-a',
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'bb-group',
            },
            connectionSequence: 1,
            reconnectCount: 0,
            receivedResultCount: 0,
            receivedEventCount: 0,
            completedCommandIds: [],
            resumeCompletedCommandIds: [],
        },
        {
            runId: 'run-1',
            agentId: 'agent-b',
            connected: false,
            lastHeartbeatAtEpochMs: 1_900,
            identity: {
                principalId: 'bob',
                sessionId: 'session-b',
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'bb-group',
            },
            connectionSequence: 1,
            reconnectCount: 0,
            receivedResultCount: 0,
            receivedEventCount: 0,
            completedCommandIds: [],
            resumeCompletedCommandIds: [],
        },
        {
            runId: 'run-1',
            agentId: 'agent-c',
            connected: true,
            lastHeartbeatAtEpochMs: 2_000,
            identity: {
                principalId: 'carol',
                sessionId: 'session-c',
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'other-group',
            },
            connectionSequence: 1,
            reconnectCount: 0,
            receivedResultCount: 0,
            receivedEventCount: 0,
            completedCommandIds: [],
            resumeCompletedCommandIds: [],
        },
    ],
    commands: [],
    results: [],
    events: [],
    stats: [],
    reports: [],
    heartbeats: [],
};

const recipe: DistributedRecipeCatalogItem = {
    itemId: 'health',
    title: 'Health',
    description: 'Health smoke.',
    providerMode: 'browser-rallar',
    profiles: ['smoke'],
    prerequisites: ['connected agents'],
    live: false,
    source: 'app-local',
    recipe: {
        recipeId: 'health-only',
        commands: [{ kind: 'health' }],
    },
};

const distributedRun: ControlDistributedRunSnapshot = {
    distributedRunId: 'dist-1',
    controlRunId: 'run-1',
    state: 'failed',
    createdAtEpochMs: 1_000,
    updatedAtEpochMs: 2_200,
    stagedAtEpochMs: 1_100,
    startedAtEpochMs: 1_500,
    completedAtEpochMs: 2_200,
    targetAgentIds: ['agent-a', 'agent-b'],
    manifest: {
        schemaVersion: 1,
        distributedRunId: 'dist-1',
        controlRunId: 'run-1',
        displayName: 'Health distributed',
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'bb-group',
        },
        recipes: [{
            recipeId: 'health-only',
            recipe: recipe.recipe,
            profile: 'smoke',
            required: true,
        }],
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: ['agent-a', 'agent-b'],
            expectedParticipantCount: 2,
        },
        roleAssignments: [
            { agentId: 'agent-a', role: 'sender', required: true },
            { agentId: 'agent-b', role: 'receiver', required: true },
        ],
        metadata: {
            createdBy: 'alice',
        },
    },
    commandLinks: [
        { phase: 'stage', agentId: 'agent-a', commandId: 'stage-a', recipeId: 'health-only', queuedAtEpochMs: 1_110 },
        { phase: 'stage', agentId: 'agent-b', commandId: 'stage-b', recipeId: 'health-only', queuedAtEpochMs: 1_120 },
        { phase: 'start', agentId: 'agent-a', commandId: 'start-a', recipeId: 'health-only', queuedAtEpochMs: 1_510 },
        { phase: 'start', agentId: 'agent-b', commandId: 'start-b', recipeId: 'health-only', queuedAtEpochMs: 1_520 },
    ],
    rollup: {
        state: 'failed',
        ok: false,
        summary: {
            participants: 2,
            requiredParticipants: 2,
            readyParticipants: 2,
            passedParticipants: 1,
            failedParticipants: 1,
            recipes: 1,
            requiredRecipes: 1,
            passedRecipes: 0,
            failedRecipes: 1,
            blockingFailures: 1,
        },
        failures: [{
            kind: 'recipe',
            key: 'health-only',
            state: 'failed',
            required: true,
            error: {
                code: 'RECIPE_FAILED',
                message: 'Receiver did not observe payload.',
            },
        }],
    },
};

const distributedControlRun: ControlRunSnapshot = {
    ...runSnapshot,
    commands: [
        {
            envelope: {
                kind: 'command',
                protocolVersion: 1,
                runId: 'run-1',
                agentId: 'agent-a',
                commandId: 'stage-a',
                command: { kind: 'recipe.load', recipe: recipe.recipe },
            },
            queuedAtEpochMs: 1_110,
            dispatchedAtEpochMs: 1_130,
            completedAtEpochMs: 1_210,
            dispatchCount: 1,
        },
        {
            envelope: {
                kind: 'command',
                protocolVersion: 1,
                runId: 'run-1',
                agentId: 'agent-b',
                commandId: 'stage-b',
                command: { kind: 'recipe.load', recipe: recipe.recipe },
            },
            queuedAtEpochMs: 1_120,
            dispatchedAtEpochMs: 1_140,
            completedAtEpochMs: 1_230,
            dispatchCount: 1,
        },
        {
            envelope: {
                kind: 'command',
                protocolVersion: 1,
                runId: 'run-1',
                agentId: 'agent-a',
                commandId: 'start-a',
                command: { kind: 'recipe.run', recipe: recipe.recipe },
            },
            queuedAtEpochMs: 1_510,
            dispatchedAtEpochMs: 1_530,
            completedAtEpochMs: 1_900,
            dispatchCount: 1,
        },
        {
            envelope: {
                kind: 'command',
                protocolVersion: 1,
                runId: 'run-1',
                agentId: 'agent-b',
                commandId: 'start-b',
                command: { kind: 'recipe.run', recipe: recipe.recipe },
            },
            queuedAtEpochMs: 1_520,
            dispatchedAtEpochMs: 1_540,
            completedAtEpochMs: 2_000,
            dispatchCount: 1,
        },
    ],
    results: [
        {
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'agent-a',
            commandId: 'stage-a',
            ok: true,
            result: {
                commandId: 'stage-a',
                kind: 'recipe.load',
                status: 'ok',
                ok: true,
                startedAtEpochMs: 1_130,
                endedAtEpochMs: 1_210,
                durationMs: 80,
            },
        },
        {
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'agent-b',
            commandId: 'stage-b',
            ok: true,
            result: {
                commandId: 'stage-b',
                kind: 'recipe.load',
                status: 'ok',
                ok: true,
                startedAtEpochMs: 1_140,
                endedAtEpochMs: 1_230,
                durationMs: 90,
            },
        },
        {
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'agent-a',
            commandId: 'start-a',
            ok: true,
            result: {
                commandId: 'start-a',
                kind: 'recipe.run',
                status: 'ok',
                ok: true,
                startedAtEpochMs: 1_530,
                endedAtEpochMs: 1_900,
                durationMs: 370,
            },
        },
        {
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'agent-b',
            commandId: 'start-b',
            ok: false,
            error: {
                code: 'ASSERTION_FAILED',
                message: 'No received payload.',
            },
            result: {
                commandId: 'start-b',
                kind: 'recipe.run',
                status: 'failed',
                ok: false,
                startedAtEpochMs: 1_540,
                endedAtEpochMs: 2_000,
                durationMs: 460,
                error: {
                    code: 'ASSERTION_FAILED',
                    message: 'No received payload.',
                },
            },
        },
    ],
    events: [{
        kind: 'event',
        protocolVersion: 1,
        runId: 'run-1',
        agentId: 'agent-a',
        commandId: 'start-a',
        eventId: 'message-a',
        atEpochMs: 1_700,
        payload: {
            distributedRunId: 'dist-1',
            topic: 'message.received',
            message: 'payload received',
        },
    }],
};

const distributedArtifactBundle: ControlDistributedRunArtifactBundle = {
    artifactSchemaVersion: 1,
    distributedRunId: 'dist-1',
    generatedAtEpochMs: 2_500,
    files: {
        'distributed-run.json': JSON.stringify(distributedRun),
        'manifest.json': JSON.stringify(distributedRun.manifest),
        'control-run.json': JSON.stringify(distributedControlRun),
    },
};

describe('distributed recipes helpers', () => {
    it('builds the configurable RTC realtime recipe with a compact looped 20 Hz command cadence', () => {
        const recipe = createRallarBlackBoxRtcRealtimeRecipe({
            durationSeconds: 2,
            group: {
                applicationId: 'game-app',
                workspaceId: 'live',
                groupId: 'arena-1',
            },
        });
        const loopCommand = recipe.commands.find(command => command.kind === 'loop') as
            | Extract<typeof recipe.commands[number], { kind: 'loop' }>
            | undefined;
        const sendCommand = loopCommand?.commands[0] as
            | Extract<typeof recipe.commands[number], { kind: 'rtc.send' }>
            | undefined;
        const firstPayload = sendCommand?.send as {
            roomId?: string;
            roomRef?: Record<string, unknown>;
            data?: Record<string, unknown>;
        } | undefined;
        const preview = distributedRecipeCommandPreview(recipe);

        expect(recipe.recipeId).toBe('rtc-realtime');
        expect(recipe.commands).toHaveLength(3);
        expect(loopCommand).toMatchObject({
            kind: 'loop',
            commandId: 'rtc-realtime-position-loop',
            count: 40,
            intervalMs: RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS,
            maxCommands: 40,
        });
        expect(loopCommand?.commands).toHaveLength(1);
        expect(sendCommand?.commandId).toBe('rtc-realtime-position');
        expect(sendCommand?.metadata).toMatchObject({
            realtime: {
                rateHz: 20,
                durationSeconds: 2,
                frame: '{loop.iteration}',
                totalFrames: 40,
            },
        });
        expect(sendCommand?.roomRef).toEqual({
            applicationId: 'game-app',
            workspaceId: 'live',
            groupId: 'arena-1',
        });
        expect(firstPayload?.roomId).toBe('arena-1');
        expect(firstPayload?.data).toMatchObject({
            topic: 'room.black-box.rtc-realtime.position',
            actor: '{auth.clientId}',
            seq: '{loop.index}',
            rateHz: 20,
            durationSeconds: 2,
            totalFrames: 40,
            tMs: '{loop.elapsedMs}',
            position: {
                frame: '{loop.iteration}',
                x: '{loop.index}',
                y: 0,
                z: '{loop.index}',
            },
        });
        expect(recipe.metadata).toMatchObject({
            profile: 'rtc-realtime',
            rateHz: 20,
            durationSeconds: 2,
            frameCount: 40,
        });
        expect(preview).toEqual({
            manifestCommandCount: 3,
            effectiveCommandCount: 42,
            effectiveFrameCount: 40,
            label: '3 manifest commands - 42 effective operations - 40 frames',
        });
    });

    it('derives nested composite command kinds and preview counts for app-local fixtures', () => {
        const fixture = RALLAR_BLACK_BOX_RECIPE_FIXTURES.find(entry =>
            entry.fixtureId === 'composite-evidence'
        );

        expect(fixture).toBeDefined();
        const recipe = fixture!.recipe;

        expect(distributedRecipeCommandKinds(recipe)).toEqual([
            'assert',
            'health',
            'loop',
            'parallel',
            'stats',
            'wait',
        ]);
        expect(distributedRecipeCommandPreview(recipe)).toEqual({
            manifestCommandCount: 5,
            effectiveCommandCount: 7,
            effectiveFrameCount: undefined,
            label: '5 manifest commands - 7 effective operations',
        });
    });

    it('derives distributed recipe preflight for composite evidence recipes', () => {
        const fixture = RALLAR_BLACK_BOX_RECIPE_FIXTURES.find(entry =>
            entry.fixtureId === 'composite-evidence'
        );
        const preflight = distributedRecipePreflight(fixture!.recipe);

        expect(preflight).toMatchObject({
            recipeId: 'composite-evidence-recipe',
            manifestCommandCount: 5,
            effectiveCommandCount: 7,
            maxDepth: 2,
            errors: [],
        });
        expect(preflight.commandKinds).toEqual([
            'assert',
            'health',
            'loop',
            'parallel',
            'stats',
            'wait',
        ]);
        expect(preflight.loops).toEqual([expect.objectContaining({
            commandId: 'composite-health-loop',
            estimatedIterations: 2,
            childCommandCount: 1,
            effectiveCommandCount: 2,
        })]);
        expect(preflight.parallelGroups).toEqual([expect.objectContaining({
            commandId: 'parallel-evidence',
            groupCount: 2,
            maxConcurrency: 2,
            groups: ['left-health', 'right-stats'],
        })]);
        expect(preflight.waits[0]).toMatchObject({
            commandId: 'wait-for-parallel-result',
            timeoutMs: 1_000,
        });
        expect(preflight.waits[0].matchSummary).toContain('commandId=parallel-evidence');
        expect(preflight.asserts[0]).toMatchObject({
            commandId: 'assert-wait-succeeded',
            predicate: 'lastResult.ok equals true',
        });
        expect(preflight.warnings).toEqual(expect.arrayContaining([
            expect.stringContaining('wait can time out'),
            expect.stringContaining('assert fails the recipe'),
        ]));
        expect(preflight.serviceBadges.map(badge => badge.label)).toEqual(expect.arrayContaining([
            'control server',
            'browser agents',
            'runtime evidence',
            'looped traffic',
            'parallel groups',
        ]));
        expect(preflight.tree.map(row => row.label)).toEqual([
            'composite-health-loop',
            'Loop health',
            'parallel-evidence',
            'parallel-left-health',
            'parallel-right-stats',
            'wait-for-parallel-result',
            'assert-wait-succeeded',
            'composite-evidence-stats',
        ]);
    });

    it('derives live RTC realtime preflight with frame and service warnings', () => {
        const recipe = createRallarBlackBoxRtcRealtimeRecipe({
            durationSeconds: 2,
            group: {
                applicationId: 'game-app',
                workspaceId: 'live',
                groupId: 'arena-1',
            },
        });
        const preflight = distributedRecipePreflight(recipe);

        expect(preflight).toMatchObject({
            recipeId: 'rtc-realtime',
            manifestCommandCount: 3,
            effectiveCommandCount: 42,
            effectiveFrameCount: 40,
            errors: [],
        });
        expect(preflight.loops[0]).toMatchObject({
            commandId: 'rtc-realtime-position-loop',
            estimatedIterations: 40,
            intervalMs: RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS,
            frameCount: 40,
        });
        expect(preflight.commandKinds).toEqual(['loop', 'rtc.connect', 'rtc.send', 'stats']);
        expect(preflight.liveServiceRequirements).toEqual(expect.arrayContaining([
            'Rallar API and signaling when provider mode is browser-rallar or rallar-browser',
            'active RTC connection',
        ]));
        expect(preflight.serviceBadges.map(badge => badge.label)).toEqual(expect.arrayContaining([
            'Rallar auth/signaling',
            'RTC peers',
            'looped traffic',
        ]));
        expect(preflight.warnings).toEqual(expect.arrayContaining([
            expect.stringContaining('RTC recipes require real Rallar signaling'),
        ]));
        expect(preflight.tree.map(row => [row.kind, row.summary])).toEqual([
            ['rtc.connect', 'connect RTC - rtcRealtime - arena-1'],
            ['loop', 'loop x40'],
            ['rtc.send', 'send RTC - rtcRealtime - arena-1'],
            ['stats', 'agent stats'],
        ]);
    });

    it('runs the app-local composite evidence fixture in the browser-agent runtime', async () => {
        const fixture = RALLAR_BLACK_BOX_RECIPE_FIXTURES.find(entry =>
            entry.fixtureId === 'composite-evidence'
        );
        const runtime = createRallarBlackBoxTestRuntime();

        for (const command of fixture!.recipe.commands) {
            const result = await runtime.execute(command);
            expect(result.ok, result.error?.message).toBe(true);
        }

        const history = selectRallarBlackBoxCommandHistory(runtime.state());

        expect(history).toHaveLength(9);
        expect(history.map(result => result.commandId)).toEqual(expect.arrayContaining([
            'composite-health-loop:i1:c1:loop-health',
            'composite-health-loop:i2:c1:loop-health',
            'composite-health-loop',
            'parallel-evidence:g1:left-health:c1:parallel-left-health',
            'parallel-evidence:g2:right-stats:c1:parallel-right-stats',
            'parallel-evidence',
            'wait-for-parallel-result',
            'assert-wait-succeeded',
            'composite-evidence-stats',
        ]));
        expect(history.at(-1)?.commandId).toBe('composite-evidence-stats');
        expect(runtime.state().resultCache['wait-for-parallel-result'].ok).toBe(true);
        expect(runtime.state().resultCache['assert-wait-succeeded'].ok).toBe(true);
    });

    it('derives target rows from control-agent Rallar identity', () => {
        const rows = distributedRecipeTargetRows({
            run: runSnapshot,
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'bb-group',
            },
            nowEpochMs: 2_500,
        });

        expect(rows.map(row => [row.agentId, row.status, row.targetable])).toEqual([
            ['agent-a', 'matched', true],
            ['agent-b', 'offline', false],
            ['agent-c', 'different-group', false],
        ]);
        expect(defaultDistributedRecipeTargetIds(rows)).toEqual(['agent-a']);
    });

    it('builds role-map distributed manifests for sender receiver patterns', () => {
        const manifest = buildDistributedRunManifest({
            distributedRunId: 'dist-1',
            controlRunId: 'run-1',
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'bb-group',
            },
            recipes: [recipe, { ...recipe, itemId: 'health-2', recipe: { ...recipe.recipe, recipeId: 'health-two' } }],
            targetAgentIds: ['agent-a', 'agent-b'],
            targetPolicyMode: 'role-map',
            rolePattern: 'sender-receiver',
            ackTimeoutMs: 5_000,
            startMode: 'manual',
            expectedParticipantCount: 2,
        });

        expect(manifest.targetPolicy).toMatchObject({
            mode: 'role-map',
            expectedParticipantCount: 2,
            roles: {
                sender: ['agent-a'],
                receiver: ['agent-b'],
            },
        });
        expect(manifest.recipes.map(selection => selection.role)).toEqual(['sender', 'receiver']);
        expect(manifest.roleAssignments?.map(assignment => [assignment.agentId, assignment.role])).toEqual([
            ['agent-a', 'sender'],
            ['agent-b', 'receiver'],
        ]);
    });

    it('maps distributed states to UI tones', () => {
        expect(distributedRecipeStateTone('ready')).toBe('good');
        expect(distributedRecipeStateTone('running')).toBe('active');
        expect(distributedRecipeStateTone('timed-out')).toBe('bad');
        expect(distributedRecipeStateTone('cancelled')).toBe('warn');
    });

    it('derives distributed run monitor evidence from command links and control run snapshots', () => {
        const monitor = deriveDistributedRunMonitor({
            distributedRun,
            controlRun: distributedControlRun,
            artifactBundle: distributedArtifactBundle,
        });

        expect(monitor.commandCounts).toMatchObject({
            total: 4,
            stage: 2,
            start: 2,
            completed: 4,
            failed: 1,
            pending: 0,
        });
        expect(monitor.resultCounts).toEqual({ total: 4, ok: 3, failed: 1 });
        expect(monitor.diagnosticCounts.total).toBe(0);
        expect(monitor.artifact.status).toBe('valid');
        expect(monitor.readiness.map(row => [row.agentId, row.status])).toEqual([
            ['agent-a', 'ready'],
            ['agent-b', 'ready'],
        ]);
        expect(monitor.agentProgress.map(row => [row.agentId, row.readiness, row.execution])).toEqual([
            ['agent-a', 'ready', 'passed'],
            ['agent-b', 'ready', 'failed'],
        ]);
        expect(monitor.recipeProgress[0]).toMatchObject({
            recipeId: 'health-only',
            passedCount: 1,
            failedCount: 1,
        });
        expect(monitor.events.map(event => event.summary)).toEqual(['payload received']);
        expect(monitor.failures.map(failure => failure.code)).toContain('ASSERTION_FAILED');
        expect(monitor.timeline.map(item => item.label)).toContain('result failed');
    });

    it('derives composite drilldowns and child failure focus for distributed recipe runs', async () => {
        const compositeRecipe = {
            recipeId: 'composite-evidence',
            commands: [{
                kind: 'parallel',
                commandId: 'root-parallel',
                maxConcurrency: 1,
                groups: [
                    {
                        groupId: 'left',
                        commands: [{
                            kind: 'loop',
                            commandId: 'frame-loop',
                            count: 2,
                            commands: [{
                                kind: 'rtc.send',
                                commandId: 'position-send',
                                send: {
                                    frame: '{loop.iteration}',
                                },
                            }],
                        }],
                    },
                    {
                        groupId: 'right',
                        commands: [
                            {
                                kind: 'wait',
                                commandId: 'wait-ready',
                                match: {
                                    topic: 'rallar.test.ready',
                                    payloadPath: 'state',
                                    equals: 'ready',
                                },
                            },
                            {
                                kind: 'assert',
                                commandId: 'assert-event-count',
                                source: 'events.length',
                                operator: 'gte',
                                expected: 99,
                            },
                        ],
                    },
                ],
            }],
        } satisfies DistributedRecipeCatalogItem['recipe'];
        let now = 3_000;
        const runtime = createRallarBlackBoxTestRuntime({
            now: () => {
                now += 10;
                return now;
            },
        });
        runtime.recordEvent({
            kind: 'message',
            topic: 'rallar.test.ready',
            payload: {
                state: 'ready',
            },
        });
        const compositeResult = await runtime.execute({
            kind: 'recipe.run',
            commandId: 'start-b',
            recipe: compositeRecipe,
        });
        const compositeRun: ControlDistributedRunSnapshot = {
            ...distributedRun,
            manifest: {
                ...distributedRun.manifest,
                recipes: [{
                    recipeId: 'composite-evidence',
                    recipe: compositeRecipe,
                    profile: 'composite',
                    required: true,
                }],
            },
            commandLinks: distributedRun.commandLinks.map(link => ({
                ...link,
                recipeId: 'composite-evidence',
            })),
            rollup: {
                ...distributedRun.rollup,
                failures: [{
                    kind: 'recipe',
                    key: 'composite-evidence',
                    state: 'failed',
                    required: true,
                    error: {
                        code: 'RECIPE_FAILED',
                        message: 'Composite recipe failed.',
                    },
                }],
            },
        };
        const controlRunWithComposite: ControlRunSnapshot = {
            ...distributedControlRun,
            results: distributedControlRun.results.map(result => result.commandId === 'start-b'
                ? {
                    ...result,
                    ok: false,
                    error: compositeResult.error,
                    result: compositeResult,
                }
                : result),
        };

        const monitor = deriveDistributedRunMonitor({
            distributedRun: compositeRun,
            controlRun: controlRunWithComposite,
        });
        const drilldown = monitor.compositeDrilldowns[0];

        expect(monitor.compositeCounts).toMatchObject({
            total: 1,
            failed: 1,
            childResults: 6,
            composite: 2,
            leaf: 4,
        });
        expect(drilldown).toMatchObject({
            agentId: 'agent-b',
            recipeId: 'composite-evidence',
            commandId: 'start-b',
            artifactRef: 'control-run.json#results[commandId=start-b]',
            summary: {
                total: 6,
                failed: 2,
                composite: 2,
                leaf: 4,
            },
        });
        expect(drilldown.rows.map(row => row.kind)).toEqual(expect.arrayContaining([
            'parallel',
            'loop',
            'rtc.send',
            'wait',
            'assert',
        ]));
        expect(drilldown.firstFailure).toMatchObject({
            kind: 'assert',
            originalCommandId: 'assert-event-count',
            status: 'failed',
        });
        expect(drilldown.firstFailure?.summary).toContain('expected 99');
        expect(drilldown.firstFailure?.errorSummary).toContain('RALLAR_BLACK_BOX_ASSERT_FAILED');
        expect(drilldown.rows.find(row => row.kind === 'wait')?.summary).toContain('matched');
        expect(drilldown.groupSummaries).toEqual(expect.arrayContaining([
            expect.objectContaining({ groupId: 'left', status: 'passed' }),
            expect.objectContaining({ groupId: 'right', status: 'failed' }),
        ]));
        expect(monitor.failures).toEqual(expect.arrayContaining([
            expect.objectContaining({
                commandId: drilldown.firstFailure?.commandId,
                agentId: 'agent-b',
                recipeId: 'composite-evidence',
                message: expect.stringContaining('RALLAR_BLACK_BOX_ASSERT_FAILED'),
            }),
        ]));
    });

    it('extracts WS and RTC runtime diagnostics for distributed run monitor filtering and failure correlation', () => {
        const controlRunWithDiagnostics: ControlRunSnapshot = {
            ...distributedControlRun,
            events: [
                ...distributedControlRun.events,
                {
                    kind: 'diagnostic',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-b',
                    commandId: 'start-b',
                    eventId: 'diag-ws-unhandled',
                    atEpochMs: 1_985,
                    payload: {
                        eventId: 'runtime-diag-ws',
                        kind: 'diagnostic',
                        topic: 'rallar.browser.ws.unhandled_message',
                        atEpochMs: 1_985,
                        commandId: 'start-b',
                        transport: 'ws',
                        severity: 'warning',
                        payload: {
                            diagnosticSchemaVersion: 1,
                            diagnosticTypeId: 'rallar.browser.ws.unhandled_message',
                            topic: 'rallar.browser.ws.unhandled_message',
                            severity: 'warning',
                            message: 'Unhandled WS message',
                            transport: 'ws',
                            groupId: 'bb-group',
                            senderId: 'agent-a',
                            typeId: 'rallar.message',
                            topicId: 'room.payload',
                            contextId: 'bb-group',
                            resourceId: 'payload-1',
                            data: {
                                typeId: 'rallar.message',
                                topicId: 'room.payload',
                            },
                            source: 'browser-rallar-runtime',
                        },
                    },
                },
                {
                    kind: 'diagnostic',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-a',
                    commandId: 'start-a',
                    eventId: 'diag-rtc-lane',
                    atEpochMs: 1_720,
                    payload: {
                        eventId: 'runtime-diag-rtc',
                        kind: 'diagnostic',
                        topic: 'rallar.browser.rtc.data_channel_mismatch',
                        atEpochMs: 1_720,
                        commandId: 'start-a',
                        transport: 'realtime',
                        severity: 'warning',
                        payload: {
                            diagnosticSchemaVersion: 1,
                            diagnosticTypeId: 'rallar.browser.rtc.data_channel_mismatch',
                            topic: 'rallar.browser.rtc.data_channel_mismatch',
                            severity: 'warning',
                            message: 'Received data channel for different data channel name.',
                            transport: 'realtime',
                            groupId: 'bb-group',
                            peerId: 'agent-b',
                            expectedChannelLabel: 'rtc-realtime',
                            observedChannelLabel: 'rtc-data-channel',
                            accepted: false,
                            source: 'browser-rallar-runtime',
                        },
                    },
                },
            ],
        };

        const monitor = deriveDistributedRunMonitor({
            distributedRun,
            controlRun: controlRunWithDiagnostics,
        });

        expect(monitor.diagnosticCounts).toMatchObject({
            total: 2,
            warning: 2,
            ws: 1,
            rtc: 1,
        });
        expect(monitor.runtimeDiagnostics.map(row => [row.eventId, row.transport, row.groupId])).toEqual([
            ['diag-rtc-lane', 'realtime', 'bb-group'],
            ['diag-ws-unhandled', 'ws', 'bb-group'],
        ]);
        expect(monitor.runtimeDiagnostics[0]).toMatchObject({
            diagnosticTypeId: 'rallar.browser.rtc.data_channel_mismatch',
            expectedLaneId: 'rtc-realtime',
            observedLaneId: 'rtc-data-channel',
            accepted: false,
            peerId: 'agent-b',
        });
        expect(monitor.runtimeDiagnostics[1]).toMatchObject({
            message: 'Unhandled WS message',
            typeId: 'rallar.message',
            topicId: 'room.payload',
            correlatedFailureKeys: expect.arrayContaining(['start-b']),
        });
        expect(monitor.timeline.map(item => item.kind)).toContain('diagnostic');
        expect(monitor.timeline.map(item => item.label)).toEqual(expect.arrayContaining([
            'realtime warning',
            'ws warning',
        ]));
    });

    it('shows distributed barrier commands as monitor evidence', () => {
        const barrierRun: ControlDistributedRunSnapshot = {
            ...distributedRun,
            state: 'waiting-for-barrier',
            barrierStartedAtEpochMs: 1_300,
            barrierCompletedAtEpochMs: 1_420,
            manifest: {
                ...distributedRun.manifest,
                barrier: {
                    enabled: true,
                    timeoutMs: 5_000,
                },
            },
            commandLinks: [
                ...distributedRun.commandLinks,
                { phase: 'barrier', agentId: 'agent-a', commandId: 'barrier-a', queuedAtEpochMs: 1_300 },
                { phase: 'barrier', agentId: 'agent-b', commandId: 'barrier-b', queuedAtEpochMs: 1_305 },
            ],
        };
        const barrierControlRun: ControlRunSnapshot = {
            ...distributedControlRun,
            commands: [
                ...distributedControlRun.commands,
                {
                    envelope: {
                        kind: 'command',
                        protocolVersion: 1,
                        runId: 'run-1',
                        agentId: 'agent-a',
                        commandId: 'barrier-a',
                        command: { kind: 'health', commandId: 'barrier-a' },
                    },
                    queuedAtEpochMs: 1_300,
                    dispatchedAtEpochMs: 1_310,
                    completedAtEpochMs: 1_400,
                    dispatchCount: 1,
                },
                {
                    envelope: {
                        kind: 'command',
                        protocolVersion: 1,
                        runId: 'run-1',
                        agentId: 'agent-b',
                        commandId: 'barrier-b',
                        command: { kind: 'health', commandId: 'barrier-b' },
                    },
                    queuedAtEpochMs: 1_305,
                    dispatchedAtEpochMs: 1_315,
                    completedAtEpochMs: 1_420,
                    dispatchCount: 1,
                },
            ],
            results: [
                ...distributedControlRun.results,
                {
                    kind: 'result',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-a',
                    commandId: 'barrier-a',
                    ok: true,
                    result: {
                        commandId: 'barrier-a',
                        kind: 'health',
                        status: 'ok',
                        ok: true,
                        startedAtEpochMs: 1_310,
                        endedAtEpochMs: 1_400,
                        durationMs: 90,
                    },
                },
                {
                    kind: 'result',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-b',
                    commandId: 'barrier-b',
                    ok: true,
                    result: {
                        commandId: 'barrier-b',
                        kind: 'health',
                        status: 'ok',
                        ok: true,
                        startedAtEpochMs: 1_315,
                        endedAtEpochMs: 1_420,
                        durationMs: 105,
                    },
                },
            ],
        };

        const monitor = deriveDistributedRunMonitor({
            distributedRun: barrierRun,
            controlRun: barrierControlRun,
        });

        expect(monitor.commandCounts.barrier).toBe(2);
        expect(monitor.agentProgress.map(row => [row.agentId, row.barrier])).toEqual([
            ['agent-a', 'ready'],
            ['agent-b', 'ready'],
        ]);
        expect(monitor.timeline.map(item => item.label)).toEqual(expect.arrayContaining([
            'barrier started',
            'barrier ready',
            'barrier queued',
            'barrier completed',
        ]));
    });

    it('filters distributed run history by group, recipe, user, status, date, and failure type', () => {
        const otherRun: ControlDistributedRunSnapshot = {
            ...distributedRun,
            distributedRunId: 'dist-2',
            state: 'passed',
            createdAtEpochMs: 5_000,
            updatedAtEpochMs: 5_500,
            manifest: {
                ...distributedRun.manifest,
                distributedRunId: 'dist-2',
                group: {
                    ...distributedRun.manifest.group,
                    groupId: 'other-group',
                },
                recipes: [{ recipeId: 'other-recipe', profile: 'regression' }],
                metadata: {
                    createdBy: 'bob',
                },
            },
            rollup: {
                ...distributedRun.rollup,
                state: 'passed',
                ok: true,
                failures: [],
                summary: {
                    ...distributedRun.rollup.summary,
                    blockingFailures: 0,
                    failedRecipes: 0,
                },
            },
        };

        expect(filterDistributedRuns([otherRun, distributedRun], {
            groupId: 'bb-group',
            recipeId: 'health',
            profile: 'smoke',
            user: 'alice',
            status: 'failed',
            failureType: 'recipe',
            fromEpochMs: 900,
            toEpochMs: 1_100,
        }).map(run => run.distributedRunId)).toEqual(['dist-1']);

        expect(filterDistributedRuns([otherRun, distributedRun], {
            query: 'regression',
        }).map(run => run.distributedRunId)).toEqual(['dist-2']);
    });

    it('compares distributed runs by recipe, participants, failures, timing, and received messages', () => {
        const rightRun: ControlDistributedRunSnapshot = {
            ...distributedRun,
            distributedRunId: 'dist-2',
            createdAtEpochMs: 2_000,
            startedAtEpochMs: 2_500,
            completedAtEpochMs: 3_800,
            updatedAtEpochMs: 3_800,
            targetAgentIds: ['agent-a', 'agent-c'],
            manifest: {
                ...distributedRun.manifest,
                distributedRunId: 'dist-2',
                recipes: [{
                    ...distributedRun.manifest.recipes[0],
                    profile: 'regression',
                }],
            },
        };
        const rightControlRun: ControlRunSnapshot = {
            ...distributedControlRun,
            events: [
                ...distributedControlRun.events,
                {
                    kind: 'event',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-c',
                    commandId: 'start-c',
                    eventId: 'message-c',
                    atEpochMs: 3_000,
                    payload: {
                        distributedRunId: 'dist-2',
                        topic: 'message.received',
                        message: 'payload received by c',
                    },
                },
            ],
        };

        const comparison = compareDistributedRuns({
            left: distributedRun,
            right: rightRun,
            leftControlRun: distributedControlRun,
            rightControlRun,
        });

        expect(comparison.recipeDelta.changedProfiles).toEqual(['health-only: smoke -> regression']);
        expect(comparison.participantDelta.leftOnly).toEqual(['agent-b']);
        expect(comparison.participantDelta.rightOnly).toEqual(['agent-c']);
        expect(comparison.failureDelta.leftCount).toBe(1);
        expect(comparison.timingDelta.durationDeltaMs).toBe(600);
        expect(comparison.receivedMessageDelta.delta).toBe(1);
    });
});
