import {
    expect,
    test,
    type Browser,
    type TestInfo
} from '@playwright/test';
import { toError } from '@shared/resilience/to-error.ts';
import {
    closeLiveRtcBrowserAgentContexts,
    openLiveRtcBrowserAgent,
    type LiveRtcBrowserAgentAuth
} from './live-rtc-browser-agents.ts';
import { LiveRtcControlClient } from './live-rtc-control-client.ts';
import { createLiveRtcDeliveryOperations, type AgentPrefix } from './live-rtc-delivery-operations.ts';
import {
    buildLiveRtcExternalAttempt,
    captureLiveRtcPostGcHeap,
    liveRtcRetentionStateReturned,
    loadLiveRtcPerformanceAttempt,
    writeLiveRtcPerformanceEvidence,
    writeLiveRtcRetentionCohortIfComplete,
    type LiveRtcDiagnosticsCheckpoint,
    type LiveRtcPerformanceAttemptContext,
    type LiveRtcPerformanceRawEvidence,
    type LiveRtcPerformanceTiming,
    type LiveRtcRetentionCheckpoint
} from './live-rtc-performance-evidence.ts';

const SPA_BASE_URL = envValue('VITE_RALLAR_SPA_BASE_URL') ??
    'http://localhost:5176';
const CONTROL_BASE_URL = 'http://127.0.0.1:5180';
const CONTROL_WS_URL = 'ws://127.0.0.1:5180/control';

const apiBaseUrl = envValue('VITE_RALLAR_API_BASE_URL');
const roomSeed = firstEnvValue('VITE_RALLAR_ROOM_ID', 'VITE_RALLAR_GROUP_ID');
const applicationId = envValue('VITE_RALLAR_APPLICATION_ID') ?? 'ar-eye-hunter';
const workspaceId = envValue('VITE_RALLAR_WORKSPACE_ID') ?? 'default';
const messagesRtcTypeId = firstEnvValue(
    'VITE_RALLAR_MESSAGES_RTC_TYPE_ID',
    'VITE_RALLAR_TYPE_ID'
) ?? 'manual.type';
const messagesRtcTopicId = firstEnvValue(
    'VITE_RALLAR_MESSAGES_RTC_TOPIC_ID',
    'VITE_RALLAR_TOPIC_ID'
) ?? 'manual.topic';
const fullStackEnabled = booleanEnv('RALLAR_BLACK_BOX_FULL_STACK');
const liveMatrixEnabled = booleanEnv('RALLAR_BLACK_BOX_LIVE_RTC_MATRIX');
const liveAllScenariosEnabled = booleanEnv(
    'RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS'
);
const liveRetentionSoakEnabled = booleanEnv(
    'RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK'
);
const agentAAuth = resolveLiveRtcBrowserAgentAuth('A');
const agentBAuth = resolveLiveRtcBrowserAgentAuth('B');
const agentCAuth = resolveLiveRtcBrowserAgentAuth('C');
const hasThreeAgentConfig = Boolean(
    fullStackEnabled &&
        liveMatrixEnabled &&
        apiBaseUrl &&
        roomSeed &&
        agentAAuth &&
        agentBAuth &&
        agentCAuth
);
const liveRtcDeliveryOperations = createLiveRtcDeliveryOperations({
    apiBaseUrl,
    applicationId,
    workspaceId,
    messagesRtcTypeId,
    messagesRtcTopicId
});

function envValue(key: string): string | undefined {
    const value = process.env[key]?.trim();
    return value && value.length > 0 ? value : undefined;
}

function rawEnvironmentValue(key: string): string | null {
    return process.env[key] ?? null;
}

function firstEnvValue(...keys: readonly string[]): string | undefined {
    for (const key of keys) {
        const value = envValue(key);
        if (value) {
            return value;
        }
    }
    return undefined;
}

function booleanEnv(key: string): boolean {
    const normalized = envValue(key)?.toLowerCase();
    return normalized === '1' ||
        normalized === 'true' ||
        normalized === 'yes' ||
        normalized === 'on';
}

function numberEnv(key: string): number | undefined {
    const parsed = Number.parseInt(process.env[key] ?? '', 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveLiveRtcBrowserAgentAuth(prefix: AgentPrefix): LiveRtcBrowserAgentAuth | undefined {
    const genericUsername = prefix === 'A' ? ['VITE_RALLAR_USERNAME'] : [];
    const genericPassword = prefix === 'A' ? ['VITE_RALLAR_PASSWORD'] : [];
    const username = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_USERNAME`,
        `VITE_RALLAR_${prefix}_USERNAME`,
        ...genericUsername
    );
    const password = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_PASSWORD`,
        `VITE_RALLAR_${prefix}_PASSWORD`,
        ...genericPassword
    );
    if (username && password) {
        return {
            kind: 'login',
            username,
            password
        };
    }

    const restoreUsername = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_USERNAME`,
        `VITE_RALLAR_${prefix}_USERNAME`
    );
    const token = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_TOKEN`,
        `VITE_RALLAR_${prefix}_TOKEN`
    );
    const clientId = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_CLIENT_ID`,
        `VITE_RALLAR_${prefix}_CLIENT_ID`
    );
    const sessionId = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_SESSION_ID`,
        `VITE_RALLAR_${prefix}_SESSION_ID`
    );
    if (!restoreUsername || !token || !clientId || !sessionId) {
        return undefined;
    }

    return {
        kind: 'restore',
        session: {
            clientId,
            accessToken: token,
            username: restoreUsername,
            sessionId,
            expiresAtEpochMs: numberEnv(`VITE_RALLAR_AGENT_${prefix}_EXPIRES_AT_EPOCH_MS`) ??
                numberEnv(`VITE_RALLAR_${prefix}_EXPIRES_AT_EPOCH_MS`) ??
                Date.now() + 30 * 60 * 1000
        }
    };
}

function agentAuth(prefix: AgentPrefix): LiveRtcBrowserAgentAuth {
    const auth = prefix === 'A'
        ? agentAAuth
        : prefix === 'B'
        ? agentBAuth
        : agentCAuth;
    if (!auth) {
        throw new Error(`Missing auth for agent ${prefix}.`);
    }
    return auth;
}

function actorFor(prefix: AgentPrefix, suffix: string): string {
    return firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_ACTOR`,
        `VITE_RALLAR_${prefix}_ACTOR`
    ) ?? `agent-${prefix.toLowerCase()}-${suffix}`;
}

interface OpenAgentTrioInput {
    readonly runId: string;
    readonly groupId: string;
    readonly suffix: string;
    readonly label: string;
}

type LiveRtcAgentTrio = readonly [LiveRtcControlClient.Agent, LiveRtcControlClient.Agent, LiveRtcControlClient.Agent];

async function openAgentTrio(browser: Browser, input: OpenAgentTrioInput): Promise<LiveRtcAgentTrio> {
    const handles: LiveRtcControlClient.Agent[] = [];
    try {
        for (const prefix of ['A', 'B', 'C'] as const) {
            const agentName = `${input.label}-${prefix.toLowerCase()}-${input.suffix}`;
            handles.push(
                await openLiveRtcBrowserAgent(browser, {
                    config: {
                        spaBaseUrl: SPA_BASE_URL,
                        controlWsUrl: CONTROL_WS_URL,
                        apiBaseUrl: apiBaseUrl ?? '',
                        register: booleanEnv('VITE_RALLAR_REGISTER')
                    },
                    prefix,
                    auth: agentAuth(prefix),
                    runId: input.runId,
                    agentId: agentName,
                    actor: actorFor(prefix, input.suffix),
                    connection: agentName,
                    groupId: input.groupId
                })
            );
        }
        const [a, b, c] = handles;
        if (!a || !b || !c) {
            throw new Error('Three live RTC browser agents were not opened.');
        }
        return [a, b, c];
    }
    catch (error) {
        await closeLiveRtcBrowserAgentContexts(handles);
        throw toError(error);
    }
}

interface VerifyGroupStateReadbackInput {
    readonly control: LiveRtcControlClient;
    readonly runId: string;
    readonly owner: LiveRtcControlClient.Agent;
    readonly groupId: string;
    readonly suffix: string;
}

async function verifyGroupStateReadback(input: VerifyGroupStateReadbackInput): Promise<readonly string[]> {
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
                    encodeURIComponent(workspaceId)
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
                    encodeURIComponent(workspaceId)
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
    readonly retention: LiveRtcPerformanceRawEvidence['retention'];
    readonly assertions: LiveRtcPerformanceRawEvidence['assertions'];
}

interface FinalizeLiveRtcAttemptInput extends WriteAttemptEvidenceInput {
    readonly control: LiveRtcControlClient;
    readonly testInfo: TestInfo;
    readonly runId: string;
    readonly agents: readonly LiveRtcControlClient.Agent[];
    readonly suffix: string;
}

async function finalizeLiveRtcAttempt(input: FinalizeLiveRtcAttemptInput): Promise<void> {
    const commandResults = await Promise.allSettled(input.agents.map(async (agent) => {
        const result = await input.control.executeResult({
            runId: input.runId,
            agentId: agent.agentId,
            commandId: `best-effort-close-${agent.prefix.toLowerCase()}-${input.suffix}`,
            command: { kind: 'close' },
            timeoutMs: 15_000
        });
        if (!result.ok) {
            throw new Error(`Cleanup close command failed for agent ${agent.agentId}.`);
        }
    }));
    const errors = commandResults.flatMap((result) => result.status === 'rejected' ? [toError(result.reason)] : []);
    errors.push(...await closeLiveRtcBrowserAgentContexts(input.agents));
    try {
        await input.control.attachRunSummary({ testInfo: input.testInfo, runId: input.runId });
    }
    catch (cause) {
        errors.push(toError(cause));
    }
    if (errors.length > 0) {
        for (const error of errors) {
            console.error('Live RTC attempt cleanup failed', error);
        }
        try {
            await input.testInfo.attach('live-rtc-cleanup-errors.json', {
                body: JSON.stringify(errors.map((error) => ({ name: error.name, message: error.message }))),
                contentType: 'application/json'
            });
        }
        catch (cause) {
            console.error('Failed to attach live RTC cleanup diagnostics', toError(cause));
        }
    }
    await writeAttemptEvidence({ ...input, producerExitStatus: errors.length > 0 ? 1 : input.producerExitStatus });
    if (errors.length > 0 && input.producerExitStatus === 0) {
        throw new AggregateError(errors, 'Live RTC attempt cleanup failed.');
    }
}

async function writeAttemptEvidence(input: WriteAttemptEvidenceInput): Promise<void> {
    if (!input.context) {
        return;
    }
    const rawEvidence = toLiveRtcRawEvidence({ ...input, context: input.context });
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

    test(
        'proves direct, multicast, broadcast, NACK, stale-send, and artifact evidence with real data',
        async ({
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
                diagnosticsOutDir: envValue(
                    'RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR'
                )
            });

            const suffix = `live3-${Date.now()}-${crypto.randomUUID()}`;
            const runId = `rallar-live-three-browser-${suffix}`;
            const groupId = `${roomSeed}-${suffix}`;
            const allHandles: LiveRtcControlClient.Agent[] = [];
            const openHandles: LiveRtcControlClient.Agent[] = [];
            const commandIds: string[] = [];
            const timings: LiveRtcPerformanceTiming[] = [];
            const diagnostics: LiveRtcDiagnosticsCheckpoint[] = [];
            const scenarios: LiveRtcControlClient.DeliveryScenario[] = [];
            let producerExitStatus = 0;
            let matrixPassed = false;
            let artifactBundlePassed = false;
            let unexpectedDeliveryCount = 0;
            const openAgents = async (
                label: string
            ): Promise<
                readonly [
                    LiveRtcControlClient.Agent,
                    LiveRtcControlClient.Agent,
                    LiveRtcControlClient.Agent
                ]
            > => {
                const agents = await openAgentTrio(browser, {
                    runId,
                    groupId,
                    suffix,
                    label
                });
                allHandles.push(...agents);
                openHandles.push(...agents);
                return agents;
            };
            const retireAgents = async (
                agents: readonly [
                    LiveRtcControlClient.Agent,
                    LiveRtcControlClient.Agent,
                    LiveRtcControlClient.Agent
                ],
                closeSuffix: string,
                sessions?: Readonly<Record<AgentPrefix, string>>
            ): Promise<readonly string[]> => {
                const retiredCommandIds = sessions
                    ? await liveRtcDeliveryOperations.closeAndResetSettledAgentTrio({
                        control,
                        runId,
                        agents,
                        sessions,
                        suffix: closeSuffix
                    })
                    : await liveRtcDeliveryOperations.closeAndResetAgents({
                        control,
                        runId,
                        agents,
                        suffix: closeSuffix
                    });
                const closeErrors = await closeLiveRtcBrowserAgentContexts(agents);
                if (closeErrors.length > 0) {
                    throw new AggregateError(closeErrors, 'Failed to retire live RTC browser agents.');
                }
                for (const agent of agents) {
                    const index = openHandles.findIndex((candidate) => candidate.agentId === agent.agentId);
                    if (index >= 0) {
                        openHandles.splice(index, 1);
                    }
                }
                return retiredCommandIds;
            };

            try {
                const realtimeAgents = await openAgents('live-realtime');
                commandIds.push(
                    ...await liveRtcDeliveryOperations.setupGroupMembership({
                        control,
                        runId,
                        owner: realtimeAgents[0],
                        members: realtimeAgents,
                        groupId,
                        suffix
                    })
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
                const realtimeDiagnostics = await control.captureDiagnostics({
                    testInfo,
                    runId,
                    agents: realtimeAgents,
                    label: `realtime-${suffix}`,
                    cycle: null
                });
                commandIds.push(...realtimeDiagnostics.commandIds);
                diagnostics.push(realtimeDiagnostics.checkpoint);
                commandIds.push(
                    ...await retireAgents(
                        realtimeAgents,
                        `${suffix}-after-realtime`,
                        realtime.sessions
                    )
                );

                const messageAgents = await openAgents('live-messages');
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
                    ...await liveRtcDeliveryOperations.expectClosedTransportFailure({
                        control,
                        runId,
                        agent: messageAgents[2],
                        groupId,
                        suffix,
                        targetSessionId: messages.sessions.B
                    })
                );
                commandIds.push(
                    ...await liveRtcDeliveryOperations.closeAndResetAgents({
                        control,
                        runId,
                        agents: [messageAgents[0], messageAgents[1]],
                        suffix: `${suffix}-final`
                    })
                );

                unexpectedDeliveryCount = await control.unexpectedDeliveryCount({
                    runId,
                    scenarios
                });
                expect(unexpectedDeliveryCount).toBe(0);
                await control.expectArtifactBundle({ runId, commandIds });
                artifactBundlePassed = true;

                await expect.poll(async () => {
                    const run = await control.fetchRun(runId);
                    const resultIds = new Set(
                        (run.results ?? [])
                            .filter((result) => result.ok === true)
                            .map((result) => result.commandId)
                    );
                    const topics = control.runtimeTopics(run);
                    return {
                        agents: (run.agents ?? [])
                            .filter((agent) => allHandles.some((handle) => handle.agentId === agent.agentId))
                            .length,
                        keyCommandsComplete: commandIds
                            .filter((commandId) => !commandId.startsWith('stale-send-'))
                            .filter((commandId) => !commandId.startsWith('close-before-stale-send-'))
                            .filter((commandId) => !commandId.startsWith('nack-not-yet-in-sync-'))
                            .every((commandId) => resultIds.has(commandId)),
                        fakeTopicCount: topics.filter((topic) => topic.startsWith('rallar.bb.fake.')).length
                    };
                }, {
                    timeout: 20_000
                }).toEqual({
                    agents: allHandles.length,
                    keyCommandsComplete: true,
                    fakeTopicCount: 0
                });
                matrixPassed = true;
            }
            catch (error) {
                producerExitStatus = 1;
                throw toError(error);
            }
            finally {
                await finalizeLiveRtcAttempt({
                    control,
                    testInfo,
                    runId,
                    agents: openHandles,
                    suffix,
                    context: evidenceContext,
                    producerExitStatus,
                    timings,
                    diagnostics,
                    retention: null,
                    assertions: {
                        matrixPassed,
                        artifactBundlePassed,
                        unexpectedDeliveryCount,
                        reconnectPassed: null
                    }
                });
            }
        }
    );

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
        const openHandles: LiveRtcControlClient.Agent[] = [];
        const commandIds: string[] = [];
        const scenarios: LiveRtcControlClient.DeliveryScenario[] = [];
        const timings: LiveRtcPerformanceTiming[] = [];
        const diagnostics: LiveRtcDiagnosticsCheckpoint[] = [];
        let producerExitStatus = 0;
        let matrixPassed = false;
        let artifactBundlePassed = false;
        let reconnectPassed = false;
        let unexpectedDeliveryCount = 0;
        const openAgents = async (label: string) => {
            const agents = await openAgentTrio(browser, {
                runId,
                groupId,
                suffix,
                label
            });
            allHandles.push(...agents);
            openHandles.push(...agents);
            return agents;
        };
        const retireAgents = async (
            agents: readonly [
                LiveRtcControlClient.Agent,
                LiveRtcControlClient.Agent,
                LiveRtcControlClient.Agent
            ],
            closeSuffix: string,
            sessions?: Readonly<Record<AgentPrefix, string>>
        ): Promise<readonly string[]> => {
            const retired = sessions
                ? await liveRtcDeliveryOperations.closeAndResetSettledAgentTrio({
                    control,
                    runId,
                    agents,
                    sessions,
                    suffix: closeSuffix
                })
                : await liveRtcDeliveryOperations.closeAndResetAgents({
                    control,
                    runId,
                    agents,
                    suffix: closeSuffix
                });
            const closeErrors = await closeLiveRtcBrowserAgentContexts(agents);
            if (closeErrors.length > 0) {
                throw new AggregateError(closeErrors, 'Failed to retire live RTC browser agents.');
            }
            for (const agent of agents) {
                const index = openHandles.findIndex(
                    (candidate) => candidate.agentId === agent.agentId
                );
                if (index >= 0) {
                    openHandles.splice(index, 1);
                }
            }
            return retired;
        };

        try {
            const realtimeAgents = await openAgents('live-all-realtime');
            commandIds.push(
                ...await liveRtcDeliveryOperations.setupGroupMembership({
                    control,
                    runId,
                    owner: realtimeAgents[0],
                    members: realtimeAgents,
                    groupId,
                    suffix
                })
            );
            commandIds.push(
                ...await verifyGroupStateReadback({
                    control,
                    runId,
                    owner: realtimeAgents[0],
                    groupId,
                    suffix
                })
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
            commandIds.push(
                ...await retireAgents(
                    realtimeAgents,
                    `${suffix}-after-realtime-all`,
                    realtime.sessions
                )
            );

            const wsAgents = await openAgents('live-all-ws');
            commandIds.push(
                ...await liveRtcDeliveryOperations.runWebSocketOpenSendCloseMatrix({
                    control,
                    runId,
                    agents: wsAgents,
                    groupId,
                    suffix
                })
            );
            commandIds.push(...await retireAgents(wsAgents, `${suffix}-after-ws-all`));

            const messageAgents = await openAgents('live-all-messages');
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
                    targetSessionId: messages.sessions.B
                })
            );
            commandIds.push(
                ...await liveRtcDeliveryOperations.expectClosedTransportFailure({
                    control,
                    runId,
                    agent: messageAgents[2],
                    groupId,
                    suffix,
                    targetSessionId: messages.sessions.B
                })
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
                receiverAgentIds: [
                    messageAgents[0].agentId,
                    messageAgents[1].agentId
                ],
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
                ...await liveRtcDeliveryOperations.closeAndResetAgents({
                    control,
                    runId,
                    agents: messageAgents,
                    suffix: `${suffix}-final-all`
                })
            );
            unexpectedDeliveryCount = await control.unexpectedDeliveryCount({
                runId,
                scenarios
            });
            expect(unexpectedDeliveryCount).toBe(0);
            await control.expectArtifactBundle({ runId, commandIds });
            artifactBundlePassed = true;

            await expect.poll(async () => {
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
                        .filter((commandId) => !commandId.startsWith('close-before-stale-send-'))
                        .filter((commandId) => !commandId.startsWith('nack-not-yet-in-sync-'))
                        .every((commandId) => resultIds.has(commandId)),
                    fakeTopicCount: control.runtimeTopics(run)
                        .filter((topic) => topic.startsWith('rallar.bb.fake.')).length,
                    scenarioCount: scenarios.length
                };
            }, { timeout: 20_000 }).toEqual({
                agents: allHandles.length,
                keyCommandsComplete: true,
                fakeTopicCount: 0,
                scenarioCount: 24
            });
            matrixPassed = true;
        }
        catch (error) {
            producerExitStatus = 1;
            throw toError(error);
        }
        finally {
            await finalizeLiveRtcAttempt({
                control,
                testInfo,
                runId,
                agents: openHandles,
                suffix,
                context: evidenceContext,
                producerExitStatus,
                timings,
                diagnostics,
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
        const checkpoints: LiveRtcRetentionCheckpoint[] = [];
        const openHandles: LiveRtcControlClient.Agent[] = [];
        let producerExitStatus = 0;
        let matrixPassed = false;
        let artifactBundlePassed = false;
        let reconnectPassed = false;
        const unexpectedDeliveryCount = 0;

        const captureCheckpoint = async (agents: LiveRtcAgentTrio, cycle: number): Promise<void> => {
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

        try {
            const agents = await openAgentTrio(browser, {
                runId,
                groupId,
                suffix,
                label: 'live-retention'
            });
            openHandles.push(...agents);
            commandIds.push(
                ...await liveRtcDeliveryOperations.setupGroupMembership({
                    control,
                    runId,
                    owner: agents[0],
                    members: agents,
                    groupId,
                    suffix
                })
            );
            const initialFormation = await liveRtcDeliveryOperations.runGroupFormation({
                control,
                runId,
                agents,
                transport: 'messages.rtc',
                groupId,
                suffix: `${suffix}-initial`,
                readinessScope: 'all'
            });
            commandIds.push(...initialFormation.commandIds);
            await captureCheckpoint(agents, 0);

            let currentSessionId = initialFormation.sessions.C;
            for (let cycle = 1; cycle <= 100; cycle += 1) {
                const closeCommandId = `retention-close-c-${cycle}-${suffix}`;
                await control.executeOk({
                    runId,
                    agentId: agents[2].agentId,
                    commandId: closeCommandId,
                    command: { kind: 'close' },
                    timeoutMs: 45_000
                });
                commandIds.push(closeCommandId);
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
                if (cycle % 10 === 0) {
                    await captureCheckpoint(agents, cycle);
                }
            }
            reconnectPassed = true;
            matrixPassed = true;
            commandIds.push(
                ...await liveRtcDeliveryOperations.closeAndResetAgents({
                    control,
                    runId,
                    agents,
                    suffix: `${suffix}-final`
                })
            );
            await control.expectArtifactBundle({ runId, commandIds });
            artifactBundlePassed = true;
        }
        catch (error) {
            producerExitStatus = 1;
            throw toError(error);
        }
        finally {
            await finalizeLiveRtcAttempt({
                control,
                testInfo,
                runId,
                agents: openHandles,
                suffix,
                context: evidenceContext,
                producerExitStatus,
                timings,
                diagnostics,
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
    });
});

interface LiveRtcEvidenceInput extends WriteAttemptEvidenceInput {
    readonly context: LiveRtcPerformanceAttemptContext;
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
            allScenariosRaw: rawEnvironmentValue('RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS'),
            retentionSoakRaw: rawEnvironmentValue('RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK'),
            retentionCyclesRaw: rawEnvironmentValue('RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES'),
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
        retention: input.retention,
        assertions: input.assertions
    };
}
