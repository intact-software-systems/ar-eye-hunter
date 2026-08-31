import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { openTab } from './full-stack-helpers.ts';
import {
    closeLiveRtcBrowserAgentContexts,
    openLiveRtcBrowserAgent,
    type LiveRtcBrowserAgentAuth
} from './live-rtc-browser-agents.ts';
import { LiveRtcControlClient } from './live-rtc-control-client.ts';
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
import { hasLiveRtcNotYetInSyncNack } from './live-rtc-wire-observation.ts';

const SPA_BASE_URL = envValue('VITE_RALLAR_SPA_BASE_URL') ??
    'http://localhost:5176';
const CONTROL_BASE_URL = 'http://127.0.0.1:5180';
const CONTROL_WS_URL = 'ws://127.0.0.1:5180/control';

type TransportUnderTest = 'realtime' | 'messages.rtc';
type AgentPrefix = 'A' | 'B' | 'C';
type DeliveryMode = 'direct' | 'multicast' | 'broadcast';
type ConnectedAgent = Readonly<{ commandId: string; sessionId: string; }>;
type ConnectedAgentTrio = Readonly<{
    connections: readonly [ConnectedAgent, ConnectedAgent, ConnectedAgent];
    readinessStartedAtMs: number;
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

function pathSegment(value: string): string {
    return encodeURIComponent(value);
}

function transportSlug(transport: TransportUnderTest): string {
    return transport.replace('.', '-');
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

function apiWebSocketUrl(): string {
    const url = new URL(apiBaseUrl ?? 'http://localhost:8080');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/api/ws/{auth.sessionId}';
    url.search = 'ticket={auth.wsTicket}';
    return url.toString();
}

function actorFor(prefix: AgentPrefix, suffix: string): string {
    return firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_ACTOR`,
        `VITE_RALLAR_${prefix}_ACTOR`
    ) ?? `agent-${prefix.toLowerCase()}-${suffix}`;
}

function rallarConnectConfig(
    transport: TransportUnderTest
): object {
    return {
        apiBaseUrl,
        restoreSession: true,
        logoutOnClose: false,
        leaveRoomOnClose: false,
        ...(transport === 'messages.rtc'
            ? {
                typeId: messagesRtcTypeId,
                topicId: messagesRtcTopicId
            }
            : {})
    };
}

function sendPayload(
    input: Readonly<{
        transport: TransportUnderTest;
        groupId: string;
        targetSessionIds?: readonly string[];
        payload: object;
        minSnapshotVersion?: number;
    }>
): object {
    if (input.transport === 'messages.rtc') {
        return {
            roomId: input.groupId,
            ...(input.targetSessionIds
                ? { nextHopPeerIds: input.targetSessionIds }
                : {}),
            typeId: messagesRtcTypeId,
            topicId: messagesRtcTopicId,
            ...(input.minSnapshotVersion !== undefined
                ? { minSnapshotVersion: input.minSnapshotVersion }
                : {}),
            payload: input.payload
        };
    }

    return {
        roomId: input.groupId,
        ...(input.targetSessionIds ? { peerIds: input.targetSessionIds } : {}),
        openTimeoutMs: 20_000,
        data: input.payload
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
    }
    catch (error) {
        await closeLiveRtcBrowserAgentContexts(handles);
        throw error;
    }

    return handles as [
        LiveRtcControlClient.Agent,
        LiveRtcControlClient.Agent,
        LiveRtcControlClient.Agent
    ];
}

interface SetupGroupMembershipInput {
    readonly control: LiveRtcControlClient;
    readonly runId: string;
    readonly owner: LiveRtcControlClient.Agent;
    readonly members: readonly LiveRtcControlClient.Agent[];
    readonly groupId: string;
    readonly suffix: string;
}

async function setupGroupMembership(
    input: SetupGroupMembershipInput
): Promise<readonly string[]> {
    const groupSegment = pathSegment(input.groupId);
    const createCommandId = await createMatrixRoom(input);
    const joinCommandIds: string[] = [];

    for (const member of input.members) {
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

async function configureAgentForServerCommands(
    input: Readonly<{
        control: LiveRtcControlClient;
        runId: string;
        agent: LiveRtcControlClient.Agent;
        groupId: string;
        suffix: string;
    }>
): Promise<string> {
    const commandId = `configure-server-${input.agent.prefix.toLowerCase()}-${input.suffix}`;
    await input.control.executeOk({
        runId: input.runId,
        agentId: input.agent.agentId,
        commandId,
        command: {
            kind: 'configure',
            config: {
                runId: input.runId,
                agentId: input.agent.agentId,
                apiBaseUrl,
                actor: input.agent.actor,
                sessionId: input.agent.agentId,
                roomId: input.groupId,
                control: {
                    mode: 'live-all-scenarios',
                    providerMode: 'browser-rallar'
                },
                defaults: {
                    connection: input.agent.connection,
                    providerMode: 'browser-rallar'
                },
                rallar: {
                    apiBaseUrl,
                    restoreSession: true,
                    leaveRoomOnClose: false
                }
            }
        }
    });
    return commandId;
}

interface WebSocketMatrixInput {
    readonly control: LiveRtcControlClient;
    readonly runId: string;
    readonly agents: readonly LiveRtcControlClient.Agent[];
    readonly groupId: string;
    readonly suffix: string;
}

async function runWebSocketOpenSendCloseMatrix(
    input: WebSocketMatrixInput
): Promise<readonly string[]> {
    const commandIds: string[] = [];
    for (const agent of input.agents) {
        commandIds.push(
            await configureAgentForServerCommands({ ...input, agent })
        );
        const connection = `ws-${agent.prefix.toLowerCase()}-${input.suffix}`;
        const openCommandId = `ws-open-${agent.prefix.toLowerCase()}-${input.suffix}`;
        const sendCommandId = `ws-send-${agent.prefix.toLowerCase()}-${input.suffix}`;
        const closeCommandId = `ws-close-${agent.prefix.toLowerCase()}-${input.suffix}`;
        commandIds.push(openCommandId, sendCommandId, closeCommandId);
        await input.control.executeOk({
            runId: input.runId,
            agentId: agent.agentId,
            commandId: openCommandId,
            command: {
                kind: 'ws.open',
                connection,
                url: apiWebSocketUrl(),
                timeoutMs: 15_000
            },
            timeoutMs: 30_000
        });
        await input.control.executeOk({
            runId: input.runId,
            agentId: agent.agentId,
            commandId: sendCommandId,
            command: {
                kind: 'ws.send',
                connection,
                data: toWebSocketMatrixPayload(input, agent)
            }
        });
        await input.control.executeOk({
            runId: input.runId,
            agentId: agent.agentId,
            commandId: closeCommandId,
            command: {
                kind: 'ws.close',
                connection,
                code: 1000,
                reason: 'live-all-scenarios-complete'
            }
        });
    }
    return commandIds;
}

async function connectAgent(
    input: Readonly<{
        control: LiveRtcControlClient;
        runId: string;
        agent: LiveRtcControlClient.Agent;
        transport: TransportUnderTest;
        groupId: string;
        suffix: string;
    }>
): Promise<ConnectedAgent> {
    const commandId = `connect-${input.agent.prefix.toLowerCase()}-${
        input.transport.replace('.', '-')
    }-${input.suffix}`;
    const result = await input.control.executeOk({
        runId: input.runId,
        agentId: input.agent.agentId,
        commandId,
        command: {
            kind: 'rtc.connect',
            connection: `${input.agent.connection}-${input.transport.replace('.', '-')}`,
            actor: input.agent.actor,
            roomId: input.groupId,
            applicationId,
            workspaceId,
            roomRef: {
                applicationId,
                workspaceId,
                groupId: input.groupId
            },
            transport: input.transport,
            rallar: rallarConnectConfig(input.transport),
            timeoutMs: 45_000
        },
        timeoutMs: 60_000
    });

    return {
        commandId,
        sessionId: input.control.requireSessionId(result, commandId)
    };
}

async function connectAgentTrio(
    input: Readonly<{
        control: LiveRtcControlClient;
        runId: string;
        agents: readonly [
            LiveRtcControlClient.Agent,
            LiveRtcControlClient.Agent,
            LiveRtcControlClient.Agent
        ];
        transport: TransportUnderTest;
        groupId: string;
        suffix: string;
    }>
): Promise<ConnectedAgentTrio> {
    const connected: ConnectedAgent[] = [];
    for (const agent of input.agents.slice(0, 2)) {
        connected.push(
            await connectAgent({ ...input, agent })
        );
    }

    const firstPairReadinessStartedAtMs = performance.now();
    await Promise.all([
        input.control.waitForPeerReadiness({
            runId: input.runId,
            agent: input.agents[0],
            expectedPeerIds: [connected[1]!.sessionId],
            suffix: `${input.suffix}-initial-pair`,
            startedAtMs: firstPairReadinessStartedAtMs
        }),
        input.control.waitForPeerReadiness({
            runId: input.runId,
            agent: input.agents[1],
            expectedPeerIds: [connected[0]!.sessionId],
            suffix: `${input.suffix}-initial-pair`,
            startedAtMs: firstPairReadinessStartedAtMs
        })
    ]);

    const readinessStartedAtMs = performance.now();
    connected.push(
        await connectAgent({ ...input, agent: input.agents[2] })
    );
    return {
        connections: [connected[0]!, connected[1]!, connected[2]!],
        readinessStartedAtMs
    };
}

async function sendMatrixPayload(
    input: Readonly<{
        control: LiveRtcControlClient;
        runId: string;
        sender: LiveRtcControlClient.Agent;
        transport: TransportUnderTest;
        groupId: string;
        suffix: string;
        deliveryMode: 'direct' | 'multicast' | 'broadcast';
        targetSessionIds?: readonly string[];
        matrixId: string;
    }>
): Promise<string> {
    const commandId = `send-${input.matrixId}`;
    await input.control.executeOk({
        runId: input.runId,
        agentId: input.sender.agentId,
        commandId,
        command: {
            kind: 'rtc.send',
            connection: `${input.sender.connection}-${input.transport.replace('.', '-')}`,
            transport: input.transport,
            applicationId,
            workspaceId,
            roomRef: {
                applicationId,
                workspaceId,
                groupId: input.groupId
            },
            timeoutMs: 60_000,
            send: sendPayload({
                transport: input.transport,
                groupId: input.groupId,
                targetSessionIds: input.targetSessionIds,
                payload: {
                    topic: 'rallar.black-box.live-three-browser',
                    matrixId: input.matrixId,
                    deliveryMode: input.deliveryMode,
                    transport: input.transport,
                    runId: input.runId,
                    groupId: input.groupId
                }
            })
        },
        timeoutMs: 70_000
    });
    return commandId;
}

interface DeliveryMatrixInput {
    control: LiveRtcControlClient;
    runId: string;
    agents: readonly [LiveRtcControlClient.Agent, LiveRtcControlClient.Agent, LiveRtcControlClient.Agent];
    transport: TransportUnderTest;
    groupId: string;
    suffix: string;
}

interface DeliveryMatrixResult {
    commandIds: readonly string[];
    sessions: Readonly<Record<AgentPrefix, string>>;
    scenarios: readonly LiveRtcControlClient.DeliveryScenario[];
    timings: readonly LiveRtcPerformanceTiming[];
}

interface MatrixDeliveryInput extends DeliveryMatrixInput {
    sessions: Readonly<Record<AgentPrefix, string>>;
    sender: LiveRtcControlClient.Agent;
    receivers: readonly LiveRtcControlClient.Agent[];
    deliveryMode: DeliveryMode;
    matrixId: string;
}

interface MatrixDeliveryResult {
    commandId: string;
    scenario: LiveRtcControlClient.DeliveryScenario;
    timing: LiveRtcPerformanceTiming;
}

async function runDeliveryMatrix(input: DeliveryMatrixInput): Promise<DeliveryMatrixResult> {
    const connected = await connectAgentTrio(input);
    const sessions = toAgentSessions(connected.connections);
    const [agentA, agentB, agentC] = input.agents;
    const readinessDurationMs = await input.control.waitForPeerReadiness({
        runId: input.runId,
        agent: agentA,
        expectedPeerIds: [sessions.B, sessions.C],
        suffix: transportSlug(input.transport) + '-' + input.suffix,
        startedAtMs: connected.readinessStartedAtMs
    });
    const delivery = { ...input, sessions, sender: agentA };
    const direct = await observeMatrixDelivery({
        ...delivery,
        receivers: [agentB],
        deliveryMode: 'direct',
        matrixId: 'direct-' + input.transport + '-' + input.suffix
    });
    await expectMatrixInboxMessage(agentB.page, direct.scenario.matrixId);
    const multicast = await observeMatrixDelivery({
        ...delivery,
        receivers: [agentB, agentC],
        deliveryMode: 'multicast',
        matrixId: 'multicast-' + input.transport + '-' + input.suffix
    });
    const broadcast = await observeMatrixDelivery({
        ...delivery,
        receivers: [agentB, agentC],
        deliveryMode: 'broadcast',
        matrixId: 'broadcast-' + input.transport + '-' + input.suffix
    });
    await expectMatrixInboxMessage(agentC.page, broadcast.scenario.matrixId);
    if (input.transport === 'realtime') {
        const health = await input.control.executeOk({
            runId: input.runId,
            agentId: agentA.agentId,
            commandId: 'health-a-' + input.suffix,
            command: { kind: 'health' }
        });
        expect(input.control.readyPeerIds(health)).toEqual(expect.arrayContaining([sessions.B, sessions.C]));
    }
    const deliveries = [direct, multicast, broadcast];
    return {
        commandIds: [
            ...connected.connections.map((result) => result.commandId),
            ...deliveries.map((result) => result.commandId)
        ],
        sessions,
        scenarios: deliveries.map((result) => result.scenario),
        timings: [{
            kind: 'peer-ready',
            transport: input.transport,
            senderAgentId: agentA.agentId,
            receiverAgentIds: [agentB.agentId, agentC.agentId],
            durationMs: readinessDurationMs
        }, ...deliveries.map((result) => result.timing)]
    };
}

async function runAllDeliveryPermutations(input: DeliveryMatrixInput): Promise<DeliveryMatrixResult> {
    const connected = await connectAgentTrio(input);
    const sessions = toAgentSessions(connected.connections);
    const readinessDurations = await Promise.all(input.agents.map((agent) =>
        input.control.waitForPeerReadiness({
            runId: input.runId,
            agent,
            expectedPeerIds: input.agents.filter((candidate) => candidate.agentId !== agent.agentId)
                .map((candidate) => sessions[candidate.prefix]),
            suffix: transportSlug(input.transport) + '-' + input.suffix + '-all',
            startedAtMs: connected.readinessStartedAtMs
        })
    ));
    const timings: LiveRtcPerformanceTiming[] = input.agents.map((agent, index) => ({
        kind: 'peer-ready',
        transport: input.transport,
        senderAgentId: agent.agentId,
        receiverAgentIds: input.agents.filter((candidate) => candidate.agentId !== agent.agentId).map((candidate) =>
            candidate.agentId
        ),
        durationMs: readinessDurations[index]!
    }));
    const deliveries: MatrixDeliveryResult[] = [];
    for (const sender of input.agents) {
        deliveries.push(
            ...await observeSenderPermutations({
                ...input,
                sessions,
                sender,
                receivers: input.agents.filter((agent) => agent.agentId !== sender.agentId)
            })
        );
    }
    return {
        commandIds: [
            ...connected.connections.map((result) => result.commandId),
            ...deliveries.map((result) => result.commandId)
        ],
        sessions,
        scenarios: deliveries.map((result) => result.scenario),
        timings: [...timings, ...deliveries.map((result) => result.timing)]
    };
}

async function observeSenderPermutations(
    input: Omit<MatrixDeliveryInput, 'deliveryMode' | 'matrixId'>
): Promise<MatrixDeliveryResult[]> {
    const slug = transportSlug(input.transport);
    const sender = input.sender.prefix.toLowerCase();
    const deliveries: MatrixDeliveryResult[] = [];
    for (const receiver of input.receivers) {
        deliveries.push(
            await observeMatrixDelivery({
                ...input,
                receivers: [receiver],
                deliveryMode: 'direct',
                matrixId: slug + '-direct-' + sender + '-to-' + receiver.prefix.toLowerCase() + '-' + input.suffix
            })
        );
    }
    deliveries.push(
        await observeMatrixDelivery({
            ...input,
            deliveryMode: 'multicast',
            matrixId: slug + '-multicast-' + sender + '-' + input.suffix
        })
    );
    deliveries.push(
        await observeMatrixDelivery({
            ...input,
            deliveryMode: 'broadcast',
            matrixId: slug + '-broadcast-' + sender + '-' + input.suffix
        })
    );
    return deliveries;
}

async function observeMatrixDelivery(input: MatrixDeliveryInput): Promise<MatrixDeliveryResult> {
    const startedAtMs = performance.now();
    const commandId = await sendMatrixPayload({
        ...input,
        targetSessionIds: input.deliveryMode === 'broadcast'
            ? undefined
            : input.receivers.map((receiver) => input.sessions[receiver.prefix])
    });
    const durations = await Promise.all(input.receivers.map((receiver) =>
        input.control.waitForMessage({
            runId: input.runId,
            agentId: receiver.agentId,
            transport: input.transport,
            matrixId: input.matrixId,
            deliveryMode: input.deliveryMode,
            startedAtMs
        })
    ));
    const receiverAgentIds = input.receivers.map((receiver) => receiver.agentId);
    return {
        commandId,
        scenario: {
            matrixId: input.matrixId,
            transport: input.transport,
            deliveryMode: input.deliveryMode,
            senderAgentId: input.sender.agentId,
            expectedAgentIds: receiverAgentIds,
            allowedAgentIds: input.deliveryMode === 'broadcast'
                ? input.agents.map((agent) => agent.agentId)
                : receiverAgentIds
        },
        timing: {
            kind: input.deliveryMode === 'direct'
                ? 'direct-delivery'
                : input.deliveryMode === 'multicast'
                ? 'multicast-delivery'
                : 'broadcast-delivery',
            transport: input.transport,
            senderAgentId: input.sender.agentId,
            receiverAgentIds,
            durationMs: Math.max(...durations)
        }
    };
}

function toAgentSessions(
    connections: ConnectedAgentTrio['connections']
): Readonly<Record<AgentPrefix, string>> {
    const sessions = { A: connections[0].sessionId, B: connections[1].sessionId, C: connections[2].sessionId };
    expect(new Set(Object.values(sessions)).size).toBe(3);
    return sessions;
}

async function expectMatrixInboxMessage(page: Page, matrixId: string): Promise<void> {
    await openTab(page, 'manual-rallar', 'black-box-runner');
    await expect(page.locator('#panel-manual-rallar .received-inbox-panel')).toContainText(matrixId, {
        timeout: 30_000
    });
}

interface NackProbeInput {
    readonly testInfo: TestInfo;
    readonly control: LiveRtcControlClient;
    readonly runId: string;
    readonly agent: LiveRtcControlClient.Agent;
    readonly groupId: string;
    readonly suffix: string;
    readonly targetSessionId: string;
    readonly senderSessionId: string;
}

async function runNackProbe(input: NackProbeInput): Promise<string> {
    await input.agent.page.evaluate(() => {
        if (!window.__liveRtcWireObservation) {
            throw new Error('RTC wire observer is missing.');
        }
        window.__liveRtcWireObservation.start();
    });
    const commandId = `nack-not-yet-in-sync-${input.suffix}`;
    try {
        const result = await sendNackProbe(input, commandId);
        const messageId = input.control.requireSentMessageId(result);
        const identity = { messageId, senderSessionId: input.senderSessionId, targetSessionId: input.targetSessionId };
        let frames: readonly string[] = [];
        await expect.poll(async () => {
            const received = await input.agent.page.evaluate(() => {
                if (!window.__liveRtcWireObservation) {
                    throw new Error('RTC wire observer is missing.');
                }
                return window.__liveRtcWireObservation.read();
            });
            frames = received.filter((frame) => hasLiveRtcNotYetInSyncNack({ ...identity, frames: [frame] }));
            return frames.length > 0;
        }, { timeout: 15_000, message: 'Expected a received not-yet-in-sync NACK for the probe message.' }).toBe(true);
        await input.control.recordReceivedNack({
            ...identity,
            frames,
            testInfo: input.testInfo,
            runId: input.runId,
            agentId: input.agent.agentId
        });
        return commandId;
    }
    finally {
        await input.agent.page.evaluate(() => window.__liveRtcWireObservation?.stop()).catch(() => undefined);
    }
}

async function sendNackProbe(
    input: NackProbeInput,
    commandId: string
): Promise<LiveRtcControlClient.Result> {
    return await input.control.executeOk({
        runId: input.runId,
        agentId: input.agent.agentId,
        commandId,
        command: {
            kind: 'rtc.send',
            connection: `${input.agent.connection}-messages-rtc`,
            transport: 'messages.rtc',
            applicationId,
            workspaceId,
            roomRef: {
                applicationId,
                workspaceId,
                groupId: input.groupId
            },
            minSnapshotVersion: 9_999_999,
            timeoutMs: 45_000,
            send: sendPayload({
                transport: 'messages.rtc',
                groupId: input.groupId,
                targetSessionIds: [input.targetSessionId],
                payload: {
                    topic: 'rallar.black-box.live-three-browser.nack',
                    matrixId: `nack-${input.suffix}`,
                    deliveryMode: 'nack',
                    transport: 'messages.rtc',
                    runId: input.runId,
                    groupId: input.groupId
                },
                minSnapshotVersion: 9_999_999
            })
        },
        timeoutMs: 60_000
    });
}

async function expectClosedTransportFailure(
    input: Readonly<{
        control: LiveRtcControlClient;
        runId: string;
        agent: LiveRtcControlClient.Agent;
        groupId: string;
        suffix: string;
        targetSessionId: string;
    }>
): Promise<readonly string[]> {
    const closeCommandId = `close-before-stale-send-${input.agent.prefix.toLowerCase()}-${input.suffix}`;
    await input.control.executeOk({
        runId: input.runId,
        agentId: input.agent.agentId,
        commandId: closeCommandId,
        command: { kind: 'close' },
        timeoutMs: 45_000
    });

    const staleSendCommandId = `stale-send-${input.agent.prefix.toLowerCase()}-${input.suffix}`;
    const staleResult = await input.control.executeResult({
        runId: input.runId,
        agentId: input.agent.agentId,
        commandId: staleSendCommandId,
        command: {
            kind: 'rtc.send',
            connection: `${input.agent.connection}-messages-rtc`,
            transport: 'messages.rtc',
            timeoutMs: 10_000,
            send: sendPayload({
                transport: 'messages.rtc',
                groupId: input.groupId,
                targetSessionIds: [input.targetSessionId],
                payload: {
                    topic: 'rallar.black-box.live-three-browser.stale-send',
                    matrixId: `stale-send-${input.suffix}`,
                    deliveryMode: 'stale-send',
                    transport: 'messages.rtc',
                    runId: input.runId
                }
            })
        },
        timeoutMs: 30_000
    });
    expect(staleResult.ok).toBe(false);
    expect(JSON.stringify(staleResult).toLowerCase()).toMatch(
        /not connected|runtime|closed|connect/
    );
    return [closeCommandId, staleSendCommandId];
}

async function closeAndResetAgents(
    input: Readonly<{
        control: LiveRtcControlClient;
        runId: string;
        agents: readonly LiveRtcControlClient.Agent[];
        suffix: string;
    }>
): Promise<readonly string[]> {
    const commandIds: string[] = [];
    for (const agent of input.agents) {
        const closeCommandId = `close-${agent.prefix.toLowerCase()}-${input.suffix}`;
        const resetCommandId = `reset-${agent.prefix.toLowerCase()}-${input.suffix}`;
        commandIds.push(closeCommandId, resetCommandId);
        await input.control.executeResult({
            runId: input.runId,
            agentId: agent.agentId,
            commandId: closeCommandId,
            command: { kind: 'close' },
            timeoutMs: 45_000
        });
        await input.control.executeResult({
            runId: input.runId,
            agentId: agent.agentId,
            commandId: resetCommandId,
            command: { kind: 'reset' },
            timeoutMs: 30_000
        });
    }
    return commandIds;
}

async function closeAndResetSettledAgentTrio(
    input: Readonly<{
        control: LiveRtcControlClient;
        runId: string;
        agents: readonly [
            LiveRtcControlClient.Agent,
            LiveRtcControlClient.Agent,
            LiveRtcControlClient.Agent
        ];
        sessions: Readonly<Record<AgentPrefix, string>>;
        suffix: string;
    }>
): Promise<readonly string[]> {
    const commandIds: string[] = [];
    const closeAndReset = async (
        agent: LiveRtcControlClient.Agent
    ): Promise<void> => {
        const closeCommandId = `close-${agent.prefix.toLowerCase()}-${input.suffix}`;
        const resetCommandId = `reset-${agent.prefix.toLowerCase()}-${input.suffix}`;
        commandIds.push(closeCommandId, resetCommandId);
        await input.control.executeOk({
            runId: input.runId,
            agentId: agent.agentId,
            commandId: closeCommandId,
            command: { kind: 'close' },
            timeoutMs: 45_000
        });
        await input.control.executeOk({
            runId: input.runId,
            agentId: agent.agentId,
            commandId: resetCommandId,
            command: { kind: 'reset' },
            timeoutMs: 30_000
        });
    };

    await closeAndReset(input.agents[2]);
    await Promise.all(
        input.agents.slice(0, 2).map((agent) =>
            input.control.waitForPeerAbsence({
                runId: input.runId,
                agent,
                departedPeerIds: [input.sessions.C],
                suffix: `${input.suffix}-retire-c`
            })
        )
    );

    await closeAndReset(input.agents[1]);
    await input.control.waitForPeerAbsence({
        runId: input.runId,
        agent: input.agents[0],
        departedPeerIds: [input.sessions.B],
        suffix: `${input.suffix}-retire-b`
    });

    await closeAndReset(input.agents[0]);
    return commandIds;
}

interface WriteAttemptEvidenceInput {
    readonly context: LiveRtcPerformanceAttemptContext | null;
    readonly producerExitStatus: number;
    readonly timings: readonly LiveRtcPerformanceTiming[];
    readonly diagnostics: readonly LiveRtcDiagnosticsCheckpoint[];
    readonly retention: LiveRtcPerformanceRawEvidence['retention'];
    readonly assertions: LiveRtcPerformanceRawEvidence['assertions'];
}

async function writeAttemptEvidence(input: WriteAttemptEvidenceInput): Promise<void> {
    if (!input.context) {
        return;
    }
    const rawEvidence = toMatrixRawEvidence({ ...input, context: input.context });
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

async function createMatrixRoom(input: SetupGroupMembershipInput): Promise<string> {
    const createCommandId = `group-create-${input.suffix}`;
    const createRequestId = `rtc-b06-create-${input.suffix}`;

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

    return createCommandId;
}

function toWebSocketMatrixPayload(
    input: WebSocketMatrixInput,
    agent: LiveRtcControlClient.Agent
): object {
    return {
        id: {
            v: 2,
            msgId: `ws-${agent.prefix.toLowerCase()}-${input.suffix}`,
            ts: 0,
            senderId: '{auth.sessionId}',
            sessionId: '{auth.sessionId}',
            traceId: `ws-${input.suffix}`
        },
        route: {
            topicId: 'app.black-box.live-three-browser.ws',
            resourceId: `ws-${agent.prefix.toLowerCase()}-${input.suffix}`,
            contextId: `${applicationId}:${workspaceId}:${input.groupId}`
        },
        targets: {
            mode: 'unicast',
            toPeerId: '{auth.sessionId}'
        },
        delivery: {
            reliability: 'best-effort',
            ack: 'none'
        },
        payload: {
            typeId: 'app.black-box.live-three-browser.ws',
            contentType: 'application/json',
            resource: JSON.stringify({
                matrixId: `ws-${agent.prefix.toLowerCase()}-${input.suffix}`,
                agentId: agent.agentId,
                groupId: input.groupId,
                runId: input.runId
            })
        }
    };
}

function toMatrixRawEvidence(
    input: WriteAttemptEvidenceInput & { context: LiveRtcPerformanceAttemptContext; }
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
                epochNow: Date.now,
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
                    ? await closeAndResetSettledAgentTrio({
                        control,
                        runId,
                        agents,
                        sessions,
                        suffix: closeSuffix
                    })
                    : await closeAndResetAgents({
                        control,
                        runId,
                        agents,
                        suffix: closeSuffix
                    });
                await closeLiveRtcBrowserAgentContexts(agents);
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

                const realtime = await runDeliveryMatrix({
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
                const messages = await runDeliveryMatrix({
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
                    await runNackProbe({
                        testInfo,
                        control,
                        runId,
                        agent: messageAgents[0],
                        groupId,
                        suffix,
                        targetSessionId: messages.sessions.B,
                        senderSessionId: messages.sessions.A
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
                    ...await expectClosedTransportFailure({
                        control,
                        runId,
                        agent: messageAgents[2],
                        groupId,
                        suffix,
                        targetSessionId: messages.sessions.B
                    })
                );
                commandIds.push(
                    ...await closeAndResetAgents({
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
                        run.results
                            .filter((result) => result.ok === true)
                            .map((result) => result.commandId)
                    );
                    const topics = control.runtimeTopics(run);
                    return {
                        agents: run.agents
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
            monotonicNow: () => performance.now(),
            epochNow: Date.now,
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
                ? await closeAndResetSettledAgentTrio({
                    control,
                    runId,
                    agents,
                    sessions,
                    suffix: closeSuffix
                })
                : await closeAndResetAgents({
                    control,
                    runId,
                    agents,
                    suffix: closeSuffix
                });
            await closeLiveRtcBrowserAgentContexts(agents);
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
            const realtime = await runAllDeliveryPermutations({
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
                ...await runWebSocketOpenSendCloseMatrix({
                    control,
                    runId,
                    agents: wsAgents,
                    groupId,
                    suffix
                })
            );
            commandIds.push(...await retireAgents(wsAgents, `${suffix}-after-ws-all`));

            const messageAgents = await openAgents('live-all-messages');
            const messages = await runAllDeliveryPermutations({
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
                await runNackProbe({
                    testInfo,
                    control,
                    runId,
                    agent: messageAgents[0],
                    groupId,
                    suffix,
                    targetSessionId: messages.sessions.B,
                    senderSessionId: messages.sessions.A
                })
            );
            commandIds.push(
                ...await expectClosedTransportFailure({
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
            const reconnectC = await connectAgent({
                control,
                runId,
                agent: messageAgents[2],
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
                ...await closeAndResetAgents({
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
                    run.results
                        .filter((result) => result.ok === true)
                        .map((result) => result.commandId)
                );
                return {
                    agents: run.agents.filter((agent) =>
                        allHandles.some((handle) => handle.agentId === agent.agentId)
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
            monotonicNow: () => performance.now(),
            epochNow: Date.now,
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
            const initialConnection = await connectAgentTrio({
                control,
                runId,
                agents,
                transport: 'messages.rtc',
                groupId,
                suffix: `${suffix}-initial`
            });
            const connected = initialConnection.connections;
            commandIds.push(...connected.map((connection) => connection.commandId));
            const initialReadinessStartedAtMs = initialConnection.readinessStartedAtMs;
            await Promise.all(agents.map((agent, agentIndex) =>
                control.waitForPeerReadiness({
                    runId,
                    agent,
                    expectedPeerIds: connected
                        .filter((_, connectionIndex) => connectionIndex !== agentIndex)
                        .map((connection) => connection.sessionId),
                    suffix: `${suffix}-initial`,
                    startedAtMs: initialReadinessStartedAtMs
                })
            ));
            await captureCheckpoint(0);

            let currentSessionId = connected[2].sessionId;
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
                const reconnected = await connectAgent({
                    control,
                    runId,
                    agent: agents[2],
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
                    expectedPeerIds: [connected[0].sessionId, connected[1].sessionId],
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
                ...await closeAndResetAgents({
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
