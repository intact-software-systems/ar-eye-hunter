import { describe, expect, it } from 'vitest';
import type {
    ControlDistributedRunSnapshot
} from '../../../apps/rallar-black-box/src/control-run-manager.ts';
import {
    defaultDistributedRecipeTargetIds,
    deriveDistributedRunMonitor,
    distributedRecipeCommandKinds,
    distributedRecipeCommandPreview,
    distributedRecipePreflight,
    distributedRecipeTargetRows,
    filterDistributedRuns
} from '../../../apps/rallar-black-box/src/distributed-recipes.ts';
import {
    configuredDistributedRecipeCatalogItem,
    DISTRIBUTED_RECIPE_CATALOG,
    distributedRecipeMatches
} from '../../../apps/rallar-black-box/src/legacy/runner/distributed-recipes/distributed-recipe-catalog.ts';
import {
    createRallarBlackBoxEnsureGroupRequestId,
    createRallarBlackBoxProviderParityLiveRecipe,
    createRallarBlackBoxRtcRealtimeRecipe,
    createRallarBlackBoxRtcRealtimeStabilityRecipe,
    createRallarBlackBoxRtcSmokeRecipe,
    RALLAR_BLACK_BOX_RECIPE_FIXTURES,
    RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_MULTICAST_RECIPE_FIXTURE_ID,
    RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_RECEIVER_RECIPE_FIXTURE_ID,
    RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_SENDER_RECIPE_FIXTURE_ID,
    RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS,
    RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID
} from '../../../apps/rallar-black-box/src/recipe-fixtures.ts';
import {
    configuredDistributedRecipeCatalogItem as sharedConfiguredDistributedRecipeCatalogItem,
    createRallarBlackBoxTestRuntime,
    DISTRIBUTED_RECIPE_CATALOG as SHARED_DISTRIBUTED_RECIPE_CATALOG,
    distributedRecipeMatches as sharedDistributedRecipeMatches,
    projectDistributedRecipeCatalog,
    selectRallarBlackBoxCommandHistory
} from '../../shared-test/rallar-bb-test/mod.ts';
import type { RallarBlackBoxTestRecipe } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    AGENT_A_IDENTITY,
    distributedArtifactBundle,
    distributedControlRun,
    distributedRun,
    FULL_ASSERTIONS_CAPABILITY,
    FULL_MESSAGING_CAPABILITY,
    runSnapshot
} from './distributed-recipes/distributed-run-fixture.ts';

describe('distributed recipes catalog', () => {
    it('preflights 200,000 commands while preserving first frame-count priority', () => {
        const commandCount = 200_000;
        const largeRecipe: RallarBlackBoxTestRecipe = {
            schemaVersion: 1,
            recipeId: 'large-preflight',
            commands: Array.from({ length: commandCount }, (_, index) =>
                index === 0
                    ? { kind: 'rtc.stream' as const, count: 7, send: {} }
                    : { kind: 'health' as const })
        };

        const preflight = distributedRecipePreflight(largeRecipe);

        expect(preflight).toMatchObject({
            recipeId: 'large-preflight',
            manifestCommandCount: commandCount,
            effectiveCommandCount: commandCount,
            effectiveFrameCount: 7,
            maxDepth: 1,
            commandKinds: ['health', 'rtc.stream'],
            errors: []
        });
        expect(preflight.tree).toHaveLength(commandCount);
    }, 60_000);

    it('builds the configurable RTC realtime recipe with a compact looped 20 Hz command cadence', () => {
        const recipe = createRallarBlackBoxRtcRealtimeRecipe({
            durationSeconds: 2,
            group: {
                applicationId: 'game-app',
                workspaceId: 'live',
                groupId: 'arena-1'
            }
        });
        const createGroupCommand = recipe.commands[0] as
            | Extract<typeof recipe.commands[number], { kind: 'http.request'; }>
            | undefined;
        const upsertMemberCommand = recipe.commands[1] as
            | Extract<typeof recipe.commands[number], { kind: 'http.request'; }>
            | undefined;
        const connectCommand = recipe.commands.find((command) => command.kind === 'rtc.connect') as
            | Extract<typeof recipe.commands[number], { kind: 'rtc.connect'; }>
            | undefined;
        const loopCommand = recipe.commands.find((command) => command.kind === 'loop') as
            | Extract<typeof recipe.commands[number], { kind: 'loop'; }>
            | undefined;
        const sendCommand = loopCommand?.commands[0] as
            | Extract<typeof recipe.commands[number], { kind: 'rtc.send'; }>
            | undefined;
        const preview = distributedRecipeCommandPreview(recipe);

        const groupRequestId = createRallarBlackBoxEnsureGroupRequestId({
            requestPrefix: 'rtc-realtime',
            group: {
                applicationId: 'game-app',
                workspaceId: 'live',
                groupId: 'arena-1'
            }
        });
        expect(groupRequestId).not.toMatch(/game-app|live|arena-1|auth/);

        expect(recipe.recipeId).toBe('rtc-realtime');
        expect(recipe.commands).toHaveLength(5);
        expect(createGroupCommand).toMatchObject({
            kind: 'http.request',
            commandId: 'rtc-realtime-ensure-group',
            request: {
                method: 'POST',
                path: `/api/state/apps/game-app/workspaces/live/groups/requests/${groupRequestId}`,
                body: {
                    groupId: 'arena-1',
                    displayName: 'arena-1',
                    kind: 'room',
                    joinMode: 'open'
                }
            },
            response: {
                body: 'json',
                acceptedStatusCodes: [200, 201, 409]
            }
        });
        expect(upsertMemberCommand).toMatchObject({
            kind: 'http.request',
            commandId: 'rtc-realtime-ensure-member',
            request: {
                method: 'PUT',
                path: expect.stringMatching(
                    /^\/api\/state\/apps\/game-app\/workspaces\/live\/groups\/arena-1\/members\/\{auth\.clientId\}\/requests\/[^/]+$/
                ),
                body: {
                    status: 'active'
                }
            },
            response: {
                body: 'json',
                acceptedStatusCodes: [200, 201]
            }
        });
        expect(connectCommand?.readiness).toBeUndefined();
        expect(loopCommand).toMatchObject({
            kind: 'loop',
            commandId: 'rtc-realtime-position-loop',
            count: 40,
            intervalMs: RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS,
            maxCommands: 40
        });
        expect(loopCommand?.commands).toHaveLength(1);
        expect(sendCommand?.commandId).toBe('rtc-realtime-position');
        expect(sendCommand?.metadata).toMatchObject({
            realtime: {
                rateHz: 20,
                durationSeconds: 2,
                frame: '{loop.iteration}',
                totalFrames: 40
            }
        });
        expect(sendCommand?.roomRef).toEqual({
            applicationId: 'game-app',
            workspaceId: 'live',
            groupId: 'arena-1'
        });
        expect(sendCommand?.send).toMatchObject({
            roomId: 'arena-1',
            data: {
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
                    z: '{loop.index}'
                }
            }
        });
        expect(recipe.metadata).toMatchObject({
            profile: 'rtc-realtime',
            rateHz: 20,
            durationSeconds: 2,
            frameCount: 40
        });
        expect(preview).toEqual({
            manifestCommandCount: 5,
            effectiveCommandCount: 44,
            effectiveFrameCount: 40,
            label: '5 manifest commands - 44 effective operations - 40 frames'
        });
    });

    it('builds RTC realtime recipes with an opt-in stream command', () => {
        const recipe = createRallarBlackBoxRtcRealtimeRecipe({
            durationSeconds: 5,
            executionMode: 'stream',
            readyPeerCount: 1,
            readyTimeoutMs: 10_000
        });
        const stream = recipe.commands.find((command) => command.kind === 'rtc.stream') as
            | Extract<typeof recipe.commands[number], { kind: 'rtc.stream'; }>
            | undefined;

        expect(recipe.commands.map((command) => command.kind)).toContain('rtc.stream');
        expect(recipe.commands.map((command) => command.kind)).not.toContain('loop');
        expect(stream).toMatchObject({
            commandId: 'rtc-realtime-position-stream',
            count: 100,
            intervalMs: 50,
            maxInFlight: 64,
            drainTimeoutMs: 5_000,
            thresholds: {
                minSendSuccessRatio: 0.99,
                maxDroppedFrames: 0
            },
            metadata: {
                realtime: {
                    executionMode: 'stream',
                    frameCount: 100
                }
            }
        });
        expect(stream?.send).toMatchObject({
            data: {
                seq: '{stream.index}',
                tMs: '{stream.elapsedMs}',
                position: {
                    frame: '{stream.iteration}',
                    x: '{stream.index}'
                }
            }
        });
        expect(distributedRecipeCommandPreview(recipe)).toEqual({
            manifestCommandCount: 5,
            effectiveCommandCount: 5,
            effectiveFrameCount: 100,
            label: '5 manifest commands - 100 stream frames'
        });
    });

    it('builds RTC realtime stream recipes with a configurable rate', () => {
        const recipe = createRallarBlackBoxRtcRealtimeRecipe({
            durationSeconds: 5,
            executionMode: 'stream',
            rateHz: 10
        });
        const connect = recipe.commands.find((command) => command.kind === 'rtc.connect') as
            | Extract<typeof recipe.commands[number], { kind: 'rtc.connect'; }>
            | undefined;
        const stream = recipe.commands.find((command) => command.kind === 'rtc.stream') as
            | Extract<typeof recipe.commands[number], { kind: 'rtc.stream'; }>
            | undefined;

        expect(recipe.description).toContain('10 Hz');
        expect(stream).toMatchObject({
            count: 50,
            intervalMs: 100,
            metadata: {
                realtime: {
                    rateHz: 10,
                    intervalMs: 100,
                    durationSeconds: 5,
                    frameCount: 50
                }
            }
        });
        expect(connect?.metadata).toMatchObject({
            realtime: {
                rateHz: 10,
                durationSeconds: 5,
                frameCount: 50
            }
        });
        expect(stream?.send).toMatchObject({
            data: {
                rateHz: 10,
                intervalMs: 100,
                durationSeconds: 5,
                totalFrames: 50
            }
        });
        expect(recipe.metadata).toMatchObject({
            rateHz: 10,
            intervalMs: 100,
            durationSeconds: 5,
            frameCount: 50
        });
        expect(distributedRecipeCommandPreview(recipe)).toEqual({
            manifestCommandCount: 5,
            effectiveCommandCount: 5,
            effectiveFrameCount: 50,
            label: '5 manifest commands - 50 stream frames'
        });
    });

    it('treats configured rtc.stream dropped-frame budgets as non-fatal send failures', () => {
        const strictRecipe = createRallarBlackBoxRtcRealtimeRecipe({
            durationSeconds: 1,
            executionMode: 'stream'
        });
        const tolerantRecipe = createRallarBlackBoxRtcRealtimeRecipe({
            durationSeconds: 1,
            executionMode: 'stream',
            stream: {
                maxDroppedFrames: 4
            }
        });
        const strictStream = strictRecipe.commands.find((command) => command.kind === 'rtc.stream') as
            | Extract<typeof strictRecipe.commands[number], { kind: 'rtc.stream'; }>
            | undefined;
        const tolerantStream = tolerantRecipe.commands.find((command) => command.kind === 'rtc.stream') as
            | Extract<typeof tolerantRecipe.commands[number], { kind: 'rtc.stream'; }>
            | undefined;

        expect(strictStream).toMatchObject({
            thresholds: {
                maxDroppedFrames: 0
            }
        });
        expect(strictStream).not.toHaveProperty('continueOnSendFailure');
        expect(tolerantStream).toMatchObject({
            continueOnSendFailure: true,
            thresholds: {
                maxDroppedFrames: 4
            }
        });
    });

    it('exposes a lower-risk RTC realtime stability recipe with scan-friendly preflight details', () => {
        const recipe = createRallarBlackBoxRtcRealtimeStabilityRecipe({
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'hetzner-headless-room'
            },
            readyPeerCount: 1,
            readyTimeoutMs: 10_000
        });
        const fixture = RALLAR_BLACK_BOX_RECIPE_FIXTURES.find((entry) => entry.fixtureId === RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID);
        const preflight = distributedRecipePreflight(recipe);
        const streamRow = preflight.tree.find((row) => row.kind === 'rtc.stream');
        const connectRow = preflight.tree.find((row) => row.kind === 'rtc.connect');

        expect(fixture).toMatchObject({
            fixtureId: RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID,
            label: 'RTC Realtime Stability'
        });
        expect(recipe.metadata).toMatchObject({
            profile: 'rtc-realtime-stability',
            rateHz: 5,
            frameCount: 25,
            executionMode: 'stream'
        });
        expect(distributedRecipeCommandPreview(recipe)).toEqual({
            manifestCommandCount: 5,
            effectiveCommandCount: 5,
            effectiveFrameCount: 25,
            label: '5 manifest commands - 25 stream frames'
        });
        expect(preflight.warnings.join(' ')).not.toContain('readiness');
        expect(connectRow?.details.join(' | ')).toContain('readiness: min 1 ready peer(s), timeout 10000 ms');
        expect(streamRow?.details).toEqual(expect.arrayContaining([
            '25 frames',
            'interval 200 ms',
            'max in-flight 8',
            'min success ratio 0.95',
            'max dropped frames 2'
        ]));
    });

    it('session-fences RTC smoke group and member setup before connect', () => {
        const recipe = createRallarBlackBoxRtcSmokeRecipe({
            group: {
                applicationId: 'game-app',
                workspaceId: 'live',
                groupId: 'arena-1'
            }
        });
        const connectCommand = recipe.commands.find((command) => command.kind === 'rtc.connect');
        const sendCommand = recipe.commands.find((command) => command.kind === 'rtc.send');

        expect(recipe.commands).toHaveLength(5);
        expect(recipe.commands[0]).toMatchObject({
            kind: 'http.request',
            commandId: 'rtc-smoke-ensure-group',
            request: {
                method: 'POST',
                path: expect.stringMatching(
                    /^\/api\/state\/apps\/game-app\/workspaces\/live\/groups\/requests\/[^/]+-\{runtimeIdentity\}$/
                ),
                body: {
                    groupId: 'arena-1',
                    joinMode: 'open'
                }
            }
        });
        expect(recipe.commands[1]).toMatchObject({
            kind: 'http.request',
            commandId: 'rtc-smoke-ensure-member',
            request: {
                method: 'PUT',
                path: expect.stringMatching(
                    new RegExp(
                        '^/api/state/apps/game-app/workspaces/live/groups/arena-1/' +
                            'members/\\{auth\\.clientId\\}/requests/[^/]+-\\{runtimeIdentity\\}$'
                    )
                ),
                body: {
                    status: 'active'
                }
            }
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
                groupId: 'arena-1'
            }
        });
        expect(sendCommand).toMatchObject({
            kind: 'rtc.send',
            applicationId: 'game-app',
            workspaceId: 'live',
            send: {
                roomId: 'arena-1',
                data: {
                    actor: '{auth.clientId}'
                }
            }
        });
        expect(distributedRecipeCommandKinds(recipe)).toEqual([
            'http.request',
            'rtc.connect',
            'rtc.send',
            'stats'
        ]);
    });

    it('builds provider parity for live browser agents without the demo API backend', () => {
        const defaultRecipe = createRallarBlackBoxProviderParityLiveRecipe();
        const recipe = createRallarBlackBoxProviderParityLiveRecipe({
            apiBaseUrl: 'https://api.rallar.test',
            group: {
                applicationId: 'game-app',
                workspaceId: 'live',
                groupId: 'arena-1'
            }
        });
        const configureCommand = recipe.commands[0];
        const connectCommand = recipe.commands.find((command) => command.kind === 'rtc.connect');
        const sendCommands = recipe.commands.filter((command) => command.kind === 'rtc.send');

        expect(JSON.stringify(defaultRecipe)).not.toContain('api.example.invalid');
        expect(defaultRecipe.commands[0]).toMatchObject({
            kind: 'configure',
            config: {
                apiBaseUrl: 'https://api.rallar.intactss.com'
            }
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
                    providerMode: 'browser-rallar'
                },
                rallar: {
                    apiBaseUrl: 'https://api.rallar.test',
                    applicationId: 'game-app',
                    workspaceId: 'live',
                    roomRef: {
                        applicationId: 'game-app',
                        workspaceId: 'live',
                        groupId: 'arena-1'
                    }
                }
            }
        });
        if (configureCommand.kind !== 'configure') {
            throw new Error('Expected provider parity live recipe to start with configure.');
        }
        expect(configureCommand.config.rallar).not.toMatchObject({
            username: expect.any(String)
        });
        expect(configureCommand.config.rallar).not.toMatchObject({
            password: expect.any(String)
        });
        expect(configureCommand.config.rallar).not.toMatchObject({
            token: expect.any(String)
        });
        expect(configureCommand.config.rallar).not.toMatchObject({
            restoreSession: true
        });
        expect(recipe.commands[1]).toMatchObject({
            kind: 'http.request',
            commandId: 'parity-ensure-group',
            request: {
                method: 'POST',
                path: expect.stringMatching(
                    /^\/api\/state\/apps\/game-app\/workspaces\/live\/groups\/requests\/[^/]+$/
                )
            }
        });
        expect(recipe.commands[2]).toMatchObject({
            kind: 'http.request',
            commandId: 'parity-ensure-member',
            request: {
                method: 'PUT',
                path: expect.stringMatching(
                    /^\/api\/state\/apps\/game-app\/workspaces\/live\/groups\/arena-1\/members\/\{auth\.clientId\}\/requests\/[^/]+$/
                )
            }
        });
        expect(connectCommand).toMatchObject({
            kind: 'rtc.connect',
            actor: '{auth.clientId}',
            roomId: 'arena-1',
            applicationId: 'game-app',
            workspaceId: 'live'
        });
        expect(sendCommands).toHaveLength(3);
        expect(sendCommands[0]).toMatchObject({
            kind: 'rtc.send',
            applicationId: 'game-app',
            workspaceId: 'live',
            send: {
                roomId: 'arena-1',
                peerIds: ['{rtc.readyPeerIds[0]}'],
                roomRef: {
                    applicationId: 'game-app',
                    workspaceId: 'live',
                    groupId: 'arena-1'
                }
            }
        });
        expect(JSON.stringify(recipe)).not.toContain('bob-session');
        expect(JSON.stringify(recipe)).not.toContain('charlie-session');
    });

    it('derives nested composite command kinds and preview counts for app-local fixtures', () => {
        const fixture = RALLAR_BLACK_BOX_RECIPE_FIXTURES.find((entry) => entry.fixtureId === 'composite-evidence');

        expect(fixture).toBeDefined();
        const recipe = fixture!.recipe;

        expect(distributedRecipeCommandKinds(recipe)).toEqual([
            'assert',
            'health',
            'loop',
            'parallel',
            'stats',
            'wait'
        ]);
        expect(distributedRecipeCommandPreview(recipe)).toEqual({
            manifestCommandCount: 5,
            effectiveCommandCount: 7,
            effectiveFrameCount: undefined,
            label: '5 manifest commands - 7 effective operations'
        });
    });

    it('derives distributed recipe preflight for composite evidence recipes', () => {
        const fixture = RALLAR_BLACK_BOX_RECIPE_FIXTURES.find((entry) => entry.fixtureId === 'composite-evidence');
        const preflight = distributedRecipePreflight(fixture!.recipe);

        expect(preflight).toMatchObject({
            recipeId: 'composite-evidence-recipe',
            manifestCommandCount: 5,
            effectiveCommandCount: 7,
            maxDepth: 2,
            errors: []
        });
        expect(preflight.commandKinds).toEqual([
            'assert',
            'health',
            'loop',
            'parallel',
            'stats',
            'wait'
        ]);
        expect(preflight.loops).toEqual([expect.objectContaining({
            commandId: 'composite-health-loop',
            estimatedIterations: 2,
            childCommandCount: 1,
            effectiveCommandCount: 2
        })]);
        expect(preflight.parallelGroups).toEqual([expect.objectContaining({
            commandId: 'parallel-evidence',
            groupCount: 2,
            maxConcurrency: 2,
            groups: ['left-health', 'right-stats']
        })]);
        expect(preflight.waits[0]).toMatchObject({
            commandId: 'wait-for-parallel-result',
            timeoutMs: 1_000
        });
        expect(preflight.waits[0].matchSummary).toContain('commandId=parallel-evidence');
        expect(preflight.asserts[0]).toMatchObject({
            commandId: 'assert-wait-succeeded',
            predicate: 'lastResult.ok equals true'
        });
        expect(preflight.warnings).toEqual(expect.arrayContaining([
            expect.stringContaining('wait can time out'),
            expect.stringContaining('assert fails the recipe')
        ]));
        expect(preflight.serviceBadges.map((badge) => badge.label)).toEqual(expect.arrayContaining([
            'control server',
            'browser agents',
            'runtime evidence',
            'looped traffic',
            'parallel groups'
        ]));
        expect(preflight.tree.map((row) => row.label)).toEqual([
            'composite-health-loop',
            'Loop health',
            'parallel-evidence',
            'parallel-left-health',
            'parallel-right-stats',
            'wait-for-parallel-result',
            'assert-wait-succeeded',
            'composite-evidence-stats'
        ]);
    });

    it('derives live RTC realtime preflight with frame and service warnings', () => {
        const recipe = createRallarBlackBoxRtcRealtimeRecipe({
            durationSeconds: 2,
            group: {
                applicationId: 'game-app',
                workspaceId: 'live',
                groupId: 'arena-1'
            }
        });
        const preflight = distributedRecipePreflight(recipe);

        expect(preflight).toMatchObject({
            recipeId: 'rtc-realtime',
            manifestCommandCount: 5,
            effectiveCommandCount: 44,
            effectiveFrameCount: 40,
            errors: []
        });
        expect(preflight.loops[0]).toMatchObject({
            commandId: 'rtc-realtime-position-loop',
            estimatedIterations: 40,
            intervalMs: RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS,
            frameCount: 40
        });
        expect(preflight.commandKinds).toEqual(['http.request', 'loop', 'rtc.connect', 'rtc.send', 'stats']);
        expect(preflight.liveServiceRequirements).toEqual(expect.arrayContaining([
            'Rallar API and signaling when provider mode is browser-rallar or rallar-browser',
            'active RTC connection'
        ]));
        expect(preflight.serviceBadges.map((badge) => badge.label)).toEqual(expect.arrayContaining([
            'Rallar auth/signaling',
            'RTC peers',
            'looped traffic'
        ]));
        expect(preflight.warnings).toEqual(expect.arrayContaining([
            expect.stringContaining('RTC recipes require real Rallar signaling')
        ]));
        expect(preflight.tree.map((row) => [row.kind, row.summary])).toEqual([
            [
                'http.request',
                expect.stringMatching(
                    /^POST \/api\/state\/apps\/game-app\/workspaces\/live\/groups\/requests\/[^/]+-\{runtimeIdentity\}$/
                )
            ],
            [
                'http.request',
                expect.stringMatching(
                    new RegExp(
                        '^PUT /api/state/apps/game-app/workspaces/live/groups/arena-1/' +
                            'members/\\{auth\\.clientId\\}/requests/[^/]+-\\{runtimeIdentity\\}$'
                    )
                )
            ],
            ['rtc.connect', 'connect RTC - rtcRealtime - arena-1'],
            ['loop', 'loop x40'],
            ['rtc.send', 'send RTC - rtcRealtime - arena-1'],
            ['stats', 'agent stats']
        ]);
    });

    it('adds explicit ready-peer contracts to live RTC recipes when requested', () => {
        const group = {
            applicationId: 'game-app',
            workspaceId: 'live',
            groupId: 'arena-1'
        };
        const realtime = createRallarBlackBoxRtcRealtimeRecipe(
            {
                durationSeconds: 2,
                group,
                readyPeerCount: 2,
                readyTimeoutMs: 10_000
            } as Parameters<typeof createRallarBlackBoxRtcRealtimeRecipe>[0] & {
                readyPeerCount: number;
                readyTimeoutMs: number;
            }
        );
        const smoke = createRallarBlackBoxRtcSmokeRecipe(
            {
                group,
                readyPeerCount: 1,
                readyTimeoutMs: 10_000
            } as Parameters<typeof createRallarBlackBoxRtcSmokeRecipe>[0] & {
                readyPeerCount: number;
                readyTimeoutMs: number;
            }
        );
        const parity = createRallarBlackBoxProviderParityLiveRecipe(
            {
                group,
                readyPeerCount: 1,
                readyTimeoutMs: 10_000
            } as Parameters<typeof createRallarBlackBoxProviderParityLiveRecipe>[0] & {
                readyPeerCount: number;
                readyTimeoutMs: number;
            }
        );

        const readinesses = [realtime, smoke, parity].map((recipe) => recipe.commands.find((command) => command.kind === 'rtc.connect')?.readiness);

        expect(readinesses).toEqual([
            { minReadyPeers: 2, timeoutMs: 10_000, intervalMs: 100 },
            { minReadyPeers: 1, timeoutMs: 10_000, intervalMs: 100 },
            { minReadyPeers: 1, timeoutMs: 10_000, intervalMs: 100 }
        ]);
    });

    it('warns when RTC send traffic has no explicit connect readiness contract', () => {
        const unsafe = distributedRecipePreflight({
            schemaVersion: 1,
            recipeId: 'unsafe-rtc',
            commands: [
                {
                    kind: 'rtc.connect',
                    commandId: 'connect',
                    connection: 'rtc',
                    roomId: 'room-1',
                    transport: 'realtime'
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
                                    topic: 'position'
                                }
                            }
                        }
                    ]
                }
            ]
        });
        const safe = distributedRecipePreflight(
            {
                schemaVersion: 1,
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
                            intervalMs: 100
                        }
                    },
                    {
                        kind: 'rtc.send',
                        commandId: 'send',
                        connection: 'rtc',
                        transport: 'realtime',
                        send: {
                            roomId: 'room-1',
                            data: {
                                topic: 'hello'
                            }
                        }
                    }
                ]
            } as Parameters<typeof distributedRecipePreflight>[0]
        );

        expect(unsafe.warnings).toEqual(expect.arrayContaining([
            expect.stringContaining('RTC send traffic starts without an explicit rtc.connect readiness contract'),
            expect.stringContaining('Looped RTC sends are especially sensitive')
        ]));
        expect(safe.warnings.some((warning) => warning.includes('without an explicit rtc.connect readiness contract'))).toBe(false);
        expect(safe.tree.find((row) => row.commandId === 'connect')?.details).toEqual(expect.arrayContaining([
            'readiness: min 1 ready peer(s), timeout 10000 ms, poll 100 ms'
        ]));
    });

    it('runs the app-local composite evidence fixture in the browser-agent runtime', async () => {
        const fixture = RALLAR_BLACK_BOX_RECIPE_FIXTURES.find((entry) => entry.fixtureId === 'composite-evidence');
        const runtime = createRallarBlackBoxTestRuntime();

        for (const command of fixture!.recipe.commands) {
            const result = await runtime.execute(command);
            expect(result.ok, result.error?.message).toBe(true);
        }

        const history = selectRallarBlackBoxCommandHistory(runtime.state());

        expect(history).toHaveLength(9);
        expect(history.map((result) => result.commandId)).toEqual(expect.arrayContaining([
            'composite-health-loop:i1:c1:loop-health',
            'composite-health-loop:i2:c1:loop-health',
            'composite-health-loop',
            'parallel-evidence:g1:left-health:c1:parallel-left-health',
            'parallel-evidence:g2:right-stats:c1:parallel-right-stats',
            'parallel-evidence',
            'wait-for-parallel-result',
            'assert-wait-succeeded',
            'composite-evidence-stats'
        ]));
        expect(history.at(-1)?.commandId).toBe('composite-evidence-stats');
        expect(runtime.state().resultCache['wait-for-parallel-result'].ok).toBe(true);
        expect(runtime.state().resultCache['assert-wait-succeeded'].ok).toBe(true);
    });

    it('projects the shared fixture catalog with configured recipes and searchable execution facts', () => {
        const configuration = {
            group: {
                applicationId: 'game-app',
                workspaceId: 'live',
                groupId: 'arena-1'
            },
            apiBaseUrl: 'https://api.example.test',
            rtcRealtimeDurationSeconds: 7
        } as const;

        const projection = projectDistributedRecipeCatalog({ configuration });
        const rtcSmoke = projection.entries.find((entry) => entry.item.itemId === 'rtc-smoke');
        const providerParity = projection.entries.find((entry) => entry.item.itemId === 'provider-parity');
        const realtime = projection.entries.find((entry) => entry.item.itemId === RALLAR_BLACK_BOX_RTC_REALTIME_STABILITY_RECIPE_FIXTURE_ID);
        const configuredMulticastRecipes = [
            RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_SENDER_RECIPE_FIXTURE_ID,
            RALLAR_BLACK_BOX_RTC_MESSAGES_PRINCIPAL_MULTICAST_RECEIVER_RECIPE_FIXTURE_ID,
            RALLAR_BLACK_BOX_RTC_MESSAGES_ALL_PEER_MULTICAST_RECIPE_FIXTURE_ID
        ].map((fixtureId) => projection.entries.find((entry) => entry.item.itemId === fixtureId)?.item.recipe);

        expect(DISTRIBUTED_RECIPE_CATALOG).toBe(SHARED_DISTRIBUTED_RECIPE_CATALOG);
        expect(configuredDistributedRecipeCatalogItem)
            .toBe(sharedConfiguredDistributedRecipeCatalogItem);
        expect(distributedRecipeMatches).toBe(sharedDistributedRecipeMatches);
        expect(projection.entries).toHaveLength(RALLAR_BLACK_BOX_RECIPE_FIXTURES.length);
        expect(projection.profiles).toEqual(expect.arrayContaining([
            'green',
            'negative',
            'rtc-realtime-stability',
            'smoke'
        ]));
        expect(projection.providerModes).toEqual(['browser-rallar', 'simulated']);
        expect(rtcSmoke?.item.recipe.commands[0]).toMatchObject({
            kind: 'http.request',
            request: {
                path: expect.stringMatching(
                    /^\/api\/state\/apps\/game-app\/workspaces\/live\/groups\/requests\/[^/]+$/
                )
            }
        });
        expect(providerParity?.item.recipe.commands[0]).toMatchObject({
            kind: 'configure',
            config: {
                apiBaseUrl: 'https://api.example.test',
                rallar: {
                    apiBaseUrl: 'https://api.example.test'
                }
            }
        });
        expect(realtime?.schema).toMatchObject({
            ok: true,
            status: 'valid',
            label: 'Schema valid (v1)'
        });
        expect(realtime?.preflight.liveServiceRequirements).toEqual(expect.arrayContaining([
            'Rallar API and signaling when provider mode is browser-rallar or rallar-browser',
            'active RTC connection'
        ]));
        for (const configuredRecipe of configuredMulticastRecipes) {
            expect(configuredRecipe).toBeDefined();
            expect(configuredRecipe?.commands[0]).toMatchObject({
                kind: 'http.request',
                request: {
                    path: expect.stringMatching(
                        /^\/api\/state\/apps\/game-app\/workspaces\/live\/groups\/requests\/[^/]+$/
                    )
                }
            });
            expect(configuredRecipe?.commands.find((command) => command.kind === 'rtc.connect'))
                .toMatchObject({
                    applicationId: 'game-app',
                    workspaceId: 'live',
                    roomId: 'arena-1',
                    roomRef: configuration.group
                });
            const stream = configuredRecipe?.commands.find((command) => command.kind === 'rtc.stream');
            if (stream) {
                expect(stream).toMatchObject({
                    applicationId: 'game-app',
                    workspaceId: 'live',
                    roomId: 'arena-1',
                    roomRef: configuration.group,
                    send: {
                        roomId: 'arena-1',
                        roomRef: configuration.group
                    }
                });
            }
            expect(JSON.stringify(configuredRecipe)).not.toContain('rallar-black-box-room');
        }
        expect(configuredMulticastRecipes.filter((configuredRecipe) => configuredRecipe?.commands.some((command) => command.kind === 'rtc.stream')))
            .toHaveLength(
                2
            );
        expect(distributedRecipeMatches(realtime!.item, 'stability stream', 'green')).toBe(true);
        expect(distributedRecipeMatches(realtime!.item, 'stability stream', 'negative')).toBe(false);
    });

    it('requires reported CRDT capability when selected recipes use CRDT commands', () => {
        const rows = distributedRecipeTargetRows({
            run: {
                ...runSnapshot,
                agents: runSnapshot.agents.map((agent) =>
                    agent.agentId === 'agent-a'
                        ? {
                            ...agent,
                            identity: {
                                ...AGENT_A_IDENTITY,
                                capabilities: {
                                    crdt: {
                                        supported: true,
                                        transports: [
                                            'local-only',
                                            'ws',
                                            'rtc',
                                            'ws-then-rtc',
                                            'rtc-with-ws-fallback'
                                        ],
                                        apiBaseUrlConfigured: true
                                    },
                                    assertions: FULL_ASSERTIONS_CAPABILITY,
                                    messaging: FULL_MESSAGING_CAPABILITY
                                }
                            }
                        }
                        : agent
                )
            },
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'bb-group'
            },
            requiredCommandKinds: ['crdt.open', 'crdt.wait'],
            nowEpochMs: 2_500
        });

        expect(rows.map((row) => [row.agentId, row.status, row.targetable])).toEqual([
            ['agent-a', 'matched', true],
            ['agent-b', 'offline', false],
            ['agent-c', 'different-group', false]
        ]);
        expect(defaultDistributedRecipeTargetIds(rows)).toEqual(['agent-a']);

        const missingRows = distributedRecipeTargetRows({
            run: runSnapshot,
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'bb-group'
            },
            requiredCommandKinds: ['crdt.open'],
            nowEpochMs: 2_500
        });

        expect(missingRows[0]).toMatchObject({
            agentId: 'agent-a',
            status: 'missing-crdt-runtime',
            targetable: false
        });
    });

    it('scopes recipe progress to the same resolved and manifest assignments used by the control service', () => {
        const recipes = [
            {
                recipeId: 'sender-recipe',
                role: 'sender',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'sender-recipe',
                    commands: [{ kind: 'health' }]
                },
                variables: {},
                secretRefs: [],
                required: true
            },
            {
                recipeId: 'receiver-recipe',
                role: 'receiver',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'receiver-recipe',
                    commands: [{ kind: 'health' }]
                },
                variables: {},
                secretRefs: [],
                required: true
            },
            {
                recipeId: 'shared-recipe',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'shared-recipe',
                    commands: [{ kind: 'health' }]
                },
                variables: {},
                secretRefs: [],
                required: true
            }
        ] satisfies ControlDistributedRunSnapshot['manifest']['recipes'];
        const resolvedAssignments = [
            { agentId: 'agent-a', role: 'sender', recipeIds: ['sender-recipe'], required: true, variables: {} },
            { agentId: 'agent-b', role: 'receiver', recipeIds: [], required: true, variables: {} },
            { agentId: 'agent-c', role: 'observer', recipeIds: ['shared-recipe'], required: true, variables: {} }
        ] as const;
        const commandLinks = [
            {
                phase: 'stage',
                agentId: 'agent-a',
                commandId: 'sender-a',
                recipeId: 'sender-recipe',
                role: 'sender',
                queuedAtEpochMs: 1_100
            },
            {
                phase: 'stage',
                agentId: 'agent-b',
                commandId: 'receiver-b',
                recipeId: 'receiver-recipe',
                role: 'receiver',
                queuedAtEpochMs: 1_110
            },
            { phase: 'stage', agentId: 'agent-b', commandId: 'shared-b', recipeId: 'shared-recipe', queuedAtEpochMs: 1_120 },
            { phase: 'stage', agentId: 'agent-c', commandId: 'shared-c', recipeId: 'shared-recipe', queuedAtEpochMs: 1_130 }
        ] satisfies ControlDistributedRunSnapshot['commandLinks'];
        const roleScopedRun: ControlDistributedRunSnapshot = {
            ...distributedRun,
            state: 'staging',
            targetAgentIds: ['agent-a', 'agent-b', 'agent-c'],
            manifest: {
                ...distributedRun.manifest,
                recipes,
                targetPolicy: {
                    mode: 'role-map',
                    roles: {
                        sender: ['agent-c'],
                        receiver: ['agent-a']
                    },
                    includeOfflineExpectedAgents: false
                },
                roleAssignments: [
                    { agentId: 'agent-a', role: 'receiver', variables: {}, recipeIds: [], required: true },
                    { agentId: 'agent-b', role: 'sender', variables: {}, recipeIds: [], required: true }
                ]
            },
            targetResolution: {
                group: distributedRun.manifest.group,
                resolvedAtEpochMs: 1_050,
                staleAfterMs: 30_000,
                targetPolicyMode: 'role-map',
                targetAgentIds: ['agent-a', 'agent-b', 'agent-c'],
                roleAssignments: resolvedAssignments,
                blockers: [],
                summary: {
                    agents: 3,
                    targetable: 3,
                    selected: 3,
                    expectedParticipantCount: 3,
                    missingExpectedParticipants: 0,
                    staleAgents: 0,
                    offlineAgents: 0,
                    wrongGroupAgents: 0,
                    assertionCapabilityBlockedAgents: 0,
                    agentsWithoutIdentity: 0,
                    roleCounts: { sender: 1, receiver: 1, observer: 1 },
                    regions: {},
                    providers: {}
                }
            },
            commandLinks
        };

        const resolvedProgress = deriveDistributedRunMonitor({
            distributedRun: roleScopedRun
        }).recipeProgress;

        expect(resolvedProgress.map((row) => [row.recipeId, row.targetCount, row.missingCount])).toEqual([
            ['sender-recipe', 1, 0],
            ['receiver-recipe', 1, 0],
            ['shared-recipe', 2, 0]
        ]);

        const manifestProgress = deriveDistributedRunMonitor({
            distributedRun: {
                ...roleScopedRun,
                targetResolution: undefined,
                manifest: {
                    ...roleScopedRun.manifest,
                    targetPolicy: {
                        mode: 'selected-agents',
                        agentIds: ['agent-a', 'agent-b', 'agent-c'],
                        includeOfflineExpectedAgents: false
                    },
                    roleAssignments: resolvedAssignments
                }
            }
        }).recipeProgress;

        expect(manifestProgress.map((row) => [row.recipeId, row.targetCount, row.missingCount])).toEqual([
            ['sender-recipe', 1, 0],
            ['receiver-recipe', 1, 0],
            ['shared-recipe', 2, 0]
        ]);
    });

    it('validates v1 and v2 distributed artifacts without breaking old bundles', () => {
        const v1Monitor = deriveDistributedRunMonitor({
            distributedRun,
            controlRun: distributedControlRun,
            artifactBundle: distributedArtifactBundle
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
                    'metadata.json': '{}'
                }
            }
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
                    'failures.json': '{}'
                }
            }
        });

        expect(v1Monitor.artifact).toMatchObject({
            status: 'valid',
            message: expect.stringContaining('v1')
        });
        expect(v2Monitor.artifact).toMatchObject({
            status: 'valid',
            message: expect.stringContaining('v2')
        });
        expect(invalidV2Monitor.artifact).toMatchObject({
            status: 'missing-file'
        });
        expect(invalidV2Monitor.artifact.message).toContain('metadata.json');
    });

    it('does not synthesize a readiness failure category for a nonterminal run without actual failures', () => {
        const runningRun: ControlDistributedRunSnapshot = {
            ...distributedRun,
            distributedRunId: 'dist-running',
            state: 'running',
            rollup: {
                ...distributedRun.rollup,
                state: 'running',
                ok: true,
                failures: [],
                summary: {
                    ...distributedRun.rollup.summary,
                    failedParticipants: 0,
                    failedRecipes: 0,
                    blockingFailures: 0
                }
            }
        };

        expect(filterDistributedRuns([runningRun], {
            failureCategory: 'readiness'
        })).toEqual([]);
    });
});
