import { expect, test, type TestInfo } from '@playwright/test';
import { toError } from '@shared/resilience/to-error.ts';
import {
    agentAuth,
    apiBaseUrl,
    applicationId,
    booleanEnv,
    CONTROL_BASE_URL,
    envValue,
    firstEnvValue,
    hasThreeAgentConfig,
    openAgentTrio,
    rawEnvironmentValue,
    readLiveRtcClusterApiOrigins,
    roomSeed,
    workspaceId,
    type LiveRtcAgentTrio
} from './live-rtc-agent-environment.ts';
import { closeLiveRtcBrowserAgentContexts } from './live-rtc-browser-agents.ts';
import { LiveRtcControlClient } from './live-rtc-control-client.ts';
import {
    createLiveRtcDeliveryOperations,
    LiveRtcNackProbeFailure,
    type AgentPrefix
} from './live-rtc-delivery-operations.ts';
import { createLiveRtcFormationOperations } from './live-rtc-formation-operations.ts';
import {
    buildLiveRtcExternalAttempt,
    captureLiveRtcPostGcHeap,
    liveRtcRetentionStateReturned,
    loadLiveRtcPerformanceAttempt,
    writeLiveRtcPerformanceEvidence,
    writeLiveRtcRetentionCohortIfComplete,
    type LiveRtcDiagnosticsCheckpoint,
    type LiveRtcNackFailureDiagnostic,
    type LiveRtcPerformanceAttemptContext,
    type LiveRtcPerformanceRawEvidence,
    type LiveRtcPerformanceTiming,
    type LiveRtcRetentionCheckpoint
} from './live-rtc-performance-evidence.ts';

const messagesRtcTypeId = firstEnvValue('VITE_RALLAR_MESSAGES_RTC_TYPE_ID', 'VITE_RALLAR_TYPE_ID') ??
    'manual.type';
const messagesRtcTopicId = firstEnvValue('VITE_RALLAR_MESSAGES_RTC_TOPIC_ID', 'VITE_RALLAR_TOPIC_ID') ??
    'manual.topic';
const liveAllScenariosEnabled = booleanEnv(
    'RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS'
);
const liveRetentionSoakEnabled = booleanEnv(
    'RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK'
);
const liveRtcDeliveryOperations = createLiveRtcDeliveryOperations({
    apiBaseUrl,
    applicationId,
    workspaceId,
    messagesRtcTypeId,
    messagesRtcTopicId,
    formation: createLiveRtcFormationOperations()
});

interface VerifyGroupStateReadbackInput {
    readonly control: LiveRtcControlClient;
    readonly runId: string;
    readonly owner: LiveRtcControlClient.Agent;
    readonly groupId: string;
    readonly suffix: string;
}

async function verifyGroupStateReadback(
    input: VerifyGroupStateReadbackInput
): Promise<readonly string[]> {
    const groupSegment = encodeURIComponent(input.groupId);
    const readCommandId = `group-read-${input.suffix}`;
    const eventsCommandId = `group-events-${input.suffix}`;
    const readResult = await input.control.executeOk({
        runId: input.runId,
        agentId: input.owner.agentId,
        commandId: readCommandId,
        command: {
            kind: 'http.request',
            request: {
                path: `/api/state/apps/${encodeURIComponent(applicationId)}/workspaces/${
                    encodeURIComponent(
                        workspaceId
                    )
                }/groups/${groupSegment}`,
                method: 'GET'
            },
            response: {
                body: 'json'
            },
            timeoutMs: 10_000
        }
    });
    expect(input.control.resultValue(readResult).status).toBe(200);

    const eventsResult = await input.control.executeOk({
        runId: input.runId,
        agentId: input.owner.agentId,
        commandId: eventsCommandId,
        command: {
            kind: 'http.request',
            request: {
                path: `/api/state/apps/${encodeURIComponent(applicationId)}/workspaces/${
                    encodeURIComponent(
                        workspaceId
                    )
                }/groups/${groupSegment}/events/page?limit=20`,
                method: 'GET'
            },
            response: {
                body: 'json'
            },
            timeoutMs: 10_000
        }
    });
    expect(input.control.resultValue(eventsResult).status).toBe(200);
    return [readCommandId, eventsCommandId];
}

interface WriteAttemptEvidenceInput {
    readonly context: LiveRtcPerformanceAttemptContext | null;
    readonly producerExitStatus: number;
    readonly timings: readonly LiveRtcPerformanceTiming[];
    readonly diagnostics: readonly LiveRtcDiagnosticsCheckpoint[];
    readonly failureDiagnostics: readonly LiveRtcNackFailureDiagnostic[];
    readonly retention: LiveRtcPerformanceRawEvidence['retention'];
    readonly assertions: LiveRtcPerformanceRawEvidence['assertions'];
}

interface RetireLiveRtcAttemptAgentsInput {
    readonly control: LiveRtcControlClient;
    readonly runId: string;
    readonly agents: LiveRtcAgentTrio;
    readonly openHandles: readonly LiveRtcControlClient.Agent[];
    readonly suffix: string;
    readonly sessions: Readonly<Record<AgentPrefix, string>> | undefined;
}

interface RetiredLiveRtcAttemptAgents {
    readonly commandIds: readonly string[];
    readonly openHandles: LiveRtcControlClient.Agent[];
}

interface FinalizeLiveRtcAttemptInput extends WriteAttemptEvidenceInput {
    readonly control: LiveRtcControlClient;
    readonly testInfo: TestInfo;
    readonly runId: string;
    readonly agents: readonly LiveRtcControlClient.Agent[];
    readonly suffix: string;
    readonly failureCycle: number | null;
}

async function finalizeLiveRtcAttempt(
    input: FinalizeLiveRtcAttemptInput
): Promise<void> {
    const diagnostics = await captureLiveRtcAttemptFailureHealth(input);
    const errors = await closeLiveRtcAttemptResources(input);
    try {
        await input.control.attachRunSummary({ testInfo: input.testInfo, runId: input.runId });
    }
    catch (cause) {
        errors.push(toError(cause));
    }
    await attachLiveRtcCleanupErrors(input.testInfo, errors);
    const producerExitStatus = errors.length > 0 ? 1 : input.producerExitStatus;
    const attemptFailure = producerExitStatus === 0
        ? null
        : await input.control.captureAttemptFailure({ runId: input.runId });
    try {
        await writeAttemptEvidence({ ...input, diagnostics, producerExitStatus }, attemptFailure);
    }
    catch (cause) {
        if (input.producerExitStatus === 0) {
            throw cause;
        }
        console.error('Live RTC failed-attempt evidence output unavailable.');
    }
    if (errors.length > 0 && input.producerExitStatus === 0) {
        throw new AggregateError(errors, 'Live RTC attempt cleanup failed.');
    }
}

async function captureLiveRtcAttemptFailureHealth(
    input: FinalizeLiveRtcAttemptInput
): Promise<readonly LiveRtcDiagnosticsCheckpoint[]> {
    if (input.producerExitStatus === 0 || input.agents.length === 0) {
        return input.diagnostics;
    }
    const label = `attempt-failure-later-health-${input.suffix}`;
    try {
        const captured = await input.control.captureDiagnostics({
            testInfo: input.testInfo,
            runId: input.runId,
            agents: input.agents,
            label,
            cycle: input.failureCycle
        });
        return [...input.diagnostics, captured.checkpoint];
    }
    catch {
        console.error('Live RTC attempt failure health capture unavailable.', {
            kind: 'attempt-failure-health-unavailable',
            cycle: input.failureCycle,
            message: 'A complete three-agent later health snapshot could not be collected.'
        });
        return input.diagnostics;
    }
}

async function closeLiveRtcAttemptResources(input: FinalizeLiveRtcAttemptInput): Promise<Error[]> {
    const commandResults = await Promise.allSettled(
        input.agents.map(async (agent) => {
            const result = await input.control.executeResult({
                runId: input.runId,
                agentId: agent.agentId,
                commandId: `best-effort-close-${agent.prefix.toLowerCase()}-${input.suffix}`,
                command: { kind: 'close' },
                timeoutMs: 15_000
            });
            if (!result.ok) {
                throw new Error(
                    `Cleanup close command failed for agent ${agent.agentId}.`
                );
            }
        })
    );
    const errors = commandResults.flatMap((result) => result.status === 'rejected' ? [toError(result.reason)] : []);
    errors.push(...(await closeLiveRtcBrowserAgentContexts(input.agents)));
    return errors;
}

async function retireLiveRtcAttemptAgents(
    input: RetireLiveRtcAttemptAgentsInput
): Promise<RetiredLiveRtcAttemptAgents> {
    const commandIds = input.sessions
        ? await liveRtcDeliveryOperations.closeAndResetSettledAgentTrio({
            control: input.control,
            runId: input.runId,
            agents: input.agents,
            sessions: input.sessions,
            suffix: input.suffix
        })
        : await liveRtcDeliveryOperations.closeAndResetAgents({
            control: input.control,
            runId: input.runId,
            agents: input.agents,
            suffix: input.suffix
        });
    const closeErrors = await closeLiveRtcBrowserAgentContexts(input.agents);
    if (closeErrors.length > 0) {
        throw new AggregateError(closeErrors, 'Failed to retire live RTC browser agents.');
    }
    const retiredAgentIds = new Set(input.agents.map((agent) => agent.agentId));
    return { commandIds, openHandles: input.openHandles.filter((agent) => !retiredAgentIds.has(agent.agentId)) };
}

async function attachLiveRtcCleanupErrors(testInfo: TestInfo, errors: readonly Error[]): Promise<void> {
    if (errors.length > 0) {
        for (const error of errors) {
            console.error('Live RTC attempt cleanup failed', error);
        }
        try {
            await testInfo.attach('live-rtc-cleanup-errors.json', {
                body: JSON.stringify(
                    errors.map((error) => ({ name: error.name, message: error.message }))
                ),
                contentType: 'application/json'
            });
        }
        catch (cause) {
            console.error(
                'Failed to attach live RTC cleanup diagnostics',
                toError(cause)
            );
        }
    }
}

async function writeAttemptEvidence(
    input: WriteAttemptEvidenceInput,
    attemptFailure: LiveRtcPerformanceRawEvidence['attemptFailure']
): Promise<void> {
    if (!input.context) {
        return;
    }
    const rawEvidence = toLiveRtcRawEvidence({
        ...input,
        context: input.context,
        attemptFailure
    });
    const attempt = buildLiveRtcExternalAttempt({
        locator: input.context.locator,
        sampleIdentity: input.context.sampleIdentity,
        producerExitStatus: input.producerExitStatus,
        runtimeObservation: input.context.runtimeObservation,
        rawEvidence
    });
    await writeLiveRtcPerformanceEvidence({
        repoRoot: input.context.repoRoot,
        baselineId: input.context.baselineId,
        relativePath: input.context.locator.rawResultRelativePath,
        evidence: attempt
    });
    await writeLiveRtcRetentionCohortIfComplete(input.context);
}

test.describe('full-stack live three-browser RTC matrix', () => {
    test.skip(
        !hasThreeAgentConfig,
        [
            'Set RALLAR_BLACK_BOX_FULL_STACK=1 and RALLAR_BLACK_BOX_LIVE_RTC_MATRIX=1,',
            'VITE_RALLAR_API_BASE_URL, VITE_RALLAR_ROOM_ID, and three agent credentials or restored sessions:',
            'VITE_RALLAR_AGENT_A_USERNAME/PASSWORD, VITE_RALLAR_AGENT_B_USERNAME/PASSWORD,',
            'and VITE_RALLAR_AGENT_C_USERNAME/PASSWORD.'
        ].join(' ')
    );

    test('proves direct, multicast, broadcast, NACK, stale-send, and artifact evidence with real data', async ({
        browser,
        request
    }, testInfo) => {
        test.setTimeout(360_000);

        const evidenceContext = await loadLiveRtcPerformanceAttempt({
            repoRoot: process.cwd(),
            environment: process.env
        });
        test.skip(
            evidenceContext !== null && evidenceContext.locator.caseId !== 'default',
            'The predeclared B06 attempt selects a different matrix case.'
        );
        const control = new LiveRtcControlClient({
            request,
            baseUrl: CONTROL_BASE_URL,
            monotonicNow: () => performance.now(),
            epochNow: () => Date.now(),
            diagnosticsOutDir: envValue('RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR')
        });

        const suffix = `live3-${Date.now()}-${crypto.randomUUID()}`;
        const runId = `rallar-live-three-browser-${suffix}`;
        const groupId = `${roomSeed}-${suffix}`;
        const allHandles: LiveRtcControlClient.Agent[] = [];
        let openHandles: LiveRtcControlClient.Agent[] = [];
        const commandIds: string[] = [];
        const timings: LiveRtcPerformanceTiming[] = [];
        const diagnostics: LiveRtcDiagnosticsCheckpoint[] = [];
        const failureDiagnostics: LiveRtcNackFailureDiagnostic[] = [];
        const scenarios: LiveRtcControlClient.DeliveryScenario[] = [];
        let producerExitStatus = 0;
        let matrixPassed = false;
        let artifactBundlePassed = false;
        let unexpectedDeliveryCount = 0;

        try {
            const realtimeAgents = await openAgentTrio(browser, { runId, groupId, suffix, label: 'live-realtime' });
            allHandles.push(...realtimeAgents);
            openHandles.push(...realtimeAgents);
            commandIds.push(
                ...(await liveRtcDeliveryOperations.setupGroupMembership({
                    control,
                    runId,
                    owner: realtimeAgents[0],
                    members: realtimeAgents,
                    groupId,
                    suffix
                }))
            );

            const realtime = await liveRtcDeliveryOperations.runDeliveryMatrix({
                control,
                runId,
                agents: realtimeAgents,
                transport: 'realtime',
                groupId,
                suffix
            });
            commandIds.push(...realtime.commandIds);
            timings.push(...realtime.timings);
            scenarios.push(...realtime.scenarios);
            const clusterOrigins = readLiveRtcClusterApiOrigins();
            if (clusterOrigins) {
                const cluster = await exchangeClusterDirectMessages({
                    control,
                    runId,
                    agents: realtimeAgents,
                    sessions: realtime.sessions,
                    groupId,
                    suffix
                });
                commandIds.push(...cluster.commandIds);
                scenarios.push(...cluster.scenarios);
            }
            const realtimeDiagnostics = await control.captureDiagnostics({
                testInfo,
                runId,
                agents: realtimeAgents,
                label: `realtime-${suffix}`,
                cycle: null
            });
            commandIds.push(...realtimeDiagnostics.commandIds);
            diagnostics.push(realtimeDiagnostics.checkpoint);
            const retiredRealtimeAgents = await retireLiveRtcAttemptAgents({
                control,
                runId,
                agents: realtimeAgents,
                openHandles,
                suffix: `${suffix}-after-realtime`,
                sessions: realtime.sessions
            });
            openHandles = retiredRealtimeAgents.openHandles;
            commandIds.push(...retiredRealtimeAgents.commandIds);

            const messageAgents = await openAgentTrio(browser, { runId, groupId, suffix, label: 'live-messages' });
            allHandles.push(...messageAgents);
            openHandles.push(...messageAgents);
            const messages = await liveRtcDeliveryOperations.runDeliveryMatrix({
                control,
                runId,
                agents: messageAgents,
                transport: 'messages.rtc',
                groupId,
                suffix
            });
            commandIds.push(...messages.commandIds);
            timings.push(...messages.timings);
            scenarios.push(...messages.scenarios);
            commandIds.push(
                await liveRtcDeliveryOperations.runNackProbe({
                    testInfo,
                    senderSessionId: messages.sessions.A,
                    control,
                    runId,
                    agent: messageAgents[0],
                    groupId,
                    suffix,
                    targetAgentId: messageAgents[1].agentId,
                    targetSessionId: messages.sessions.B
                })
            );
            const messageDiagnostics = await control.captureDiagnostics({
                testInfo,
                runId,
                agents: messageAgents,
                label: `messages-rtc-${suffix}`,
                cycle: null
            });
            commandIds.push(...messageDiagnostics.commandIds);
            diagnostics.push(messageDiagnostics.checkpoint);
            commandIds.push(
                ...(await liveRtcDeliveryOperations.expectClosedTransportFailure({
                    control,
                    runId,
                    agent: messageAgents[2],
                    groupId,
                    suffix,
                    targetSessionId: messages.sessions.B
                }))
            );
            commandIds.push(
                ...(await liveRtcDeliveryOperations.closeAndResetAgents({
                    control,
                    runId,
                    agents: [messageAgents[0], messageAgents[1]],
                    suffix: `${suffix}-final`
                }))
            );

            unexpectedDeliveryCount = await control.unexpectedDeliveryCount({
                runId,
                scenarios
            });
            expect(unexpectedDeliveryCount).toBe(0);
            await control.expectArtifactBundle({ runId, commandIds });
            artifactBundlePassed = true;

            await expect
                .poll(
                    async () => {
                        const run = await control.fetchRun(runId);
                        const resultIds = new Set(
                            (run.results ?? [])
                                .filter((result) => result.ok === true)
                                .map((result) => result.commandId)
                        );
                        const topics = control.runtimeTopics(run);
                        return {
                            agents: (run.agents ?? []).filter((agent) =>
                                allHandles.some((handle) =>
                                    handle.agentId === agent.agentId
                                )
                            ).length,
                            keyCommandsComplete: commandIds
                                .filter((commandId) => !commandId.startsWith('stale-send-'))
                                .filter(
                                    (commandId) => !commandId.startsWith('close-before-stale-send-')
                                )
                                .filter(
                                    (commandId) => !commandId.startsWith('nack-not-yet-in-sync-')
                                )
                                .every((commandId) => resultIds.has(commandId)),
                            fakeTopicCount: topics.filter((topic) => topic.startsWith('rallar.bb.fake.')).length
                        };
                    },
                    {
                        timeout: 20_000
                    }
                )
                .toEqual({
                    agents: allHandles.length,
                    keyCommandsComplete: true,
                    fakeTopicCount: 0
                });
            matrixPassed = true;
        }
        catch (error) {
            producerExitStatus = 1;
            if (error instanceof LiveRtcNackProbeFailure) {
                failureDiagnostics.push(error.diagnostic);
            }
            throw toError(error);
        }
        finally {
            await finalizeLiveRtcAttempt({
                control,
                testInfo,
                runId,
                agents: openHandles,
                suffix,
                failureCycle: null,
                context: evidenceContext,
                producerExitStatus,
                timings,
                diagnostics,
                failureDiagnostics,
                retention: null,
                assertions: {
                    matrixPassed,
                    artifactBundlePassed,
                    unexpectedDeliveryCount,
                    reconnectPassed: null
                }
            });
        }
    });

    test('runs every three-browser live sender and receiver scenario', async ({
        browser,
        request
    }, testInfo) => {
        test.skip(
            !liveAllScenariosEnabled,
            'Set RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=1 to run the exhaustive three-browser live matrix.'
        );
        test.setTimeout(720_000);

        const evidenceContext = await loadLiveRtcPerformanceAttempt({
            repoRoot: process.cwd(),
            environment: process.env
        });
        test.skip(
            evidenceContext !== null &&
                evidenceContext.locator.caseId !== 'all-scenarios',
            'The predeclared B06 attempt selects a different matrix case.'
        );
        const control = new LiveRtcControlClient({
            request,
            baseUrl: CONTROL_BASE_URL,
            monotonicNow: () => performance.now(),
            epochNow: () => Date.now(),
            diagnosticsOutDir: envValue('RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR')
        });
        const suffix = `live3-all-${Date.now()}-${crypto.randomUUID()}`;
        const runId = `rallar-live-three-browser-all-${suffix}`;
        const groupId = `${roomSeed}-${suffix}`;
        const allHandles: LiveRtcControlClient.Agent[] = [];
        let openHandles: LiveRtcControlClient.Agent[] = [];
        const commandIds: string[] = [];
        const scenarios: LiveRtcControlClient.DeliveryScenario[] = [];
        const timings: LiveRtcPerformanceTiming[] = [];
        const diagnostics: LiveRtcDiagnosticsCheckpoint[] = [];
        const failureDiagnostics: LiveRtcNackFailureDiagnostic[] = [];
        let producerExitStatus = 0;
        let matrixPassed = false;
        let artifactBundlePassed = false;
        let reconnectPassed = false;
        let unexpectedDeliveryCount = 0;

        try {
            const realtimeAgents = await openAgentTrio(browser, { runId, groupId, suffix, label: 'live-all-realtime' });
            allHandles.push(...realtimeAgents);
            openHandles.push(...realtimeAgents);
            commandIds.push(
                ...(await liveRtcDeliveryOperations.setupGroupMembership({
                    control,
                    runId,
                    owner: realtimeAgents[0],
                    members: realtimeAgents,
                    groupId,
                    suffix
                }))
            );
            commandIds.push(
                ...(await verifyGroupStateReadback({
                    control,
                    runId,
                    owner: realtimeAgents[0],
                    groupId,
                    suffix
                }))
            );
            const realtime = await liveRtcDeliveryOperations.runAllDeliveryPermutations({
                control,
                runId,
                agents: realtimeAgents,
                transport: 'realtime',
                groupId,
                suffix
            });
            commandIds.push(...realtime.commandIds);
            scenarios.push(...realtime.scenarios);
            timings.push(...realtime.timings);
            const realtimeDiagnostics = await control.captureDiagnostics({
                testInfo,
                runId,
                agents: realtimeAgents,
                label: `all-realtime-${suffix}`,
                cycle: null
            });
            commandIds.push(...realtimeDiagnostics.commandIds);
            diagnostics.push(realtimeDiagnostics.checkpoint);
            const retiredRealtimeAgents = await retireLiveRtcAttemptAgents({
                control,
                runId,
                agents: realtimeAgents,
                openHandles,
                suffix: `${suffix}-after-realtime-all`,
                sessions: realtime.sessions
            });
            openHandles = retiredRealtimeAgents.openHandles;
            commandIds.push(...retiredRealtimeAgents.commandIds);

            const wsAgents = await openAgentTrio(browser, { runId, groupId, suffix, label: 'live-all-ws' });
            allHandles.push(...wsAgents);
            openHandles.push(...wsAgents);
            commandIds.push(
                ...(await liveRtcDeliveryOperations.runWebSocketOpenSendCloseMatrix({
                    control,
                    runId,
                    agents: wsAgents,
                    groupId,
                    suffix
                }))
            );
            const retiredWsAgents = await retireLiveRtcAttemptAgents({
                control,
                runId,
                agents: wsAgents,
                openHandles,
                suffix: `${suffix}-after-ws-all`,
                sessions: undefined
            });
            openHandles = retiredWsAgents.openHandles;
            commandIds.push(...retiredWsAgents.commandIds);

            const messageAgents = await openAgentTrio(browser, { runId, groupId, suffix, label: 'live-all-messages' });
            allHandles.push(...messageAgents);
            openHandles.push(...messageAgents);
            const messages = await liveRtcDeliveryOperations.runAllDeliveryPermutations({
                control,
                runId,
                agents: messageAgents,
                transport: 'messages.rtc',
                groupId,
                suffix
            });
            commandIds.push(...messages.commandIds);
            scenarios.push(...messages.scenarios);
            timings.push(...messages.timings);
            commandIds.push(
                await liveRtcDeliveryOperations.runNackProbe({
                    testInfo,
                    senderSessionId: messages.sessions.A,
                    control,
                    runId,
                    agent: messageAgents[0],
                    groupId,
                    suffix,
                    targetAgentId: messageAgents[1].agentId,
                    targetSessionId: messages.sessions.B
                })
            );
            commandIds.push(
                ...(await liveRtcDeliveryOperations.expectClosedTransportFailure({
                    control,
                    runId,
                    agent: messageAgents[2],
                    groupId,
                    suffix,
                    targetSessionId: messages.sessions.B
                }))
            );
            await Promise.all(
                messageAgents.slice(0, 2).map((agent) =>
                    control.waitForPeerAbsence({
                        runId,
                        agent,
                        departedPeerIds: [messages.sessions.C],
                        suffix: `${suffix}-reconnect-c`
                    })
                )
            );
            const reconnectC = await liveRtcDeliveryOperations.reconnectAndWaitForPeerReadiness({
                control,
                runId,
                reconnectingAgent: messageAgents[2],
                survivingAgents: [messageAgents[0], messageAgents[1]],
                survivingSessionIds: [messages.sessions.A, messages.sessions.B],
                transport: 'messages.rtc',
                groupId,
                suffix: `${suffix}-reconnect-c`
            });
            commandIds.push(reconnectC.commandId);
            timings.push({
                kind: 'reconnect-ready',
                transport: 'messages.rtc',
                senderAgentId: messageAgents[2].agentId,
                receiverAgentIds: [messageAgents[0].agentId, messageAgents[1].agentId],
                durationMs: reconnectC.receiverReadinessDurationMs
            });
            const reconnectMatrixId = `messages-rtc-reconnect-b-to-c-${suffix}`;
            const reconnectMessageStartedAtMs = performance.now();
            commandIds.push(
                await liveRtcDeliveryOperations.sendMatrixPayload({
                    control,
                    runId,
                    sender: messageAgents[1],
                    transport: 'messages.rtc',
                    groupId,
                    suffix,
                    deliveryMode: 'direct',
                    targetSessionIds: [reconnectC.sessionId],
                    matrixId: reconnectMatrixId
                })
            );
            await control.waitForMessage({
                runId,
                senderAgentId: messageAgents[1].agentId,
                agentId: messageAgents[2].agentId,
                transport: 'messages.rtc',
                matrixId: reconnectMatrixId,
                deliveryMode: 'direct',
                startedAtMs: reconnectMessageStartedAtMs
            });
            reconnectPassed = true;
            const messageDiagnostics = await control.captureDiagnostics({
                testInfo,
                runId,
                agents: messageAgents,
                label: `all-messages-${suffix}`,
                cycle: null
            });
            commandIds.push(...messageDiagnostics.commandIds);
            diagnostics.push(messageDiagnostics.checkpoint);
            commandIds.push(
                ...(await liveRtcDeliveryOperations.closeAndResetAgents({
                    control,
                    runId,
                    agents: messageAgents,
                    suffix: `${suffix}-final-all`
                }))
            );
            unexpectedDeliveryCount = await control.unexpectedDeliveryCount({
                runId,
                scenarios
            });
            expect(unexpectedDeliveryCount).toBe(0);
            await control.expectArtifactBundle({ runId, commandIds });
            artifactBundlePassed = true;

            await expect
                .poll(
                    async () => {
                        const run = await control.fetchRun(runId);
                        const resultIds = new Set(
                            (run.results ?? [])
                                .filter((result) => result.ok === true)
                                .map((result) => result.commandId)
                        );
                        return {
                            agents: (run.agents ?? []).filter((agent) =>
                                allHandles.some((handle) =>
                                    handle.agentId === agent.agentId
                                )
                            ).length,
                            keyCommandsComplete: commandIds
                                .filter((commandId) => !commandId.startsWith('stale-send-'))
                                .filter(
                                    (commandId) => !commandId.startsWith('close-before-stale-send-')
                                )
                                .filter(
                                    (commandId) => !commandId.startsWith('nack-not-yet-in-sync-')
                                )
                                .every((commandId) => resultIds.has(commandId)),
                            fakeTopicCount: control
                                .runtimeTopics(run)
                                .filter((topic) => topic.startsWith('rallar.bb.fake.')).length,
                            scenarioCount: scenarios.length
                        };
                    },
                    { timeout: 20_000 }
                )
                .toEqual({
                    agents: allHandles.length,
                    keyCommandsComplete: true,
                    fakeTopicCount: 0,
                    scenarioCount: 24
                });
            matrixPassed = true;
        }
        catch (error) {
            producerExitStatus = 1;
            if (error instanceof LiveRtcNackProbeFailure) {
                failureDiagnostics.push(error.diagnostic);
            }
            throw toError(error);
        }
        finally {
            await finalizeLiveRtcAttempt({
                control,
                testInfo,
                runId,
                agents: openHandles,
                suffix,
                failureCycle: null,
                context: evidenceContext,
                producerExitStatus,
                timings,
                diagnostics,
                failureDiagnostics,
                retention: null,
                assertions: {
                    matrixPassed,
                    artifactBundlePassed,
                    unexpectedDeliveryCount,
                    reconnectPassed
                }
            });
        }
    });

    test('returns RTC state and post-GC heap to baseline after 100 reconnect cycles', async ({
        browser,
        request
    }, testInfo) => {
        test.skip(
            !liveRetentionSoakEnabled,
            'Set RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK=1 and RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES=100 to run retention evidence.'
        );
        test.setTimeout(1_800_000);

        const evidenceContext = await loadLiveRtcPerformanceAttempt({
            repoRoot: process.cwd(),
            environment: process.env
        });
        test.skip(
            evidenceContext !== null &&
                evidenceContext.locator.caseId !== 'retention-100',
            'The predeclared B06 attempt selects a different matrix case.'
        );
        const control = new LiveRtcControlClient({
            request,
            baseUrl: CONTROL_BASE_URL,
            monotonicNow: () => performance.now(),
            epochNow: () => Date.now(),
            diagnosticsOutDir: envValue('RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR')
        });
        const suffix = `live3-retention-${Date.now()}-${crypto.randomUUID()}`;
        const runId = `rallar-live-three-browser-retention-${suffix}`;
        const groupId = `${roomSeed}-${suffix}`;
        const commandIds: string[] = [];
        const timings: LiveRtcPerformanceTiming[] = [];
        const diagnostics: LiveRtcDiagnosticsCheckpoint[] = [];
        const failureDiagnostics: LiveRtcNackFailureDiagnostic[] = [];
        const checkpoints: LiveRtcRetentionCheckpoint[] = [];
        let currentRetentionCycle = 0;
        const openHandles: LiveRtcControlClient.Agent[] = [];
        let producerExitStatus = 0;
        let matrixPassed = false;
        let artifactBundlePassed = false;
        let reconnectPassed = false;
        const unexpectedDeliveryCount = 0;

        const captureCheckpoint = async (
            agents: LiveRtcAgentTrio,
            cycle: number
        ): Promise<void> => {
            const captured = await control.captureDiagnostics({
                testInfo,
                runId,
                agents,
                label: `retention-${cycle}-${suffix}`,
                cycle
            });
            commandIds.push(...captured.commandIds);
            diagnostics.push(captured.checkpoint);
            checkpoints.push({
                cycle,
                postGcHeapBytes: await captureLiveRtcPostGcHeap(
                    agents.map((agent) => agent.page)
                ),
                agents: captured.checkpoint.agents
            });
        };
        const runRetentionPhase = async <Result>(
            phaseName: string,
            operation: () => Promise<Result>
        ): Promise<Result> => {
            console.info(
                `[retention-100] phase-start ${new Date().toISOString()} ${phaseName}`
            );
            return test.step(phaseName, operation);
        };

        try {
            const agents = await runRetentionPhase(
                'retention-100: open the three browser agents',
                async () => {
                    const openedAgents = await openAgentTrio(browser, {
                        runId,
                        groupId,
                        suffix,
                        label: 'live-retention'
                    });
                    openHandles.push(...openedAgents);
                    return openedAgents;
                }
            );
            await runRetentionPhase(
                'retention-100: establish group membership',
                async () => {
                    commandIds.push(
                        ...(await liveRtcDeliveryOperations.setupGroupMembership({
                            control,
                            runId,
                            owner: agents[0],
                            members: agents,
                            groupId,
                            suffix
                        }))
                    );
                }
            );
            const initialFormation = await runRetentionPhase(
                'retention-100: form the initial group and wait for readiness',
                async () => {
                    const formation = await liveRtcDeliveryOperations.runGroupFormation({
                        control,
                        runId,
                        agents,
                        transport: 'messages.rtc',
                        groupId,
                        suffix: `${suffix}-initial`,
                        readinessScope: 'all'
                    });
                    commandIds.push(...formation.commandIds);
                    return formation;
                }
            );
            await runRetentionPhase(
                'retention-100: capture initial checkpoint at cycle 0',
                async () => captureCheckpoint(agents, 0)
            );

            let currentSessionId = initialFormation.sessions.C;
            for (let cycle = 1; cycle <= 100; cycle += 1) {
                currentRetentionCycle = cycle;
                const closeCommandId = `retention-close-c-${cycle}-${suffix}`;
                await runRetentionPhase(
                    `retention-100 cycle ${cycle}: close peer C`,
                    async () => {
                        await control.executeOk({
                            runId,
                            agentId: agents[2].agentId,
                            commandId: closeCommandId,
                            command: { kind: 'close' },
                            timeoutMs: 45_000
                        });
                        commandIds.push(closeCommandId);
                    }
                );
                await runRetentionPhase(
                    `retention-100 cycle ${cycle}: wait for both surviving peers to observe absence`,
                    async () => {
                        await Promise.all(
                            agents.slice(0, 2).map((agent) =>
                                control.waitForPeerAbsence({
                                    runId,
                                    agent,
                                    departedPeerIds: [currentSessionId],
                                    suffix: `${suffix}-${cycle}`
                                })
                            )
                        );
                    }
                );
                await runRetentionPhase(
                    `retention-100 cycle ${cycle}: reconnect peer C and wait for readiness`,
                    async () => {
                        const reconnected = await liveRtcDeliveryOperations.reconnectAndWaitForPeerReadiness({
                            control,
                            runId,
                            reconnectingAgent: agents[2],
                            survivingAgents: [agents[0], agents[1]],
                            survivingSessionIds: [
                                initialFormation.sessions.A,
                                initialFormation.sessions.B
                            ],
                            transport: 'messages.rtc',
                            groupId,
                            suffix: `${suffix}-${cycle}`
                        });
                        commandIds.push(reconnected.commandId);
                        timings.push({
                            kind: 'reconnect-ready',
                            transport: 'messages.rtc',
                            senderAgentId: agents[2].agentId,
                            receiverAgentIds: [agents[0].agentId, agents[1].agentId],
                            durationMs: reconnected.receiverReadinessDurationMs
                        });
                        currentSessionId = reconnected.sessionId;
                    }
                );
                if (cycle % 10 === 0) {
                    await runRetentionPhase(
                        `retention-100 cycle ${cycle}: capture every-tenth checkpoint`,
                        async () => captureCheckpoint(agents, cycle)
                    );
                }
            }
            reconnectPassed = true;
            matrixPassed = true;
            await runRetentionPhase(
                'retention-100: close and reset all agents after cycle 100',
                async () => {
                    commandIds.push(
                        ...(await liveRtcDeliveryOperations.closeAndResetAgents({
                            control,
                            runId,
                            agents,
                            suffix: `${suffix}-final`
                        }))
                    );
                }
            );
            await runRetentionPhase(
                'retention-100: assert the final artifact bundle',
                async () => {
                    await control.expectArtifactBundle({ runId, commandIds });
                    artifactBundlePassed = true;
                }
            );
        }
        catch (error) {
            producerExitStatus = 1;
            if (error instanceof LiveRtcNackProbeFailure) {
                failureDiagnostics.push(error.diagnostic);
            }
            throw toError(error);
        }
        finally {
            await runRetentionPhase(
                'retention-100: finalize attempt diagnostics and evidence',
                async () => {
                    await finalizeLiveRtcAttempt({
                        control,
                        testInfo,
                        runId,
                        agents: openHandles,
                        suffix,
                        failureCycle: currentRetentionCycle,
                        context: evidenceContext,
                        producerExitStatus,
                        timings,
                        diagnostics,
                        failureDiagnostics,
                        retention: {
                            cycles: 100,
                            checkpoints,
                            settledStateReturned: liveRtcRetentionStateReturned(checkpoints)
                        },
                        assertions: {
                            matrixPassed,
                            artifactBundlePassed,
                            unexpectedDeliveryCount,
                            reconnectPassed
                        }
                    });
                }
            );
        }
    });
});

interface LiveRtcEvidenceInput extends WriteAttemptEvidenceInput {
    readonly context: LiveRtcPerformanceAttemptContext;
    readonly attemptFailure: LiveRtcPerformanceRawEvidence['attemptFailure'];
}

function toLiveRtcRawEvidence(
    input: LiveRtcEvidenceInput
): LiveRtcPerformanceRawEvidence {
    const environmentId = input.context.locator.environmentId;
    const e4 = environmentId === 'E4-pg';
    return {
        identity: {
            workloadId: 'RTC-B06',
            caseId: input.context.locator.caseId,
            inputKey: input.context.locator.inputKey,
            intendedPhase: input.context.locator.intendedPhase,
            outerOrdinal: input.context.locator.outerOrdinal,
            environmentId
        },
        producer: {
            provider: 'browser-rallar',
            browserCount: 3,
            auth: {
                A: agentAuth('A').kind,
                B: agentAuth('B').kind,
                C: agentAuth('C').kind
            },
            databaseProvider: e4 ? 'postgres' : 'memory',
            databaseUrl: envValue('DATABASE_URL') ? 'present' : 'absent',
            iceMode: e4 ? 'local' : 'repository-default',
            allScenariosRaw: rawEnvironmentValue(
                'RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS'
            ),
            retentionSoakRaw: rawEnvironmentValue(
                'RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK'
            ),
            retentionCyclesRaw: rawEnvironmentValue(
                'RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES'
            ),
            iceModeRaw: rawEnvironmentValue('RALLAR_ICE_MODE'),
            transports: ['realtime', 'messages.rtc']
        },
        runtime: {
            node: input.context.runtimeObservation.runtime.node,
            playwright: input.context.runtimeObservation.runtime.playwright,
            chromium: input.context.runtimeObservation.runtime.chromium
        },
        timings: input.timings,
        diagnostics: input.diagnostics,
        failureDiagnostics: input.failureDiagnostics,
        attemptFailure: input.attemptFailure,
        retention: input.retention,
        assertions: input.assertions
    };
}

interface ExchangeClusterDirectMessagesInput {
    readonly control: LiveRtcControlClient;
    readonly runId: string;
    readonly agents: LiveRtcAgentTrio;
    readonly sessions: Readonly<Record<AgentPrefix, string>>;
    readonly groupId: string;
    readonly suffix: string;
}

interface ClusterDirectMessage {
    readonly commandId: string;
    readonly scenario: LiveRtcControlClient.DeliveryScenario;
}

interface ClusterDirectMessageExchange {
    readonly commandIds: readonly string[];
    readonly scenarios: readonly LiveRtcControlClient.DeliveryScenario[];
}

async function exchangeClusterDirectMessages(
    input: ExchangeClusterDirectMessagesInput
): Promise<ClusterDirectMessageExchange> {
    await waitForClusterPeerReadiness(input);
    const sent: ClusterDirectMessage[] = [];
    for (const sender of input.agents) {
        for (
            const receiver of input.agents.filter((agent) => agent.agentId !== sender.agentId)
        ) {
            sent.push(await sendClusterDirectMessage(input, sender, receiver));
        }
    }
    return {
        commandIds: sent.map((message) => message.commandId),
        scenarios: sent.map((message) => message.scenario)
    };
}

async function waitForClusterPeerReadiness(
    input: ExchangeClusterDirectMessagesInput
): Promise<void> {
    for (const agent of input.agents) {
        await input.control.waitForPeerReadiness({
            runId: input.runId,
            agent,
            expectedPeerIds: input.agents
                .filter((peer) => peer.agentId !== agent.agentId)
                .map((peer) => input.sessions[peer.prefix]),
            suffix: `cluster-${agent.prefix.toLowerCase()}-${input.suffix}`,
            startedAtMs: performance.now()
        });
    }
}

async function sendClusterDirectMessage(
    input: ExchangeClusterDirectMessagesInput,
    sender: LiveRtcControlClient.Agent,
    receiver: LiveRtcControlClient.Agent
): Promise<ClusterDirectMessage> {
    const matrixId =
        `cluster-direct-${sender.prefix.toLowerCase()}-to-${receiver.prefix.toLowerCase()}-${input.suffix}`;
    const startedAtMs = performance.now();
    const [commandId] = await Promise.all([
        liveRtcDeliveryOperations.sendMatrixPayload({
            control: input.control,
            runId: input.runId,
            sender,
            transport: 'realtime',
            groupId: input.groupId,
            suffix: input.suffix,
            deliveryMode: 'direct',
            targetSessionIds: [input.sessions[receiver.prefix]],
            matrixId
        }),
        input.control.waitForMessage({
            runId: input.runId,
            senderAgentId: sender.agentId,
            agentId: receiver.agentId,
            transport: 'realtime',
            matrixId,
            deliveryMode: 'direct',
            possibleReceiverAgentIds: [receiver.agentId],
            startedAtMs
        })
    ]);
    const scenario: LiveRtcControlClient.DeliveryScenario = {
        matrixId,
        transport: 'realtime',
        deliveryMode: 'direct',
        senderAgentId: sender.agentId,
        expectedAgentIds: [receiver.agentId],
        allowedAgentIds: [receiver.agentId]
    };
    return { commandId, scenario };
}
