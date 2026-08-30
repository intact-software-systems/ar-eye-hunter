import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { openTab } from './full-stack-helpers.ts';
import {
    createLiveRtcDeliveryOperations,
    type AgentPrefix,
    type TransportUnderTest
} from './live-rtc-delivery-operations.ts';
import {
    buildLiveRtcExternalAttempt,
    captureLiveRtcPostGcHeap,
    LiveRtcControlClient,
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

type RestoredSession = Readonly<{
    clientId: string;
    accessToken: string;
    username: string;
    sessionId: string;
    expiresAtEpochMs: number;
}>;

type AgentAuth =
    | Readonly<{
        kind: 'login';
        username: string;
        password: string;
    }>
    | Readonly<{
        kind: 'restore';
        session: RestoredSession;
    }>;

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
const agentAAuth = resolveAgentAuth('A');
const agentBAuth = resolveAgentAuth('B');
const agentCAuth = resolveAgentAuth('C');
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

function resolveAgentAuth(prefix: AgentPrefix): AgentAuth | undefined {
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

function pathSegment(value: string): string {
    return encodeURIComponent(value);
}

function agentAuth(prefix: AgentPrefix): AgentAuth {
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

async function openAgent(
    browser: Browser,
    input: Readonly<{
        prefix: AgentPrefix;
        auth: AgentAuth;
        runId: string;
        agentId: string;
        actor: string;
        connection: string;
        groupId: string;
    }>
): Promise<LiveRtcControlClient.Agent> {
    const context = await browser.newContext();
    const page = await context.newPage();

    if (input.auth.kind === 'restore') {
        await page.addInitScript((session) => {
            window.localStorage.setItem('auth.session', JSON.stringify(session));
        }, input.auth.session);
    }

    const query = new URLSearchParams({
        mode: 'control',
        provider: 'browser-rallar',
        autoConnect: '1',
        tab: 'local-workbench',
        controlUrl: CONTROL_WS_URL,
        runId: input.runId,
        agentId: input.agentId,
        apiBaseUrl: apiBaseUrl ?? '',
        roomId: input.groupId,
        actor: input.actor,
        sessionId: input.agentId,
        transport: 'realtime',
        statsIntervalMs: '2000',
        rallarLeaveRoomOnClose: '0',
        ...(booleanEnv('VITE_RALLAR_REGISTER') ? { rallarRegister: '1' } : {}),
        ...(input.auth.kind === 'restore' ? { rallarRestoreSession: '1' } : {}),
        ...(input.auth.kind === 'login'
            ? {
                rallarUsername: input.auth.username,
                rallarPassword: input.auth.password
            }
            : {})
    });

    await page.goto(`${SPA_BASE_URL}/?${query.toString()}`);

    if (input.auth.kind === 'login') {
        await expect(page.getByRole('heading', { name: 'Rallar Server Login' }))
            .toBeVisible();
        await page.getByRole('button', { name: 'Sign in' }).click();
    }

    await openTab(page, 'local-workbench', 'black-box-runner');
    await expect(page.locator('#panel-local-workbench .control-panel'))
        .toContainText('registered', { timeout: 30_000 });

    return {
        context,
        page,
        prefix: input.prefix,
        agentId: input.agentId,
        actor: input.actor,
        connection: input.connection
    };
}

async function openAgentTrio(
    browser: Browser,
    input: Readonly<{
        runId: string;
        groupId: string;
        suffix: string;
        label: string;
    }>
): Promise<
    readonly [
        LiveRtcControlClient.Agent,
        LiveRtcControlClient.Agent,
        LiveRtcControlClient.Agent
    ]
> {
    const handles: LiveRtcControlClient.Agent[] = [];
    for (const prefix of ['A', 'B', 'C'] as const) {
        const agentName = `${input.label}-${prefix.toLowerCase()}-${input.suffix}`;
        handles.push(
            await openAgent(browser, {
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

    return handles as [
        LiveRtcControlClient.Agent,
        LiveRtcControlClient.Agent,
        LiveRtcControlClient.Agent
    ];
}

async function closeAgentContexts(
    agents: readonly LiveRtcControlClient.Agent[]
): Promise<void> {
    await Promise.all(
        agents.map((agent) => agent.context.close().catch(() => undefined))
    );
}

async function setupGroupMembership(
    input: Readonly<{
        control: LiveRtcControlClient;
        runId: string;
        owner: LiveRtcControlClient.Agent;
        members: readonly LiveRtcControlClient.Agent[];
        groupId: string;
        suffix: string;
    }>
): Promise<readonly string[]> {
    const groupSegment = pathSegment(input.groupId);
    const createCommandId = `group-create-${input.suffix}`;
    const createRequestId = `rtc-b06-create-${input.suffix}`;
    const joinCommandIds: string[] = [];

    await input.control.executeOk({
        runId: input.runId,
        agentId: input.owner.agentId,
        commandId: createCommandId,
        command: {
            kind: 'http.request',
            request: {
                path: `/api/state/apps/${pathSegment(applicationId)}/workspaces/${
                    pathSegment(workspaceId)
                }/groups/requests/${pathSegment(createRequestId)}`,
                method: 'POST',
                body: {
                    groupId: input.groupId,
                    displayName: input.groupId,
                    description: 'Created by rallar-black-box live three-browser matrix',
                    kind: 'room',
                    joinMode: 'open',
                    createdByPrincipalId: '{auth.clientId}',
                    metadata: {
                        source: 'rallar-black-box',
                        matrix: 'live-three-browser',
                        suffix: input.suffix
                    },
                    lifecyclePolicy: {
                        preset: 'managed',
                        admission: {
                            mode: 'open'
                        },
                        activation: {
                            mode: 'manual'
                        }
                    }
                }
            },
            response: {
                body: 'json',
                acceptedStatusCodes: [201]
            },
            timeoutMs: 10_000
        }
    });

    for (const member of input.members) {
        if (member.agentId === input.owner.agentId) {
            continue;
        }
        const commandId = `group-join-${member.agentId}-${input.suffix}`;
        const requestId = `rtc-b06-member-${member.prefix.toLowerCase()}-${input.suffix}`;
        joinCommandIds.push(commandId);
        await input.control.executeOk({
            runId: input.runId,
            agentId: member.agentId,
            commandId,
            command: {
                kind: 'http.request',
                request: {
                    path: `/api/state/apps/${pathSegment(applicationId)}/workspaces/${
                        pathSegment(workspaceId)
                    }/groups/${groupSegment}/members/{auth.clientId}/requests/${pathSegment(requestId)}`,
                    method: 'PUT',
                    body: {
                        status: 'active'
                    }
                },
                response: {
                    body: 'json',
                    acceptedStatusCodes: [200]
                },
                timeoutMs: 10_000
            }
        });
    }

    return [createCommandId, ...joinCommandIds];
}

async function verifyGroupStateReadback(
    input: Readonly<{
        control: LiveRtcControlClient;
        runId: string;
        owner: LiveRtcControlClient.Agent;
        groupId: string;
        suffix: string;
    }>
): Promise<readonly string[]> {
    const groupSegment = pathSegment(input.groupId);
    const readCommandId = `group-read-${input.suffix}`;
    const eventsCommandId = `group-events-${input.suffix}`;
    const readResult = await input.control.executeOk({
        runId: input.runId,
        agentId: input.owner.agentId,
        commandId: readCommandId,
        command: {
            kind: 'http.request',
            request: {
                path: `/api/state/apps/${pathSegment(applicationId)}/workspaces/${
                    pathSegment(workspaceId)
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
                path: `/api/state/apps/${pathSegment(applicationId)}/workspaces/${
                    pathSegment(workspaceId)
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

async function writeAttemptEvidence(
    input: Readonly<{
        context: LiveRtcPerformanceAttemptContext | null;
        producerExitStatus: number;
        timings: readonly LiveRtcPerformanceTiming[];
        diagnostics: readonly LiveRtcDiagnosticsCheckpoint[];
        retention: LiveRtcPerformanceRawEvidence['retention'];
        assertions: LiveRtcPerformanceRawEvidence['assertions'];
    }>
): Promise<void> {
    if (!input.context) {
        return;
    }
    const environmentId = input.context.locator.environmentId;
    const e4 = environmentId === 'E4-pg';
    const rawEvidence: LiveRtcPerformanceRawEvidence = {
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
                await closeAgentContexts(agents);
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
                    ...await setupGroupMembership({
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
                throw error;
            }
            finally {
                if (allHandles.length > 0) {
                    await control.attachRunSummary({ testInfo, runId }).catch(
                        () => undefined
                    );
                }
                await Promise.all(openHandles.map(async (handle) => {
                    await control.executeResult({
                        runId,
                        agentId: handle.agentId,
                        commandId: `best-effort-close-${handle.prefix.toLowerCase()}-${suffix}`,
                        command: { kind: 'close' },
                        timeoutMs: 15_000
                    }).catch(() => undefined);
                    await handle.context.close();
                }));
                await writeAttemptEvidence({
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
            await closeAgentContexts(agents);
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
                ...await setupGroupMembership({
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
            const reconnectStartedAtMs = performance.now();
            const reconnectC = await groupFormationLifecycleDriver
                .reconnectAndWaitForPeerReadiness({
                    control,
                    runId,
                    reconnectingAgent: messageAgents[2],
                    readinessAgent: messageAgents[1],
                    transport: 'messages.rtc',
                    groupId,
                    suffix: `${suffix}-reconnect-c`
                });
            commandIds.push(reconnectC.commandId);
            const reconnectDurations = await Promise.all(
                messageAgents.slice(0, 2).map((agent) =>
                    control.waitForPeerReadiness({
                        runId,
                        agent,
                        expectedPeerIds: [reconnectC.sessionId],
                        suffix: `${suffix}-reconnect-c`,
                        startedAtMs: reconnectStartedAtMs
                    })
                )
            );
            await control.waitForPeerReadiness({
                runId,
                agent: messageAgents[2],
                expectedPeerIds: [messages.sessions.A, messages.sessions.B],
                suffix: `${suffix}-reconnect-c-settled`,
                startedAtMs: reconnectStartedAtMs
            });
            timings.push({
                kind: 'reconnect-ready',
                transport: 'messages.rtc',
                senderAgentId: messageAgents[2].agentId,
                receiverAgentIds: [
                    messageAgents[0].agentId,
                    messageAgents[1].agentId
                ],
                durationMs: Math.max(...reconnectDurations)
            });
            const reconnectMatrixId = `messages-rtc-reconnect-b-to-c-${suffix}`;
            const reconnectMessageStartedAtMs = performance.now();
            commandIds.push(
                await sendMatrixPayload({
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
            throw error;
        }
        finally {
            if (allHandles.length > 0) {
                await control.attachRunSummary({ testInfo, runId }).catch(() => undefined);
            }
            await Promise.all(openHandles.map(async (handle) => {
                await control.executeResult({
                    runId,
                    agentId: handle.agentId,
                    commandId: `best-effort-close-${handle.prefix.toLowerCase()}-${suffix}`,
                    command: { kind: 'close' },
                    timeoutMs: 15_000
                }).catch(() => undefined);
                await handle.context.close();
            }));
            await writeAttemptEvidence({
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
            diagnosticsOutDir: envValue('RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR')
        });
        const suffix = `live3-retention-${Date.now()}-${crypto.randomUUID()}`;
        const runId = `rallar-live-three-browser-retention-${suffix}`;
        const groupId = `${roomSeed}-${suffix}`;
        const commandIds: string[] = [];
        const timings: LiveRtcPerformanceTiming[] = [];
        const diagnostics: LiveRtcDiagnosticsCheckpoint[] = [];
        const checkpoints: LiveRtcRetentionCheckpoint[] = [];
        const agents = await openAgentTrio(browser, {
            runId,
            groupId,
            suffix,
            label: 'live-retention'
        });
        let producerExitStatus = 0;
        let matrixPassed = false;
        let artifactBundlePassed = false;
        let reconnectPassed = false;
        const unexpectedDeliveryCount = 0;

        const captureCheckpoint = async (cycle: number): Promise<void> => {
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
            commandIds.push(
                ...await setupGroupMembership({
                    control,
                    runId,
                    owner: agents[0],
                    members: agents,
                    groupId,
                    suffix
                })
            );
            const initialFormation = await groupFormationLifecycleDriver.run({
                control,
                runId,
                agents,
                transport: 'messages.rtc',
                groupId,
                suffix: `${suffix}-initial`,
                readinessScope: 'all'
            });
            commandIds.push(...initialFormation.commandIds);
            await captureCheckpoint(0);

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
                const reconnectStartedAtMs = performance.now();
                const reconnected = await groupFormationLifecycleDriver
                    .reconnectAndWaitForPeerReadiness({
                        control,
                        runId,
                        reconnectingAgent: agents[2],
                        readinessAgent: agents[1],
                        transport: 'messages.rtc',
                        groupId,
                        suffix: `${suffix}-${cycle}`
                    });
                commandIds.push(reconnected.commandId);
                const reconnectDurations = await Promise.all(
                    agents.slice(0, 2).map((agent) =>
                        control.waitForPeerReadiness({
                            runId,
                            agent,
                            expectedPeerIds: [reconnected.sessionId],
                            suffix: `${suffix}-${cycle}`,
                            startedAtMs: reconnectStartedAtMs
                        })
                    )
                );
                await control.waitForPeerReadiness({
                    runId,
                    agent: agents[2],
                    expectedPeerIds: [
                        initialFormation.sessions.A,
                        initialFormation.sessions.B
                    ],
                    suffix: `${suffix}-${cycle}-settled`,
                    startedAtMs: reconnectStartedAtMs
                });
                timings.push({
                    kind: 'reconnect-ready',
                    transport: 'messages.rtc',
                    senderAgentId: agents[2].agentId,
                    receiverAgentIds: [agents[0].agentId, agents[1].agentId],
                    durationMs: Math.max(...reconnectDurations)
                });
                currentSessionId = reconnected.sessionId;
                if (cycle % 10 === 0) {
                    await captureCheckpoint(cycle);
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
            throw error;
        }
        finally {
            await control.attachRunSummary({ testInfo, runId }).catch(() => undefined);
            await Promise.all(agents.map(async (agent) => {
                await control.executeResult({
                    runId,
                    agentId: agent.agentId,
                    commandId: `best-effort-close-${agent.prefix.toLowerCase()}-${suffix}`,
                    command: { kind: 'close' },
                    timeoutMs: 15_000
                }).catch(() => undefined);
                await agent.context.close();
            }));
            await writeAttemptEvidence({
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
