import { describe, expect, it } from 'vitest';
import {
    buildDistributedRunManifest,
    compareDistributedRuns,
    defaultDistributedRecipeTargetIds,
    deriveDistributedRunAnalysisReport,
    deriveDistributedRunMonitor,
    deriveRunVerdictView,
    deriveDistributedRunWarningRegressionReport,
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
    RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID,
    createRallarBlackBoxProviderParityLiveRecipe,
    createRallarBlackBoxRtcRealtimeRecipe,
    createRallarBlackBoxRtcRealtimeStabilityRecipe,
    createRallarBlackBoxRtcSmokeRecipe,
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
        const createGroupCommand = recipe.commands[0] as
            | Extract<typeof recipe.commands[number], { kind: 'http.request' }>
            | undefined;
        const upsertMemberCommand = recipe.commands[1] as
            | Extract<typeof recipe.commands[number], { kind: 'http.request' }>
            | undefined;
        const connectCommand = recipe.commands.find(command => command.kind === 'rtc.connect') as
            | Extract<typeof recipe.commands[number], { kind: 'rtc.connect' }>
            | undefined;
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
        expect(recipe.commands).toHaveLength(5);
        expect(createGroupCommand).toMatchObject({
            kind: 'http.request',
            commandId: 'rtc-realtime-ensure-group',
            request: {
                method: 'POST',
                path: '/api/state/apps/game-app/workspaces/live/groups',
                body: {
                    requestId: 'rtc-realtime:ensure-group:game-app:live:arena-1',
                    groupId: 'arena-1',
                    displayName: 'arena-1',
                    joinMode: 'open',
                },
            },
            response: {
                body: 'json',
            },
        });
        expect(upsertMemberCommand).toMatchObject({
            kind: 'http.request',
            commandId: 'rtc-realtime-ensure-member',
            request: {
                method: 'PUT',
                path: '/api/state/apps/game-app/workspaces/live/groups/arena-1/members/{auth.clientId}',
                body: {
                    requestId: 'rtc-realtime:ensure-member:game-app:live:arena-1:{auth.clientId}',
                    status: 'active',
                },
            },
            response: {
                body: 'json',
            },
        });
        expect((connectCommand as { readiness?: unknown } | undefined)?.readiness).toBeUndefined();
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
            manifestCommandCount: 5,
            effectiveCommandCount: 44,
            effectiveFrameCount: 40,
            label: '5 manifest commands - 44 effective operations - 40 frames',
        });
    });

    it('builds RTC realtime recipes with an opt-in stream command', () => {
        const recipe = createRallarBlackBoxRtcRealtimeRecipe({
            durationSeconds: 5,
            executionMode: 'stream',
            readyPeerCount: 1,
            readyTimeoutMs: 10_000,
        });
        const stream = recipe.commands.find(command => command.kind === 'rtc.stream') as
            | Extract<typeof recipe.commands[number], { kind: 'rtc.stream' }>
            | undefined;

        expect(recipe.commands.map(command => command.kind)).toContain('rtc.stream');
        expect(recipe.commands.map(command => command.kind)).not.toContain('loop');
        expect(stream).toMatchObject({
            commandId: 'rtc-realtime-position-stream',
            count: 100,
            intervalMs: 50,
            maxInFlight: 64,
            drainTimeoutMs: 5_000,
            thresholds: {
                minSendSuccessRatio: 0.99,
                maxDroppedFrames: 0,
            },
            metadata: {
                realtime: {
                    executionMode: 'stream',
                    frameCount: 100,
                },
            },
        });
        expect((stream?.send as { data?: Record<string, unknown> } | undefined)?.data).toMatchObject({
            seq: '{stream.index}',
            tMs: '{stream.elapsedMs}',
            position: {
                frame: '{stream.iteration}',
                x: '{stream.index}',
            },
        });
        expect(distributedRecipeCommandPreview(recipe)).toEqual({
            manifestCommandCount: 5,
            effectiveCommandCount: 5,
            effectiveFrameCount: 100,
            label: '5 manifest commands - 100 stream frames',
        });
    });

    it('builds RTC realtime stream recipes with a configurable rate', () => {
        const recipe = createRallarBlackBoxRtcRealtimeRecipe({
            durationSeconds: 5,
            executionMode: 'stream',
            rateHz: 10,
        });
        const connect = recipe.commands.find(command => command.kind === 'rtc.connect') as
            | Extract<typeof recipe.commands[number], { kind: 'rtc.connect' }>
            | undefined;
        const stream = recipe.commands.find(command => command.kind === 'rtc.stream') as
            | Extract<typeof recipe.commands[number], { kind: 'rtc.stream' }>
            | undefined;
        const sendPayload = stream?.send as { data?: Record<string, unknown> } | undefined;

        expect(recipe.description).toContain('10 Hz');
        expect(stream).toMatchObject({
            count: 50,
            intervalMs: 100,
            metadata: {
                realtime: {
                    rateHz: 10,
                    intervalMs: 100,
                    durationSeconds: 5,
                    frameCount: 50,
                },
            },
        });
        expect(connect?.metadata).toMatchObject({
            realtime: {
                rateHz: 10,
                durationSeconds: 5,
                frameCount: 50,
            },
        });
        expect(sendPayload?.data).toMatchObject({
            rateHz: 10,
            intervalMs: 100,
            durationSeconds: 5,
            totalFrames: 50,
        });
        expect(recipe.metadata).toMatchObject({
            rateHz: 10,
            intervalMs: 100,
            durationSeconds: 5,
            frameCount: 50,
        });
        expect(distributedRecipeCommandPreview(recipe)).toEqual({
            manifestCommandCount: 5,
            effectiveCommandCount: 5,
            effectiveFrameCount: 50,
            label: '5 manifest commands - 50 stream frames',
        });
    });

    it('treats configured rtc.stream dropped-frame budgets as non-fatal send failures', () => {
        const strictRecipe = createRallarBlackBoxRtcRealtimeRecipe({
            durationSeconds: 1,
            executionMode: 'stream',
        });
        const tolerantRecipe = createRallarBlackBoxRtcRealtimeRecipe({
            durationSeconds: 1,
            executionMode: 'stream',
            stream: {
                maxDroppedFrames: 4,
            },
        });
        const strictStream = strictRecipe.commands.find(command => command.kind === 'rtc.stream') as
            | Extract<typeof strictRecipe.commands[number], { kind: 'rtc.stream' }>
            | undefined;
        const tolerantStream = tolerantRecipe.commands.find(command => command.kind === 'rtc.stream') as
            | Extract<typeof tolerantRecipe.commands[number], { kind: 'rtc.stream' }>
            | undefined;

        expect(strictStream).toMatchObject({
            thresholds: {
                maxDroppedFrames: 0,
            },
        });
        expect(strictStream).not.toHaveProperty('continueOnSendFailure');
        expect(tolerantStream).toMatchObject({
            continueOnSendFailure: true,
            thresholds: {
                maxDroppedFrames: 4,
            },
        });
    });

    it('exposes a lower-risk RTC realtime stability recipe with scan-friendly preflight details', () => {
        const recipe = createRallarBlackBoxRtcRealtimeStabilityRecipe({
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'hetzner-headless-room',
            },
            readyPeerCount: 1,
            readyTimeoutMs: 10_000,
        });
        const fixture = RALLAR_BLACK_BOX_RECIPE_FIXTURES.find(entry =>
            entry.fixtureId === RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID
        );
        const preflight = distributedRecipePreflight(recipe);
        const streamRow = preflight.tree.find(row => row.kind === 'rtc.stream');
        const connectRow = preflight.tree.find(row => row.kind === 'rtc.connect');

        expect(fixture).toMatchObject({
            fixtureId: RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID,
            label: 'RTC Realtime Stability',
        });
        expect(recipe.metadata).toMatchObject({
            profile: 'rtc-realtime-stability',
            rateHz: 5,
            frameCount: 25,
            executionMode: 'stream',
        });
        expect(distributedRecipeCommandPreview(recipe)).toEqual({
            manifestCommandCount: 5,
            effectiveCommandCount: 5,
            effectiveFrameCount: 25,
            label: '5 manifest commands - 25 stream frames',
        });
        expect(preflight.warnings.join(' ')).not.toContain('readiness');
        expect(connectRow?.details.join(' | ')).toContain('readiness: min 1 ready peer(s), timeout 10000 ms');
        expect(streamRow?.details).toEqual(expect.arrayContaining([
            '25 frames',
            'interval 200 ms',
            'max in-flight 8',
            'min success ratio 0.95',
            'max dropped frames 2',
        ]));
    });

    it('builds the RTC smoke fixture with idempotent group and member setup before connect', () => {
        const recipe = createRallarBlackBoxRtcSmokeRecipe({
            group: {
                applicationId: 'game-app',
                workspaceId: 'live',
                groupId: 'arena-1',
            },
        });
        const connectCommand = recipe.commands.find(command => command.kind === 'rtc.connect');
        const sendCommand = recipe.commands.find(command => command.kind === 'rtc.send');

        expect(recipe.commands).toHaveLength(5);
        expect(recipe.commands[0]).toMatchObject({
            kind: 'http.request',
            commandId: 'rtc-smoke-ensure-group',
            request: {
                method: 'POST',
                path: '/api/state/apps/game-app/workspaces/live/groups',
                body: {
                    requestId: 'rtc-smoke:ensure-group:game-app:live:arena-1',
                    groupId: 'arena-1',
                    joinMode: 'open',
                },
            },
        });
        expect(recipe.commands[1]).toMatchObject({
            kind: 'http.request',
            commandId: 'rtc-smoke-ensure-member',
            request: {
                method: 'PUT',
                path: '/api/state/apps/game-app/workspaces/live/groups/arena-1/members/{auth.clientId}',
                body: {
                    requestId: 'rtc-smoke:ensure-member:game-app:live:arena-1:{auth.clientId}',
                    status: 'active',
                },
            },
        });
        expect(connectCommand).toMatchObject({
            kind: 'rtc.connect',
            actor: '{auth.clientId}',
            roomId: 'arena-1',
            applicationId: 'game-app',
            workspaceId: 'live',
            roomRef: {
                applicationId: 'game-app',
                workspaceId: 'live',
                groupId: 'arena-1',
            },
        });
        expect(sendCommand).toMatchObject({
            kind: 'rtc.send',
            applicationId: 'game-app',
            workspaceId: 'live',
            send: {
                roomId: 'arena-1',
                data: {
                    actor: '{auth.clientId}',
                },
            },
        });
        expect(distributedRecipeCommandKinds(recipe)).toEqual([
            'http.request',
            'rtc.connect',
            'rtc.send',
            'stats',
        ]);
    });

    it('builds provider parity for live browser agents without the demo API backend', () => {
        const defaultRecipe = createRallarBlackBoxProviderParityLiveRecipe();
        const recipe = createRallarBlackBoxProviderParityLiveRecipe({
            apiBaseUrl: 'https://api.rallar.test',
            group: {
                applicationId: 'game-app',
                workspaceId: 'live',
                groupId: 'arena-1',
            },
        });
        const configureCommand = recipe.commands[0];
        const connectCommand = recipe.commands.find(command => command.kind === 'rtc.connect');
        const sendCommands = recipe.commands.filter(command => command.kind === 'rtc.send');

        expect(JSON.stringify(defaultRecipe)).not.toContain('api.example.invalid');
        expect(defaultRecipe.commands[0]).toMatchObject({
            kind: 'configure',
            config: {
                apiBaseUrl: 'https://api.rallar.intactss.com',
            },
        });
        expect(JSON.stringify(recipe)).not.toContain('api.example.invalid');
        expect(recipe.commands).toHaveLength(10);
        expect(configureCommand).toMatchObject({
            kind: 'configure',
            config: {
                apiBaseUrl: 'https://api.rallar.test',
                actor: '{auth.clientId}',
                roomId: 'arena-1',
                control: {
                    providerMode: 'browser-rallar',
                },
                rallar: {
                    apiBaseUrl: 'https://api.rallar.test',
                    applicationId: 'game-app',
                    workspaceId: 'live',
                    roomRef: {
                        applicationId: 'game-app',
                        workspaceId: 'live',
                        groupId: 'arena-1',
                    },
                },
            },
        });
        expect(recipe.commands[1]).toMatchObject({
            kind: 'http.request',
            commandId: 'parity-ensure-group',
            request: {
                method: 'POST',
                path: '/api/state/apps/game-app/workspaces/live/groups',
            },
        });
        expect(recipe.commands[2]).toMatchObject({
            kind: 'http.request',
            commandId: 'parity-ensure-member',
            request: {
                method: 'PUT',
                path: '/api/state/apps/game-app/workspaces/live/groups/arena-1/members/{auth.clientId}',
            },
        });
        expect(connectCommand).toMatchObject({
            kind: 'rtc.connect',
            actor: '{auth.clientId}',
            roomId: 'arena-1',
            applicationId: 'game-app',
            workspaceId: 'live',
        });
        expect(sendCommands).toHaveLength(3);
        expect(sendCommands[0]).toMatchObject({
            kind: 'rtc.send',
            applicationId: 'game-app',
            workspaceId: 'live',
            send: {
                roomId: 'arena-1',
                roomRef: {
                    applicationId: 'game-app',
                    workspaceId: 'live',
                    groupId: 'arena-1',
                },
            },
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
            manifestCommandCount: 5,
            effectiveCommandCount: 44,
            effectiveFrameCount: 40,
            errors: [],
        });
        expect(preflight.loops[0]).toMatchObject({
            commandId: 'rtc-realtime-position-loop',
            estimatedIterations: 40,
            intervalMs: RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS,
            frameCount: 40,
        });
        expect(preflight.commandKinds).toEqual(['http.request', 'loop', 'rtc.connect', 'rtc.send', 'stats']);
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
            ['http.request', 'POST /api/state/apps/game-app/workspaces/live/groups'],
            ['http.request', 'PUT /api/state/apps/game-app/workspaces/live/groups/arena-1/members/{auth.clientId}'],
            ['rtc.connect', 'connect RTC - rtcRealtime - arena-1'],
            ['loop', 'loop x40'],
            ['rtc.send', 'send RTC - rtcRealtime - arena-1'],
            ['stats', 'agent stats'],
        ]);
    });

    it('adds explicit ready-peer contracts to live RTC recipes when requested', () => {
        const group = {
            applicationId: 'game-app',
            workspaceId: 'live',
            groupId: 'arena-1',
        };
        const realtime = createRallarBlackBoxRtcRealtimeRecipe({
            durationSeconds: 2,
            group,
            readyPeerCount: 2,
            readyTimeoutMs: 10_000,
        } as Parameters<typeof createRallarBlackBoxRtcRealtimeRecipe>[0] & {
            readyPeerCount: number;
            readyTimeoutMs: number;
        });
        const smoke = createRallarBlackBoxRtcSmokeRecipe({
            group,
            readyPeerCount: 1,
            readyTimeoutMs: 10_000,
        } as Parameters<typeof createRallarBlackBoxRtcSmokeRecipe>[0] & {
            readyPeerCount: number;
            readyTimeoutMs: number;
        });
        const parity = createRallarBlackBoxProviderParityLiveRecipe({
            group,
            readyPeerCount: 1,
            readyTimeoutMs: 10_000,
        } as Parameters<typeof createRallarBlackBoxProviderParityLiveRecipe>[0] & {
            readyPeerCount: number;
            readyTimeoutMs: number;
        });

        const readinesses = [realtime, smoke, parity].map(recipe =>
            (recipe.commands.find(command => command.kind === 'rtc.connect') as {
                readiness?: unknown;
            } | undefined)?.readiness
        );

        expect(readinesses).toEqual([
            { minReadyPeers: 2, timeoutMs: 10_000, intervalMs: 100 },
            { minReadyPeers: 1, timeoutMs: 10_000, intervalMs: 100 },
            { minReadyPeers: 1, timeoutMs: 10_000, intervalMs: 100 },
        ]);
    });

    it('warns when RTC send traffic has no explicit connect readiness contract', () => {
        const unsafe = distributedRecipePreflight({
            recipeId: 'unsafe-rtc',
            commands: [
                {
                    kind: 'rtc.connect',
                    commandId: 'connect',
                    connection: 'rtc',
                    roomId: 'room-1',
                    transport: 'realtime',
                },
                {
                    kind: 'loop',
                    commandId: 'position-loop',
                    count: 2,
                    commands: [
                        {
                            kind: 'rtc.send',
                            commandId: 'position',
                            connection: 'rtc',
                            transport: 'realtime',
                            send: {
                                roomId: 'room-1',
                                data: {
                                    topic: 'position',
                                },
                            },
                        },
                    ],
                },
            ],
        });
        const safe = distributedRecipePreflight({
            recipeId: 'safe-rtc',
            commands: [
                {
                    kind: 'rtc.connect',
                    commandId: 'connect',
                    connection: 'rtc',
                    roomId: 'room-1',
                    transport: 'realtime',
                    readiness: {
                        minReadyPeers: 1,
                        timeoutMs: 10_000,
                        intervalMs: 100,
                    },
                },
                {
                    kind: 'rtc.send',
                    commandId: 'send',
                    connection: 'rtc',
                    transport: 'realtime',
                    send: {
                        roomId: 'room-1',
                        data: {
                            topic: 'hello',
                        },
                    },
                },
            ],
        } as Parameters<typeof distributedRecipePreflight>[0]);

        expect(unsafe.warnings).toEqual(expect.arrayContaining([
            expect.stringContaining('RTC send traffic starts without an explicit rtc.connect readiness contract'),
            expect.stringContaining('Looped RTC sends are especially sensitive'),
        ]));
        expect(safe.warnings.some(warning =>
            warning.includes('without an explicit rtc.connect readiness contract')
        )).toBe(false);
        expect(safe.tree.find(row => row.commandId === 'connect')?.details).toEqual(expect.arrayContaining([
            'readiness: min 1 ready peer(s), timeout 10000 ms, poll 100 ms',
        ]));
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

    it('requires reported CRDT capability when selected recipes use CRDT commands', () => {
        const rows = distributedRecipeTargetRows({
            run: {
                ...runSnapshot,
                agents: runSnapshot.agents.map(agent =>
                    agent.agentId === 'agent-a'
                        ? {
                            ...agent,
                            identity: {
                                ...(agent.identity ?? {}),
                                capabilities: {
                                    crdt: {
                                        supported: true,
                                        transports: [
                                            'local-only',
                                            'ws',
                                            'rtc',
                                            'ws-then-rtc',
                                            'rtc-with-ws-fallback',
                                        ],
                                    },
                                },
                            },
                        }
                        : agent
                ),
            },
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'bb-group',
            },
            requiredCommandKinds: ['crdt.open', 'crdt.wait'],
            nowEpochMs: 2_500,
        });

        expect(rows.map(row => [row.agentId, row.status, row.targetable])).toEqual([
            ['agent-a', 'matched', true],
            ['agent-b', 'offline', false],
            ['agent-c', 'different-group', false],
        ]);
        expect(defaultDistributedRecipeTargetIds(rows)).toEqual(['agent-a']);

        const missingRows = distributedRecipeTargetRows({
            run: runSnapshot,
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'bb-group',
            },
            requiredCommandKinds: ['crdt.open'],
            nowEpochMs: 2_500,
        });

        expect(missingRows[0]).toMatchObject({
            agentId: 'agent-a',
            status: 'missing-crdt-runtime',
            targetable: false,
        });
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
        expect(monitor.events[0].payloadSummary).toContain('topic=message.received');
        expect(monitor.failures.map(failure => failure.code)).toContain('ASSERTION_FAILED');
        expect(monitor.timeline.map(item => item.label)).toContain('result failed');
    });

    it('derives a human-readable analysis report with first failure and truncation warnings', () => {
        const report = deriveDistributedRunAnalysisReport({
            distributedRun,
            controlRun: distributedControlRun,
            artifactBundle: distributedArtifactBundle,
            snapshotBounds: {
                commands: 4,
                results: 4,
                events: 1,
            },
        });

        expect(report.summary).toMatchObject({
            state: 'failed',
            ok: false,
            durationMs: 700,
            targetCount: 2,
            commandCount: 4,
            failedCommandCount: 1,
            artifactStatus: 'valid',
            snapshotMayBeTruncated: true,
        });
        expect(report.firstFailure).toMatchObject({
            category: 'command',
            commandId: 'start-b',
            agentId: 'agent-b',
            code: 'ASSERTION_FAILED',
        });
        expect(report.agents.find(row => row.agentId === 'agent-b')).toMatchObject({
            execution: 'failed',
            failedCommandCount: 1,
            reconnectCount: 0,
        });
        expect(report.recipes[0]).toMatchObject({
            recipeId: 'health-only',
            failedCount: 1,
        });
        expect(report.nextActions[0]).toMatchObject({
            category: 'command',
            title: 'Distributed command failed',
        });
        expect(report.rawEvidence.failureKeys).toContain('start-b');
        expect(report.summary.snapshotWarnings.join(' ')).toContain('commands');
    });

    it('derives an evidence-first passed run verdict with warnings', () => {
        const passedRun: ControlDistributedRunSnapshot = {
            ...distributedRun,
            state: 'passed',
            rollup: {
                ...distributedRun.rollup,
                state: 'passed',
                ok: true,
                failures: [],
                summary: {
                    ...distributedRun.rollup.summary,
                    passedParticipants: 2,
                    failedParticipants: 0,
                    passedRecipes: 1,
                    failedRecipes: 0,
                    blockingFailures: 0,
                },
            },
        };
        const monitor = deriveDistributedRunMonitor({
            distributedRun: passedRun,
            controlRun: distributedControlRun,
            artifactBundle: distributedArtifactBundle,
        });
        const report = deriveDistributedRunAnalysisReport({
            distributedRun: passedRun,
            controlRun: distributedControlRun,
            artifactBundle: distributedArtifactBundle,
            snapshotBounds: {
                commands: 4,
                results: 4,
                events: 1,
            },
        });
        const verdict = deriveRunVerdictView({
            distributedRun: passedRun,
            monitor,
            report,
            refreshedAtEpochMs: 2_800,
        });

        expect(verdict).toMatchObject({
            verdict: 'passed',
            tone: 'warn',
            title: 'Outcome passed; evidence needs review',
            runId: 'dist-1',
            recipeLabel: 'health-only smoke',
            targetCount: 2,
            artifactStatus: 'valid',
        });
        expect(verdict.primaryEvidence.map(entry => entry.label)).toEqual([
            'Commands',
            'Evidence',
            'Evidence warnings',
            'Slowest',
            'Artifact',
        ]);
        expect(verdict.warningSignals.join(' ')).toContain('Evidence warning: snapshot');
        expect(verdict.successSignals.join(' ')).toContain('3 completed commands');
    });

    it('derives clean pass verdict wording separately from evidence warnings', () => {
        const passedRun: ControlDistributedRunSnapshot = {
            ...distributedRun,
            state: 'passed',
            rollup: {
                ...distributedRun.rollup,
                state: 'passed',
                ok: true,
                failures: [],
                summary: {
                    ...distributedRun.rollup.summary,
                    passedParticipants: 2,
                    failedParticipants: 0,
                    passedRecipes: 1,
                    failedRecipes: 0,
                    blockingFailures: 0,
                },
            },
        };
        const cleanControlRun: ControlRunSnapshot = {
            ...distributedControlRun,
            results: distributedControlRun.results.map(result =>
                result.commandId === 'start-b'
                    ? {
                        ...result,
                        ok: true,
                        error: undefined,
                        result: {
                            ...result.result,
                            status: 'ok',
                            ok: true,
                            error: undefined,
                        },
                    }
                    : result
            ),
        };
        const monitor = deriveDistributedRunMonitor({
            distributedRun: passedRun,
            controlRun: cleanControlRun,
            artifactBundle: distributedArtifactBundle,
        });
        const report = deriveDistributedRunAnalysisReport({
            distributedRun: passedRun,
            controlRun: cleanControlRun,
            artifactBundle: distributedArtifactBundle,
        });
        const verdict = deriveRunVerdictView({
            distributedRun: passedRun,
            monitor,
            report,
        });

        expect(verdict).toMatchObject({
            verdict: 'passed',
            tone: 'good',
            title: 'Outcome passed',
        });
        expect(verdict.warningSignals).toEqual([]);
        expect(verdict.successSignals.join(' ')).toContain('Artifact bundle is valid');
    });

    it('derives a failed run verdict with a causal trail and linked evidence counts', () => {
        const monitor = deriveDistributedRunMonitor({
            distributedRun,
            controlRun: distributedControlRun,
            artifactBundle: distributedArtifactBundle,
        });
        const report = deriveDistributedRunAnalysisReport({
            distributedRun,
            controlRun: distributedControlRun,
            artifactBundle: distributedArtifactBundle,
        });
        const verdict = deriveRunVerdictView({
            distributedRun,
            monitor,
            report,
            refreshedAtEpochMs: 2_800,
        });

        expect(verdict).toMatchObject({
            verdict: 'failed',
            tone: 'bad',
            title: 'Outcome failed',
            likelyCause: 'No received payload.',
            nextAction: expect.stringContaining('Open command start-b'),
        });
        expect(verdict.causalTrail.map(entry => entry.kind)).toEqual([
            'failure-category',
            'command-result',
            'diagnostic',
            'artifact',
            'events',
        ]);
        expect(verdict.causalTrail[1]).toMatchObject({
            commandId: 'start-b',
            agentId: 'agent-b',
            recipeId: 'health-only',
            targetKind: 'command',
            targetId: 'start-b',
            actionLabel: 'Open command start-b',
        });
        expect(verdict.causalTrail[2]).toMatchObject({
            targetKind: 'diagnostic',
            actionLabel: expect.stringContaining('Filter diagnostics'),
        });
        expect(verdict.causalTrail[3]).toMatchObject({
            targetKind: 'artifact',
            targetId: 'valid',
            actionLabel: 'Inspect artifact evidence',
        });
        expect(verdict.primaryEvidence.map(entry => [entry.label, entry.value])).toContainEqual([
            'Linked evidence',
            '1 failure / 0 diagnostics / 1 event',
        ]);
    });

    it('adds stream-performance causal trail evidence for RTC stream threshold failures', () => {
        const streamRun: ControlDistributedRunSnapshot = {
            ...distributedRun,
            manifest: {
                ...distributedRun.manifest,
                recipes: [{
                    recipeId: 'rtc-realtime-stability',
                    recipe: createRallarBlackBoxRtcRealtimeStabilityRecipe({
                        readyPeerCount: 1,
                    }),
                    profile: 'rtc',
                    required: true,
                }],
            },
            commandLinks: [
                {
                    phase: 'start',
                    agentId: 'agent-a',
                    commandId: 'rtc-realtime-position-stream',
                    recipeId: 'rtc-realtime-stability',
                    queuedAtEpochMs: 1_510,
                },
            ],
            rollup: {
                ...distributedRun.rollup,
                failures: [{
                    kind: 'recipe',
                    key: 'rtc-realtime-stability',
                    state: 'failed',
                    required: true,
                    error: {
                        code: 'RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED',
                        message: 'RTC stream did not satisfy configured thresholds.',
                    },
                }],
            },
        };
        const streamControlRun: ControlRunSnapshot = {
            ...distributedControlRun,
            commands: [{
                envelope: {
                    kind: 'command',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-a',
                    commandId: 'rtc-realtime-position-stream',
                    command: {
                        kind: 'rtc.stream',
                        commandId: 'rtc-realtime-position-stream',
                        connection: 'rtcRealtime',
                        roomId: 'bb-group',
                        count: 25,
                        intervalMs: 200,
                        send: { data: { topic: 'room.black-box.rtc-realtime.position' } },
                    },
                },
                queuedAtEpochMs: 1_510,
                dispatchedAtEpochMs: 1_530,
                completedAtEpochMs: 3_000,
                dispatchCount: 1,
            }],
            results: [{
                kind: 'result',
                protocolVersion: 1,
                runId: 'run-1',
                agentId: 'agent-a',
                commandId: 'rtc-realtime-position-stream',
                ok: false,
                error: {
                    code: 'RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED',
                    message: 'RTC stream did not satisfy configured thresholds.',
                },
                result: {
                    commandId: 'rtc-realtime-position-stream',
                    kind: 'rtc.stream',
                    status: 'failed',
                    ok: false,
                    startedAtEpochMs: 1_530,
                    endedAtEpochMs: 3_000,
                    durationMs: 1_470,
                    value: {
                        commandId: 'rtc-realtime-position-stream',
                        plannedFrames: 25,
                        scheduledFrames: 25,
                        attemptedFrames: 23,
                        completedFrames: 23,
                        failedFrames: 2,
                        droppedFrames: 2,
                        inFlightLimitDropCount: 1,
                        pacing: {
                            maxStartDriftMs: 620,
                            lateFrameCount: 3,
                        },
                        duration: {
                            p50Ms: 35,
                            p95Ms: 140,
                            p99Ms: 180,
                            maxMs: 180,
                        },
                        thresholdFailures: [{
                            name: 'maxDroppedFrames',
                            category: 'delivery',
                            threshold: 1,
                            actual: 2,
                            message: 'Dropped frame count was 2, above the configured 1 maximum.',
                        }],
                    },
                    error: {
                        code: 'RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED',
                        message: 'RTC stream did not satisfy configured thresholds.',
                    },
                },
            }],
            events: [{
                kind: 'diagnostic',
                protocolVersion: 1,
                runId: 'run-1',
                agentId: 'agent-a',
                commandId: 'rtc-realtime-position-stream',
                eventId: 'stream-failed',
                atEpochMs: 3_000,
                topic: 'rallar.bb.rtc.stream_failed',
                severity: 'error',
                payload: {
                    commandId: 'rtc-realtime-position-stream',
                    plannedFrames: 25,
                    completedFrames: 23,
                    droppedFrames: 2,
                    inFlightLimitDropCount: 1,
                    thresholdFailures: [{ name: 'maxDroppedFrames' }],
                },
            }],
        };
        const monitor = deriveDistributedRunMonitor({
            distributedRun: streamRun,
            controlRun: streamControlRun,
        });
        const report = deriveDistributedRunAnalysisReport({
            distributedRun: streamRun,
            controlRun: streamControlRun,
        });
        const verdict = deriveRunVerdictView({
            distributedRun: streamRun,
            monitor,
            report,
        });

        expect(report.nextActions[0]).toMatchObject({
            category: 'rtc-stream-performance',
            title: 'RTC stream pacing/backlog threshold failed',
        });
        expect(verdict.causalTrail.map(entry => entry.kind)).toContain('stream-performance');
        expect(verdict.causalTrail.find(entry => entry.kind === 'stream-performance')).toMatchObject({
            label: 'Stream pacing evidence',
            commandId: 'rtc-realtime-position-stream',
            agentId: 'agent-a',
            targetKind: 'command',
            actionLabel: 'Inspect stream pacing',
        });
        expect(verdict.summary).toContain('rtc-stream-performance');
    });

    it('calls out missing artifacts in the run verdict', () => {
        const monitor = deriveDistributedRunMonitor({
            distributedRun,
            controlRun: distributedControlRun,
        });
        const report = deriveDistributedRunAnalysisReport({
            distributedRun,
            controlRun: distributedControlRun,
        });
        const verdict = deriveRunVerdictView({
            distributedRun,
            monitor,
            report,
        });

        expect(verdict.artifactStatus).toBe('not-loaded');
        expect(verdict.warningSignals.join(' ')).toContain('Evidence warning: artifact not loaded');
        expect(verdict.primaryEvidence).toContainEqual(expect.objectContaining({
            label: 'Artifact',
            tone: 'warn',
        }));
    });

    it('validates v1 and v2 distributed artifacts without breaking old bundles', () => {
        const v1Monitor = deriveDistributedRunMonitor({
            distributedRun,
            controlRun: distributedControlRun,
            artifactBundle: distributedArtifactBundle,
        });
        const v2Monitor = deriveDistributedRunMonitor({
            distributedRun,
            controlRun: distributedControlRun,
            artifactBundle: {
                artifactSchemaVersion: 2,
                distributedRunId: 'dist-1',
                generatedAtEpochMs: 2_600,
                files: {
                    ...distributedArtifactBundle.files,
                    'report.json': '{}',
                    'results.jsonl': '',
                    'events.jsonl': '',
                    'failures.json': '{}',
                    'metadata.json': '{}',
                },
            },
        });
        const invalidV2Monitor = deriveDistributedRunMonitor({
            distributedRun,
            controlRun: distributedControlRun,
            artifactBundle: {
                artifactSchemaVersion: 2,
                distributedRunId: 'dist-1',
                generatedAtEpochMs: 2_700,
                files: {
                    ...distributedArtifactBundle.files,
                    'report.json': '{}',
                    'results.jsonl': '',
                    'events.jsonl': '',
                    'failures.json': '{}',
                },
            },
        });

        expect(v1Monitor.artifact).toMatchObject({
            status: 'valid',
            message: expect.stringContaining('v1'),
        });
        expect(v2Monitor.artifact).toMatchObject({
            status: 'valid',
            message: expect.stringContaining('v2'),
        });
        expect(invalidV2Monitor.artifact).toMatchObject({
            status: 'missing-file',
        });
        expect(invalidV2Monitor.artifact.message).toContain('metadata.json');
    });

    it('maps common distributed failure modes to actionable explanations', () => {
        const cases = [
            {
                code: 'RALLAR_BB_DISTRIBUTED_NO_TARGET_AGENTS',
                message: 'No target control agents were resolved for this distributed run.',
                category: 'targeting',
                nextAction: 'Open or restart agents',
            },
            {
                code: 'RALLAR_BB_DISTRIBUTED_TARGET_COUNT_MISMATCH',
                message: 'Resolved 1 target agents, expected 2.',
                category: 'targeting',
                nextAction: 'expected participant count',
            },
            {
                code: 'RALLAR_BB_DISTRIBUTED_ACK_TIMEOUT',
                message: 'Agent agent-a did not ACK distributed-run staging before ackTimeoutMs.',
                category: 'readiness',
                nextAction: 'agent tab is still connected',
            },
            {
                code: 'RALLAR_BB_DISTRIBUTED_BARRIER_TIMEOUT',
                message: 'Agent agent-a did not report barrier.ready before barrier timeout.',
                category: 'barrier',
                nextAction: 'ACK readiness',
            },
        ] as const;

        cases.forEach(testCase => {
            const report = deriveDistributedRunAnalysisReport({
                distributedRun: {
                    ...distributedRun,
                    state: testCase.code.includes('TIMEOUT') ? 'timed-out' : 'failed',
                    error: testCase.code.includes('TARGET')
                        ? {
                            code: testCase.code,
                            message: testCase.message,
                        }
                        : undefined,
                    rollup: {
                        ...distributedRun.rollup,
                        state: testCase.code.includes('TIMEOUT') ? 'timed-out' : 'failed',
                        ok: false,
                        failures: testCase.code.includes('TARGET')
                            ? []
                            : [{
                                kind: 'participant',
                                key: 'agent-a',
                                state: 'timed-out',
                                required: true,
                                error: {
                                    code: testCase.code,
                                    message: testCase.message,
                                },
                            }],
                    },
                },
            });

            expect(report.nextActions[0]).toMatchObject({
                category: testCase.category,
            });
            expect(report.nextActions[0].nextAction).toContain(testCase.nextAction);
        });
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

    it('builds a live-warning regression report from visible monitor and artifact evidence', () => {
        const liveMessageId = 'live-message-visible-in-monitor';
        const controlRunWithLiveWarning: ControlRunSnapshot = {
            ...distributedControlRun,
            events: [
                ...distributedControlRun.events,
                {
                    kind: 'event',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-b',
                    eventId: 'live-message-event',
                    atEpochMs: 2_050,
                    payload: {
                        kind: 'message',
                        topic: 'room.live.warning.regression',
                        payload: {
                            data: {
                                distributedRunId: 'dist-1',
                                messageId: liveMessageId,
                            },
                        },
                    },
                },
                {
                    kind: 'diagnostic',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-b',
                    eventId: 'live-warning-diagnostic',
                    atEpochMs: 2_060,
                    payload: {
                        kind: 'diagnostic',
                        topic: 'rallar.browser.ws.unhandled_message',
                        severity: 'warning',
                        payload: {
                            diagnosticSchemaVersion: 1,
                            diagnosticTypeId: 'rallar.browser.ws.unhandled_message',
                            topic: 'rallar.browser.ws.unhandled_message',
                            severity: 'warning',
                            message: 'Unhandled WS message',
                            transport: 'ws',
                            groupId: 'bb-group',
                            data: {
                                distributedRunId: 'dist-1',
                                messageId: liveMessageId,
                            },
                        },
                    },
                },
            ],
        };
        const artifactBundle: ControlDistributedRunArtifactBundle = {
            ...distributedArtifactBundle,
            files: {
                ...distributedArtifactBundle.files,
                'control-run.json': JSON.stringify(controlRunWithLiveWarning),
            },
        };

        const report = deriveDistributedRunWarningRegressionReport({
            distributedRun,
            controlRun: controlRunWithLiveWarning,
            artifactBundle,
            expectation: {
                messageEvidence: [liveMessageId],
                diagnosticTypeIds: ['rallar.browser.ws.unhandled_message'],
                failOnDiagnosticSeverities: ['error'],
            },
        });

        expect(report.ok, report.failures.join('\n')).toBe(true);
        expect(report.observed.monitorMessageEvidence).toEqual([liveMessageId]);
        expect(report.observed.artifactMessageEvidence).toEqual([liveMessageId]);
        expect(report.observed.warningDiagnosticTypeIds).toEqual(['rallar.browser.ws.unhandled_message']);
        expect(report.observed.highSeverityDiagnosticTypeIds).toEqual([]);

        const errorReport = deriveDistributedRunWarningRegressionReport({
            distributedRun,
            controlRun: {
                ...controlRunWithLiveWarning,
                events: [
                    ...controlRunWithLiveWarning.events,
                    {
                        kind: 'diagnostic',
                        protocolVersion: 1,
                        runId: 'run-1',
                        agentId: 'agent-b',
                        eventId: 'live-error-diagnostic',
                        atEpochMs: 2_070,
                        payload: {
                            kind: 'diagnostic',
                            topic: 'rallar.browser.realtime.send_failed',
                            severity: 'error',
                            payload: {
                                diagnosticSchemaVersion: 1,
                                diagnosticTypeId: 'rallar.browser.realtime.send_failed',
                                topic: 'rallar.browser.realtime.send_failed',
                                severity: 'error',
                                message: 'Realtime send failed.',
                                transport: 'realtime',
                                data: {
                                    distributedRunId: 'dist-1',
                                },
                            },
                        },
                    },
                ],
            },
            expectation: {
                diagnosticTypeIds: ['rallar.browser.ws.unhandled_message'],
                failOnDiagnosticSeverities: ['error'],
            },
        });

        expect(errorReport.ok).toBe(false);
        expect(errorReport.failures).toContain(
            'High-severity runtime diagnostic observed: rallar.browser.realtime.send_failed',
        );
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
