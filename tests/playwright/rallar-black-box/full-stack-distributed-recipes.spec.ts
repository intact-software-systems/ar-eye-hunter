import { expect, test } from '@playwright/test';

import {
    deriveDistributedRunMonitor,
    deriveDistributedRunWarningRegressionReport
} from '../../../apps/rallar-black-box/src/distributed-recipes.ts';
import { type RallarBlackBoxDistributedGroupRef } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import { RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ } from '../../../packages/shared-test/rallar-bb-test/fixtures/rtc-realtime-recipes.ts';

import {
    agentAuth,
    config,
    configureAgentsForDistributedGroup,
    hasLiveDistributedConfig,
    openControlAgent,
    openScriptedControlAgent,
    scriptedControlResult,
    setupGroupMembership,
    type AgentHandle
} from './distributed-recipes/browser-agents.ts';
import {
    createDistributedRun,
    executeOk,
    mutateDistributedRun,
    readDistributedArtifact,
    runToPassed,
    waitForAgentsInGroup,
    waitForDistributedState
} from './distributed-recipes/distributed-control.ts';
import {
    compositeEvidenceRecipe,
    createDistributedManifest,
    createPreprovisionedRealtimeRecipe,
    healthRecipe,
    rtcConnectRecipe,
    rtcSendRecipe,
    wsSendRecipe
} from './distributed-recipes/recipe-manifests.ts';
import {
    attachConsoleArtifacts,
    attachDistributedRunSummary,
    attachDistributedWarningRegressionReport,
    DistributedRecipeConsoleRecorder,
    toHighSeverityConsoleEntries,
    toRetainedRealtimeRecipeEvidence
} from './distributed-recipes/run-evidence.ts';
import {
    emitKnownLiveWarningDiagnostics,
    waitForBrowserMessage,
    waitForRealtimePositionPayload,
    waitForRuntimeDiagnostic
} from './distributed-recipes/runtime-observations.ts';
import {
    FULL_STACK_CONTROL_BASE_URL,
    readControlRun,
    uniqueSuffix
} from './full-stack-helpers.ts';

test.describe('full-stack distributed recipes with simulated agents', () => {
    test.skip(!config.enabled, config.skipReason);

    test('runs all-agent ACK through group target resolution and shows artifacts/history', async ({
        browser,
        request
    }, testInfo) => {
        test.setTimeout(120_000);
        const suffix = uniqueSuffix();
        const runId = `dist-sim-ack-${suffix}`;
        const group: RallarBlackBoxDistributedGroupRef = {
            applicationId: config.applicationId,
            workspaceId: config.workspaceId,
            groupId: `dist-sim-group-${suffix}`
        };
        const handles: AgentHandle[] = [];

        try {
            for (const prefix of ['A', 'B', 'C'] as const) {
                handles.push(
                    await openControlAgent(browser, {
                        provider: 'simulated',
                        prefix,
                        runId,
                        agentId: `dist-sim-${prefix.toLowerCase()}-${suffix}`,
                        actor: `sim-${prefix.toLowerCase()}-${suffix}`,
                        connection: `dist-sim-${prefix.toLowerCase()}-${suffix}`,
                        group
                    })
                );
            }
            await configureAgentsForDistributedGroup({ request, runId, handles, provider: 'simulated', group, suffix });
            await waitForAgentsInGroup({ request, runId, agentIds: handles.map((handle) => handle.agentId), group });

            const recipe = compositeEvidenceRecipe(`composite-ack-all-${suffix}`);
            const manifest = createDistributedManifest({
                distributedRunId: `dist-ack-${suffix}`,
                controlRunId: runId,
                group,
                recipes: [{
                    recipeId: recipe.recipeId,
                    recipe,
                    profile: 'full-stack',
                    variables: {}
                }],
                targetPolicy: {
                    mode: 'all-online-group-members',
                    expectedParticipantCount: 3
                },
                displayName: 'All-agent ACK smoke'
            });

            const passed = await runToPassed(request, manifest);
            expect([...passed.targetAgentIds].sort()).toEqual(handles.map((handle) => handle.agentId).sort());
            expect(passed.rollup.summary.passedParticipants).toBe(3);
            expect(passed.commandLinks.filter((link) => link.phase === 'stage')).toHaveLength(3);
            expect(passed.commandLinks.filter((link) => link.phase === 'start')).toHaveLength(3);

            const artifact = await readDistributedArtifact(request, manifest.distributedRunId);
            expect(artifact.files?.['distributed-run.json']).toContain(manifest.distributedRunId);
            expect(artifact.files?.['manifest.json']).toContain(recipe.recipeId);
            expect(artifact.files?.['control-run.json']).toContain(runId);

            const panel = handles[0].page.locator('#panel-distributed-recipes');
            await handles[0].page.getByRole('button', {
                name: 'Distributed Recipes',
                exact: true
            }).click();
            await panel.getByRole('button', { name: 'Refresh' }).click();
            await expect(panel).toContainText(manifest.distributedRunId, { timeout: 15_000 });
            await expect(panel).toContainText('passed');
        }
        finally {
            await attachDistributedRunSummary(request, testInfo, runId).catch(() => undefined);
            await Promise.all(handles.map((handle) => handle.context.close().catch(() => undefined)));
        }
    });

    test('covers missing target, schema failure, ACK timeout, disconnect, and failure rollup', async ({ browser, request }) => {
        test.setTimeout(180_000);
        const suffix = uniqueSuffix();
        const runId = `dist-sim-negative-${suffix}`;
        const group: RallarBlackBoxDistributedGroupRef = {
            applicationId: config.applicationId,
            workspaceId: config.workspaceId,
            groupId: `dist-sim-negative-${suffix}`
        };
        const handles: AgentHandle[] = [];
        let ackTimeoutSocket: WebSocket | undefined;
        let failureSocket: WebSocket | undefined;

        try {
            for (const prefix of ['A', 'B', 'C'] as const) {
                handles.push(
                    await openControlAgent(browser, {
                        provider: 'simulated',
                        prefix,
                        runId,
                        agentId: `dist-neg-${prefix.toLowerCase()}-${suffix}`,
                        actor: `dist-neg-${prefix.toLowerCase()}-${suffix}`,
                        connection: `dist-neg-${prefix.toLowerCase()}-${suffix}`,
                        group
                    })
                );
            }
            await configureAgentsForDistributedGroup({ request, runId, handles, provider: 'simulated', group, suffix });
            await waitForAgentsInGroup({ request, runId, agentIds: handles.map((handle) => handle.agentId), group });

            const schemaFailureResponse = await request.post(`${FULL_STACK_CONTROL_BASE_URL}/distributed-runs`, {
                data: {
                    manifest: {
                        distributedRunId: `dist-invalid-${suffix}`,
                        recipes: []
                    }
                }
            });
            expect(schemaFailureResponse.status()).toBe(400);
            expect(await schemaFailureResponse.text()).toMatch(/group|recipes|required/i);

            const missingManifest = createDistributedManifest({
                distributedRunId: `dist-missing-${suffix}`,
                controlRunId: runId,
                group,
                recipes: [{
                    recipeId: `missing-health-${suffix}`,
                    recipe: healthRecipe(`missing-health-${suffix}`),
                    variables: {}
                }],
                targetPolicy: {
                    mode: 'all-online-group-members',
                    expectedParticipantCount: 4
                }
            });
            await createDistributedRun(request, missingManifest);
            const missing = await mutateDistributedRun(request, missingManifest.distributedRunId, 'stage');
            expect(missing.state).toBe('failed');
            expect(missing.error?.code).toBe('RALLAR_BB_DISTRIBUTED_TARGET_COUNT_MISMATCH');

            const ackTimeoutAgentId = `silent-no-ack-${suffix}`;
            ackTimeoutSocket = await openScriptedControlAgent({
                runId,
                agentId: ackTimeoutAgentId,
                group,
                providerMode: 'silent-control'
            });
            await waitForAgentsInGroup({ request, runId, agentIds: [ackTimeoutAgentId], group });

            const ackTimeoutManifest = createDistributedManifest({
                distributedRunId: `dist-ack-timeout-${suffix}`,
                controlRunId: runId,
                group,
                recipes: [{
                    recipeId: `timeout-health-${suffix}`,
                    recipe: healthRecipe(`timeout-health-${suffix}`),
                    variables: {}
                }],
                targetPolicy: {
                    mode: 'selected-agents',
                    agentIds: [ackTimeoutAgentId],
                    expectedParticipantCount: 1
                },
                ackTimeoutMs: 100
            });
            await createDistributedRun(request, ackTimeoutManifest);
            await mutateDistributedRun(request, ackTimeoutManifest.distributedRunId, 'stage');
            const timedOut = await waitForDistributedState({
                request,
                distributedRunId: ackTimeoutManifest.distributedRunId,
                state: 'timed-out',
                timeout: 15_000
            });
            expect(JSON.stringify(timedOut.rollup.failures)).toContain('RALLAR_BB_DISTRIBUTED_ACK_TIMEOUT');
            ackTimeoutSocket.close();
            ackTimeoutSocket = undefined;

            const failureAgentId = `scripted-failure-${suffix}`;
            failureSocket = await openScriptedControlAgent({
                runId,
                agentId: failureAgentId,
                group,
                providerMode: 'scripted-failure',
                onCommand: (command) =>
                    scriptedControlResult({
                        runId,
                        agentId: failureAgentId,
                        command,
                        ok: command.command.kind === 'recipe.load',
                        errorCode: 'RALLAR_BLACK_BOX_RECIPE_FAILED',
                        errorMessage: 'Scripted distributed recipe failure.'
                    })
            });
            await waitForAgentsInGroup({ request, runId, agentIds: [failureAgentId], group });

            const failureManifest = createDistributedManifest({
                distributedRunId: `dist-one-agent-fails-${suffix}`,
                controlRunId: runId,
                group,
                recipes: [
                    {
                        recipeId: `role-pass-${suffix}`,
                        role: 'passer',
                        recipe: healthRecipe(`role-pass-${suffix}`),
                        variables: {}
                    },
                    {
                        recipeId: `role-fail-${suffix}`,
                        role: 'breaker',
                        recipe: {
                            schemaVersion: 1,
                            recipeId: `role-fail-${suffix}`,
                            commands: [{
                                kind: 'ws.send',
                                commandId: `role-fail-ws-${suffix}`,
                                connection: `missing-ws-${suffix}`,
                                data: {
                                    scenario: 'expected recipe failure'
                                }
                            }]
                        },
                        variables: {}
                    }
                ],
                targetPolicy: {
                    mode: 'role-map',
                    roles: {
                        passer: [handles[0].agentId],
                        breaker: [failureAgentId]
                    },
                    expectedParticipantCount: 2
                }
            });
            await createDistributedRun(request, failureManifest);
            await mutateDistributedRun(request, failureManifest.distributedRunId, 'stage');
            await waitForDistributedState({
                request,
                distributedRunId: failureManifest.distributedRunId,
                state: 'ready'
            });
            await mutateDistributedRun(request, failureManifest.distributedRunId, 'start');
            const failed = await waitForDistributedState({
                request,
                distributedRunId: failureManifest.distributedRunId,
                state: 'failed'
            });
            expect(failed.rollup.summary.failedRecipes).toBeGreaterThanOrEqual(1);
            expect(JSON.stringify(failed.rollup.failures)).toContain('RALLAR_BLACK_BOX_RECIPE_FAILED');

            const disconnectManifest = createDistributedManifest({
                distributedRunId: `dist-disconnect-after-stage-${suffix}`,
                controlRunId: runId,
                group,
                recipes: [{
                    recipeId: `disconnect-health-${suffix}`,
                    recipe: healthRecipe(`disconnect-health-${suffix}`),
                    variables: {}
                }],
                targetPolicy: {
                    mode: 'selected-agents',
                    agentIds: [handles[0].agentId, handles[1].agentId],
                    expectedParticipantCount: 2
                }
            });
            await createDistributedRun(request, disconnectManifest);
            await mutateDistributedRun(request, disconnectManifest.distributedRunId, 'stage');
            await waitForDistributedState({
                request,
                distributedRunId: disconnectManifest.distributedRunId,
                state: 'ready'
            });
            await handles[1].context.close();
            await expect.poll(async () => {
                const run = await readControlRun(request, runId);
                return run.agents.find((agent) => agent.agentId === handles[1].agentId)?.connected;
            }, { timeout: 10_000 }).toBe(false);
            await mutateDistributedRun(request, disconnectManifest.distributedRunId, 'start');
            const running = await waitForDistributedState({
                request,
                distributedRunId: disconnectManifest.distributedRunId,
                state: 'running',
                timeout: 15_000
            });
            const disconnectedStart = running.commandLinks.find((link) =>
                link.phase === 'start' && link.agentId === handles[1].agentId
            );
            expect(disconnectedStart).toBeTruthy();
            const runAfterDisconnect = await readControlRun(request, runId);
            expect(
                runAfterDisconnect.commands?.find((command) =>
                    command.envelope?.commandId === disconnectedStart?.commandId
                )
                    ?.completedAtEpochMs
            ).toBeUndefined();
            const cancelled = await mutateDistributedRun(request, disconnectManifest.distributedRunId, 'cancel');
            expect(cancelled.state).toBe('cancelled');
        }
        finally {
            ackTimeoutSocket?.close();
            failureSocket?.close();
            await Promise.all(handles.map((handle) => handle.context.close().catch(() => undefined)));
        }
    });
});

test.describe('full-stack distributed recipes with live Rallar data', () => {
    test.skip(
        !hasLiveDistributedConfig,
        [
            'Set RALLAR_BLACK_BOX_FULL_STACK=1 and RALLAR_BLACK_BOX_DISTRIBUTED_RECIPES=1,',
            'VITE_RALLAR_API_BASE_URL, and three live users/restored sessions.',
            'Use VITE_RALLAR_AGENT_A/B/C_USERNAME and VITE_RALLAR_AGENT_A/B/C_PASSWORD,',
            'or matching TOKEN/CLIENT_ID/SESSION_ID variables.'
        ].join(' ')
    );

    test('runs distributed ACK, WS, and RTC recipes against real browser agents', async ({
        browser,
        request
    }, testInfo) => {
        test.setTimeout(420_000);
        const suffix = `dist-live-${uniqueSuffix()}`;
        const runId = `distributed-live-${suffix}`;
        const group: RallarBlackBoxDistributedGroupRef = {
            applicationId: config.applicationId,
            workspaceId: config.workspaceId,
            groupId: `${config.roomId}-${suffix}`
        };
        const handles: AgentHandle[] = [];
        const consoleArtifacts = new DistributedRecipeConsoleRecorder(Date.now);

        try {
            for (const prefix of ['A', 'B', 'C'] as const) {
                const handle = await openControlAgent(browser, {
                    provider: 'browser-rallar',
                    prefix,
                    runId,
                    agentId: `dist-live-${prefix.toLowerCase()}-${suffix}`,
                    actor: `dist-live-${prefix.toLowerCase()}-${suffix}`,
                    connection: `dist-live-${prefix.toLowerCase()}-${suffix}`,
                    group,
                    auth: agentAuth(prefix)
                });
                consoleArtifacts.watch(handle.page, handle.agentId);
                handles.push(handle);
            }
            await configureAgentsForDistributedGroup({
                request,
                runId,
                handles: handles,
                provider: 'browser-rallar',
                group,
                suffix
            });
            await waitForAgentsInGroup({ request, runId, agentIds: handles.map((agent) => agent.agentId), group });
            await setupGroupMembership(request, runId, {
                owner: handles[0],
                members: handles,
                group,
                suffix
            });

            const ackRecipe = healthRecipe(`live-ack-${suffix}`);
            const ack = await runToPassed(
                request,
                createDistributedManifest({
                    distributedRunId: `dist-live-ack-${suffix}`,
                    controlRunId: runId,
                    group,
                    recipes: [{
                        recipeId: ackRecipe.recipeId,
                        recipe: ackRecipe,
                        profile: 'live',
                        variables: {}
                    }],
                    targetPolicy: {
                        mode: 'all-online-group-members',
                        expectedParticipantCount: 3
                    }
                })
            );
            expect(ack.targetAgentIds).toHaveLength(3);

            const wsTypeId = `room.rallar-black-box.distributed.ws.${suffix}`;
            const wsTopicId = wsTypeId;
            const wsPrimerId = `ws-primer-${suffix}`;
            const wsPrimerRecipe = wsSendRecipe(`live-ws-primer-${suffix}`, group, {
                typeId: wsTypeId,
                topicId: wsTopicId,
                messageId: wsPrimerId,
                role: 'primer'
            });
            await runToPassed(
                request,
                createDistributedManifest({
                    distributedRunId: `dist-live-ws-primer-${suffix}`,
                    controlRunId: runId,
                    group,
                    recipes: [{
                        recipeId: wsPrimerRecipe.recipeId,
                        recipe: wsPrimerRecipe,
                        profile: 'live-ws',
                        variables: {}
                    }],
                    targetPolicy: {
                        mode: 'selected-agents',
                        agentIds: handles.map((agent) => agent.agentId),
                        expectedParticipantCount: 3
                    }
                })
            );

            const wsMessageId = `ws-sender-receiver-${suffix}`;
            const wsDistributedRunId = `dist-live-ws-send-${suffix}`;
            const wsSenderRecipe = wsSendRecipe(`live-ws-sender-${suffix}`, group, {
                typeId: wsTypeId,
                topicId: wsTopicId,
                messageId: wsMessageId,
                role: 'sender',
                distributedRunId: wsDistributedRunId
            });
            const wsPassed = await runToPassed(
                request,
                createDistributedManifest({
                    distributedRunId: wsDistributedRunId,
                    controlRunId: runId,
                    group,
                    recipes: [{
                        recipeId: wsSenderRecipe.recipeId,
                        role: 'sender',
                        recipe: wsSenderRecipe,
                        profile: 'live-ws',
                        variables: {}
                    }],
                    targetPolicy: {
                        mode: 'role-map',
                        roles: {
                            sender: [handles[0].agentId]
                        },
                        expectedParticipantCount: 1
                    }
                })
            );
            await Promise.all([
                waitForBrowserMessage(request, runId, {
                    agentId: handles[1].agentId,
                    transport: 'ws',
                    messageId: wsMessageId
                }),
                waitForBrowserMessage(request, runId, {
                    agentId: handles[2].agentId,
                    transport: 'ws',
                    messageId: wsMessageId
                })
            ]);
            const wsArtifact = await readDistributedArtifact(request, wsDistributedRunId);
            const wsWarningReport = deriveDistributedRunWarningRegressionReport({
                distributedRun: wsPassed,
                controlRun: await readControlRun(request, runId),
                artifactBundle: wsArtifact,
                expectation: {
                    messageEvidence: [wsMessageId],
                    failOnDiagnosticSeverities: ['error']
                }
            });
            await attachDistributedWarningRegressionReport(
                testInfo,
                'distributed-live-ws-warning-regression',
                wsWarningReport
            );
            expect(wsWarningReport.ok, wsWarningReport.failures.join('\n')).toBe(true);

            const rtcConnect = rtcConnectRecipe(`live-rtc-connect-${suffix}`, group);
            await runToPassed(
                request,
                createDistributedManifest({
                    distributedRunId: `dist-live-rtc-connect-${suffix}`,
                    controlRunId: runId,
                    group,
                    recipes: [{
                        recipeId: rtcConnect.recipeId,
                        recipe: rtcConnect,
                        profile: 'live-rtc',
                        variables: {}
                    }],
                    targetPolicy: {
                        mode: 'selected-agents',
                        agentIds: handles.map((agent) => agent.agentId),
                        expectedParticipantCount: 3
                    }
                })
            );

            const rtcMessageId = `rtc-broadcast-${suffix}`;
            const rtcDistributedRunId = `dist-live-rtc-send-${suffix}`;
            const rtcSender = rtcSendRecipe({
                recipeId: `live-rtc-send-${suffix}`,
                group,
                messageId: rtcMessageId,
                distributedRunId: rtcDistributedRunId
            });
            const rtcPassed = await runToPassed(
                request,
                createDistributedManifest({
                    distributedRunId: rtcDistributedRunId,
                    controlRunId: runId,
                    group,
                    recipes: [{
                        recipeId: rtcSender.recipeId,
                        role: 'sender',
                        recipe: rtcSender,
                        profile: 'live-rtc',
                        variables: {}
                    }],
                    targetPolicy: {
                        mode: 'role-map',
                        roles: {
                            sender: [handles[0].agentId]
                        },
                        expectedParticipantCount: 1
                    }
                })
            );
            await Promise.all([
                waitForBrowserMessage(request, runId, {
                    agentId: handles[1].agentId,
                    transport: 'realtime',
                    messageId: rtcMessageId
                }),
                waitForBrowserMessage(request, runId, {
                    agentId: handles[2].agentId,
                    transport: 'realtime',
                    messageId: rtcMessageId
                })
            ]);

            const rtcArtifact = await readDistributedArtifact(request, rtcDistributedRunId);
            expect(rtcArtifact.files?.['distributed-run.json']).toContain(rtcMessageId);
            const rtcWarningReport = deriveDistributedRunWarningRegressionReport({
                distributedRun: rtcPassed,
                controlRun: await readControlRun(request, runId),
                artifactBundle: rtcArtifact,
                expectation: {
                    messageEvidence: [rtcMessageId],
                    failOnDiagnosticSeverities: ['error']
                }
            });
            await attachDistributedWarningRegressionReport(
                testInfo,
                'distributed-live-rtc-warning-regression',
                rtcWarningReport
            );
            expect(rtcWarningReport.ok, rtcWarningReport.failures.join('\n')).toBe(true);

            const realtimeDistributedRunId = `dist-live-rtc-realtime-${suffix}`;
            const realtimeConnection = `realtime-${realtimeDistributedRunId}`;
            const realtimeRecipe = createPreprovisionedRealtimeRecipe({
                recipeId: `live-rtc-realtime-${suffix}`,
                group,
                distributedRunId: realtimeDistributedRunId,
                connection: realtimeConnection
            });
            expect(realtimeRecipe.commands.map((command) => command.kind)).toEqual(['rtc.connect', 'loop', 'stats']);
            const realtimePassed = await runToPassed(
                request,
                createDistributedManifest({
                    distributedRunId: realtimeDistributedRunId,
                    controlRunId: runId,
                    group,
                    recipes: [{
                        recipeId: realtimeRecipe.recipeId,
                        recipe: realtimeRecipe,
                        profile: 'live-rtc-realtime',
                        variables: {}
                    }],
                    targetPolicy: {
                        mode: 'selected-agents',
                        agentIds: handles.map((agent) => agent.agentId),
                        expectedParticipantCount: 3
                    }
                })
            );
            await waitForRealtimePositionPayload(request, runId, realtimeDistributedRunId);
            const beforeWarningEvents = (await readControlRun(request, runId)).events.length;
            await emitKnownLiveWarningDiagnostics(handles, {
                distributedRunId: realtimeDistributedRunId,
                group
            });
            await Promise.all([
                waitForRuntimeDiagnostic(request, runId, {
                    agentId: handles[1].agentId,
                    group,
                    afterEventIndex: beforeWarningEvents,
                    connection: realtimeConnection,
                    transport: 'ws',
                    pattern: 'unhandled-ws-message',
                    diagnosticTypeId: 'rallar.browser.ws.unhandled_message'
                }),
                waitForRuntimeDiagnostic(request, runId, {
                    agentId: handles[2].agentId,
                    group,
                    afterEventIndex: beforeWarningEvents,
                    connection: realtimeConnection,
                    transport: 'realtime',
                    pattern: 'data-channel-name-mismatch',
                    diagnosticTypeId: 'rallar.browser.rtc.data_channel_warning'
                })
            ]);

            const realtimeControlRun = await readControlRun(request, runId);
            const realtimeArtifact = await readDistributedArtifact(request, realtimeDistributedRunId);
            const realtimeMonitor = deriveDistributedRunMonitor({
                distributedRun: realtimePassed,
                controlRun: realtimeControlRun,
                artifactBundle: realtimeArtifact
            });
            const retainedRealtimeEvidence = toRetainedRealtimeRecipeEvidence(
                realtimeControlRun,
                realtimePassed
            );
            await testInfo.attach('distributed-live-realtime-retained-evidence.json', {
                body: JSON.stringify(retainedRealtimeEvidence, null, 2),
                contentType: 'application/json'
            });
            expect(retainedRealtimeEvidence.compactedStartResults).toHaveLength(3);
            for (const result of retainedRealtimeEvidence.compactedStartResults) {
                expect(result).toEqual({
                    agentId: expect.any(String),
                    ok: true,
                    resultCount: realtimeRecipe.commands.length,
                    failureCount: 0,
                    evidenceStatus: 'finite',
                    payloadsOmitted: true,
                    retainedCommandCount: realtimeRecipe.commands.length
                });
            }
            expect(retainedRealtimeEvidence.loopStats).toHaveLength(3);
            for (const stats of retainedRealtimeEvidence.loopStats) {
                expect(stats).toEqual({
                    agentId: expect.any(String),
                    latestLoopCommandId: 'rtc-realtime-position-loop',
                    plannedIterations: RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
                    completedIterations: RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
                    sendCount: RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
                    succeeded: RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
                    failed: 0
                });
            }
            expect(realtimeMonitor.compositeDrilldowns.map((drilldown) => drilldown.agentId).sort())
                .toEqual(handles.map((agent) => agent.agentId).sort());
            for (const drilldown of realtimeMonitor.compositeDrilldowns) {
                expect(drilldown.recipeId).toBe(realtimeRecipe.recipeId);
                expect(drilldown.summary).toEqual({
                    total: RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ + 3,
                    passed: RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ + 3,
                    failed: 0,
                    cancelled: 0,
                    skipped: 0,
                    composite: 1,
                    leaf: RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ + 2
                });
                expect(drilldown.childDecodeIssues).toEqual([]);
                expect(drilldown.rows.filter((row) => row.kind === 'rtc.send'))
                    .toHaveLength(RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ);
                expect(drilldown.rows.find((row) => row.kind === 'loop'))
                    .toMatchObject({ commandId: 'rtc-realtime-position-loop', status: 'ok', ok: true });
            }

            const realtimeWarningReport = deriveDistributedRunWarningRegressionReport({
                distributedRun: realtimePassed,
                controlRun: realtimeControlRun,
                artifactBundle: realtimeArtifact,
                expectation: {
                    messageEvidence: [
                        realtimeDistributedRunId,
                        'room.black-box.rtc-realtime.position'
                    ],
                    diagnosticTypeIds: [
                        'rallar.browser.ws.unhandled_message',
                        'rallar.browser.rtc.data_channel_warning'
                    ],
                    compositeRecipeIds: [realtimeRecipe.recipeId],
                    failOnDiagnosticSeverities: ['error']
                }
            });
            await attachDistributedWarningRegressionReport(
                testInfo,
                'distributed-live-realtime-warning-regression',
                realtimeWarningReport
            );
            expect(realtimeWarningReport.ok, realtimeWarningReport.failures.join('\n')).toBe(true);

            const panel = handles[0].page.locator('#panel-distributed-recipes');
            await handles[0].page.getByRole('button', {
                name: 'Distributed Recipes',
                exact: true
            }).click();
            await panel.getByRole('button', { name: 'Refresh' }).click();
            await panel.locator('.distributed-run-list .distributed-run-row')
                .filter({ hasText: realtimeDistributedRunId })
                .first()
                .click();
            await expect(panel).toContainText(realtimeDistributedRunId);
            const diagnostics = panel.getByLabel('Distributed runtime diagnostics');
            await diagnostics.getByLabel('Severity', { exact: true }).selectOption('warning');
            const wsDiagnostic = diagnostics.locator('.distributed-monitor-row.diagnostic')
                .filter({ hasText: 'rallar.browser.ws.unhandled_message' }).filter({ hasText: handles[1].agentId });
            await expect(wsDiagnostic.first()).toContainText(group.groupId);
            await expect(wsDiagnostic.first().locator('.pill').filter({ hasText: /^warning$/ })).toHaveCount(1);
            await expect(wsDiagnostic.first().locator('.pill').filter({ hasText: /^ws$/ })).toHaveCount(1);
            const rtcDiagnostic = diagnostics.locator('.distributed-monitor-row.diagnostic')
                .filter({ hasText: 'rallar.browser.rtc.data_channel_warning' }).filter({ hasText: handles[2].agentId });
            await expect(rtcDiagnostic.first()).toContainText(group.groupId);
            await expect(rtcDiagnostic.first().locator('.pill').filter({ hasText: /^warning$/ })).toHaveCount(1);
            await expect(rtcDiagnostic.first().locator('.pill').filter({ hasText: /^realtime$/ })).toHaveCount(1);
            const composite = panel.getByLabel('Distributed composite drilldowns');
            await expect(composite.locator('.distributed-composite-card')).toHaveCount(3);
            for (const agent of handles) {
                const card = composite.locator('.distributed-composite-card').filter({ hasText: agent.agentId });
                await expect(card.locator('summary')).toContainText(realtimeRecipe.recipeId);
                await expect(card.locator('summary')).toContainText('0 failed');
                await card.locator('summary').click();
                await expect(card).toContainText('rtc-realtime-position-loop');
                await expect(card.locator('.distributed-composite-row')).toHaveCount(
                    RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ + 3
                );
            }

            const receiver = handles[1].page;
            await receiver.getByLabel('Rallar browser trace')
                .getByRole('button', { name: 'Event Stream', exact: true }).click();
            const eventStream = receiver.locator('#panel-event-stream');
            await expect(eventStream).toBeVisible();
            await eventStream.getByRole('group', { name: 'Event kind filter' })
                .getByRole('button', { name: 'message', exact: true }).click();
            await eventStream.getByLabel('Connection', { exact: true }).selectOption(realtimeConnection);
            await eventStream.getByLabel('Transport', { exact: true }).selectOption('realtime');
            await eventStream.getByLabel('Group', { exact: true }).selectOption(group.groupId);
            await eventStream.getByLabel('Topic', { exact: true }).fill('rallar.browser.realtime.message');
            const receivedMessage = eventStream.locator('.event-row').first();
            await expect(receivedMessage.locator('.event-topline .pill')).toHaveText('message');
            await expect(receivedMessage.locator('.event-topline strong')).toHaveText(
                'rallar.browser.realtime.message'
            );
            await expect(receivedMessage.locator('.event-meta')).toContainText(realtimeConnection);
            await expect(receivedMessage.locator('.event-meta').getByText('realtime', { exact: true })).toBeVisible();

            expect(toHighSeverityConsoleEntries(consoleArtifacts.getEntries())).toEqual([]);
        }
        finally {
            if (handles.length > 0) {
                await attachDistributedRunSummary(request, testInfo, runId).catch(() => undefined);
                await attachConsoleArtifacts(testInfo, consoleArtifacts.getEntries()).catch(() => undefined);
            }
            await Promise.all(handles.map(async (handle) => {
                await executeOk({
                    request,
                    runId,
                    agentId: handle.agentId,
                    commandId: `best-effort-close-${handle.prefix.toLowerCase()}-${suffix}`,
                    command: { kind: 'close' },
                    timeout: 15_000
                }).catch(() => undefined);
                await handle.context.close().catch(() => undefined);
            }));
        }
    });
});
