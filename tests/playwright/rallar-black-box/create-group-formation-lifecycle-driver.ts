// dprint-ignore
import {
    expect
} from '@playwright/test';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/types.ts';
import type { RtcBaselineJson } from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';
import type { LiveRtcControlClient } from './live-rtc-performance-evidence.ts';

type TransportUnderTest = 'realtime' | 'messages.rtc';
type AgentPrefix = 'A' | 'B' | 'C';
type ReadinessScope = 'owner' | 'all';
type FormationEntryLifecycleState = 'forming' | 'active';

interface CreateGroupFormationLifecycleDriverConfig {
    readonly apiBaseUrl: string | undefined;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly messagesRtcTypeId: string;
    readonly messagesRtcTopicId: string;
}

interface RunGroupFormationLifecycleInput {
    readonly control: LiveRtcControlPort;
    readonly runId: string;
    readonly agents: readonly [LiveRtcControlClient.Agent, LiveRtcControlClient.Agent, LiveRtcControlClient.Agent];
    readonly transport: TransportUnderTest;
    readonly groupId: string;
    readonly suffix: string;
    readonly readinessScope: ReadinessScope;
}

interface GroupFormationLifecycleRun {
    readonly commandIds: readonly string[];
    readonly sessions: Readonly<Record<AgentPrefix, string>>;
    readonly readinessDurations: Readonly<Partial<Record<AgentPrefix, number>>>;
}

interface ReconnectFormationAgentInput {
    readonly control: LiveRtcControlPort;
    readonly runId: string;
    readonly reconnectingAgent: LiveRtcControlClient.Agent;
    readonly readinessAgent: LiveRtcControlClient.Agent;
    readonly transport: TransportUnderTest;
    readonly groupId: string;
    readonly suffix: string;
}

export interface GroupFormationLifecycleDriver {
    setupGroupMembership(input: Parameters<typeof setupGroupMembership>[1]): Promise<readonly string[]>;
    run(
        input: RunGroupFormationLifecycleInput
    ): Promise<GroupFormationLifecycleRun>;
    reconnectAndWaitForPeerReadiness(
        input: ReconnectFormationAgentInput
    ): Promise<FormationAgentConnection>;
}

export interface LiveRtcControlPort extends
    Pick<
        LiveRtcControlClient,
        | 'executeOk'
        | 'executeResult'
        | 'resultValue'
        | 'requireSessionId'
        | 'waitForPeerReadiness'
        | 'waitForPeerAbsence'
        | 'waitForMessage'
        | 'readyPeerIds'
    > {}

interface ConnectFormationAgentInput {
    readonly control: LiveRtcControlPort;
    readonly runId: string;
    readonly agent: LiveRtcControlClient.Agent;
    readonly transport: TransportUnderTest;
    readonly groupId: string;
    readonly suffix: string;
}

interface FormationAgentConnection {
    readonly commandId: string;
    readonly sessionId: string;
}

interface FormationConnections {
    readonly connectResults: readonly [
        FormationAgentConnection,
        FormationAgentConnection,
        FormationAgentConnection
    ];
    readonly presenceCommandIds: readonly string[];
    readonly readinessStartedAtMs: number;
}

interface EstablishedGroupLifecycle {
    readonly commandIds: readonly string[];
    readonly readinessDurations: Readonly<Partial<Record<AgentPrefix, number>>>;
}

interface EstablishGroupLifecycleInput {
    readonly run: RunGroupFormationLifecycleInput;
    readonly sessions: Readonly<Record<AgentPrefix, string>>;
    readonly lifecycleSuffix: string;
}

interface GroupLifecycleCommandInput {
    readonly control: LiveRtcControlPort;
    readonly runId: string;
    readonly owner: LiveRtcControlClient.Agent;
    readonly groupId: string;
    readonly suffix: string;
}

interface ActivateGroupInput extends GroupLifecycleCommandInput {
    readonly agents: readonly [LiveRtcControlClient.Agent, LiveRtcControlClient.Agent, LiveRtcControlClient.Agent];
    readonly transport: TransportUnderTest;
}

interface WaitForPlannedLayoutInput extends GroupLifecycleCommandInput {
    readonly expectedSessionIds: readonly string[];
}

interface WaitForPresenceRevisionInput extends GroupLifecycleCommandInput {
    readonly minimumRevision: number;
}

interface WaitForFormationReadinessInput {
    readonly run: RunGroupFormationLifecycleInput;
    readonly sessions: Readonly<Record<AgentPrefix, string>>;
    readonly suffix: string;
    readonly startedAtMs: number;
}

export function createGroupFormationLifecycleDriver(
    config: CreateGroupFormationLifecycleDriverConfig
): GroupFormationLifecycleDriver {
    return {
        setupGroupMembership: (input) => setupGroupMembership(config, input),
        run: async (input) => await runGroupFormationLifecycle(config, input),
        reconnectAndWaitForPeerReadiness: async (input) => {
            const connection = await connectFormationAgent(config, {
                control: input.control,
                runId: input.runId,
                agent: input.reconnectingAgent,
                transport: input.transport,
                groupId: input.groupId,
                suffix: input.suffix
            });
            await input.control.waitForPeerReadiness({
                runId: input.runId,
                agent: input.readinessAgent,
                expectedPeerIds: [connection.sessionId],
                suffix: input.suffix,
                startedAtMs: performance.now()
            });
            return connection;
        }
    };
}

async function runGroupFormationLifecycle(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: RunGroupFormationLifecycleInput
): Promise<GroupFormationLifecycleRun> {
    const formationConnections = await connectFormationAgents(config, input);
    const sessions: Readonly<Record<AgentPrefix, string>> = {
        A: formationConnections.connectResults[0].sessionId,
        B: formationConnections.connectResults[1].sessionId,
        C: formationConnections.connectResults[2].sessionId
    };
    expect(new Set(Object.values(sessions)).size).toBe(3);

    const lifecycleSuffix = `${input.transport.replace('.', '-')}-${input.suffix}${
        input.readinessScope === 'all' ? '-all' : ''
    }`;
    const established = await establishGroupLifecycle(config, {
        run: input,
        sessions,
        lifecycleSuffix,
        readinessStartedAtMs: formationConnections.readinessStartedAtMs
    });
    return {
        commandIds: [
            ...formationConnections.connectResults.map((result) => result.commandId),
            ...formationConnections.presenceCommandIds,
            ...established.commandIds
        ],
        sessions,
        readinessDurations: established.readinessDurations
    };
}

async function establishGroupLifecycle(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: EstablishGroupLifecycleInput & Readonly<{ readinessStartedAtMs: number; }>
): Promise<EstablishedGroupLifecycle> {
    const owner = input.run.agents[0];
    const topologyCommandId = await configureMeshTopology(config, {
        ...input.run,
        owner,
        suffix: input.lifecycleSuffix
    });
    const lifecycleCommandIds = await enterGroupConnectionCycle(config, {
        ...input.run,
        owner,
        suffix: input.lifecycleSuffix
    });
    const plannedLayoutCommandIds = await waitForPlannedLayout(config, {
        ...input.run,
        owner,
        suffix: input.lifecycleSuffix,
        expectedSessionIds: Object.values(input.sessions)
    });
    await refreshAgentRooms(input.run.agents);
    const readinessDurations = await waitForFormationReadiness({
        run: input.run,
        sessions: input.sessions,
        suffix: input.lifecycleSuffix,
        startedAtMs: input.readinessStartedAtMs
    });
    const activateCommandId = await activateAndRefreshAcceptedLayout(config, {
        ...input.run,
        owner,
        agents: input.run.agents
    });

    return {
        commandIds: [
            topologyCommandId,
            ...lifecycleCommandIds,
            ...plannedLayoutCommandIds,
            activateCommandId
        ],
        readinessDurations
    };
}

async function connectFormationAgents(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: RunGroupFormationLifecycleInput
): Promise<FormationConnections> {
    const owner = input.agents[0];
    const connectA = await connectFormationAgent(config, {
        ...input,
        agent: owner
    });
    const presenceA = await waitForPresenceRevision(config, {
        ...input,
        owner,
        minimumRevision: 1
    });
    const connectB = await connectFormationAgent(config, {
        ...input,
        agent: input.agents[1]
    });
    const presenceB = await waitForPresenceRevision(config, {
        ...input,
        owner,
        minimumRevision: 2
    });
    const readinessStartedAtMs = performance.now();
    const connectC = await connectFormationAgent(config, {
        ...input,
        agent: input.agents[2]
    });
    const presenceC = await waitForPresenceRevision(config, {
        ...input,
        owner,
        minimumRevision: 3
    });

    return {
        connectResults: [connectA, connectB, connectC],
        presenceCommandIds: [...presenceA, ...presenceB, ...presenceC],
        readinessStartedAtMs
    };
}

async function connectFormationAgent(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: ConnectFormationAgentInput
): Promise<FormationAgentConnection> {
    const transport = input.transport.replace('.', '-');
    const commandId = `connect-${input.agent.prefix.toLowerCase()}-${transport}-${input.suffix}`;
    const result = await input.control.executeOk({
        ...input,
        agentId: input.agent.agentId,
        commandId,
        command: {
            kind: 'rtc.connect',
            connection: `${input.agent.connection}-${transport}`,
            actor: input.agent.actor,
            roomId: input.groupId,
            applicationId: config.applicationId,
            workspaceId: config.workspaceId,
            roomRef: {
                applicationId: config.applicationId,
                workspaceId: config.workspaceId,
                groupId: input.groupId
            },
            transport: input.transport,
            rallar: {
                apiBaseUrl: config.apiBaseUrl,
                restoreSession: true,
                logoutOnClose: false,
                leaveRoomOnClose: false,
                ...(input.transport === 'messages.rtc'
                    ? {
                        typeId: config.messagesRtcTypeId,
                        topicId: config.messagesRtcTopicId
                    }
                    : {})
            },
            timeoutMs: 45_000
        },
        timeoutMs: 60_000
    });
    return {
        commandId,
        sessionId: input.control.requireSessionId(result, commandId)
    };
}

async function configureMeshTopology(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: GroupLifecycleCommandInput
): Promise<string> {
    const commandId = `topology-mesh-${input.suffix}`;
    await input.control.executeOk({
        ...input,
        agentId: input.owner.agentId,
        commandId,
        command: {
            kind: 'http.request',
            request: {
                path: groupRequestPath(
                    config,
                    input.groupId,
                    `topology/config/requests/${encodeURIComponent(`topology-mesh-${input.suffix}`)}`
                ),
                method: 'PUT',
                body: {
                    config: {
                        topologyKind: 'mesh',
                        degreeLimit: 2
                    }
                }
            },
            response: {
                body: 'json',
                acceptedStatusCodes: [200]
            },
            timeoutMs: 10_000
        }
    });
    return commandId;
}

async function enterGroupConnectionCycle(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: GroupLifecycleCommandInput
): Promise<readonly string[]> {
    const readCommandId = `group-lifecycle-read-${input.suffix}`;
    const current = await input.control.executeOk({
        ...input,
        agentId: input.owner.agentId,
        commandId: readCommandId,
        command: groupReadCommand(config, input.groupId),
        timeoutMs: 15_000
    });
    const lifecycleState = readFormationEntryLifecycleState(
        input.control.resultValue(current)
    );
    const operation = lifecycleState === 'forming' ? 'establish' : 'reopen';
    const commandId = `group-${operation}-${input.suffix}`;
    await input.control.executeOk({
        ...input,
        agentId: input.owner.agentId,
        commandId,
        command: {
            kind: 'http.request',
            request: {
                path: groupRequestPath(
                    config,
                    input.groupId,
                    `lifecycle/${operation}/requests/${encodeURIComponent(`${operation}-${input.suffix}`)}`
                ),
                method: 'POST',
                body: {}
            },
            response: {
                body: 'json',
                acceptedStatusCodes: [200]
            }
        }
    });
    return [readCommandId, commandId];
}

async function activateAndRefreshAcceptedLayout(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: ActivateGroupInput
): Promise<string> {
    const transport = input.transport.replace('.', '-');
    const commandId = `group-activate-${transport}-${input.suffix}`;
    await input.control.executeOk({
        ...input,
        agentId: input.owner.agentId,
        commandId,
        command: {
            kind: 'http.request',
            request: {
                path: groupRequestPath(
                    config,
                    input.groupId,
                    `lifecycle/activate/requests/${encodeURIComponent(`activate-${transport}-${input.suffix}`)}`
                ),
                method: 'POST',
                body: {}
            },
            response: {
                body: 'json',
                acceptedStatusCodes: [200]
            }
        }
    });
    await refreshAgentRooms(input.agents);
    return commandId;
}

async function refreshAgentRooms(
    agents: readonly [LiveRtcControlClient.Agent, LiveRtcControlClient.Agent, LiveRtcControlClient.Agent]
): Promise<void> {
    await Promise.all(agents.map((agent) =>
        agent.page.evaluate(async () => {
            const runtime = (window as Window & {
                __blackBoxRallar?: {
                    refreshRoom(options: { timeoutMs: number; }): Promise<void>;
                };
            }).__blackBoxRallar;
            if (!runtime) {
                throw new Error('Browser Rallar runtime is unavailable.');
            }
            await runtime.refreshRoom({ timeoutMs: 15_000 });
        })
    ));
}

async function waitForPlannedLayout(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: WaitForPlannedLayoutInput
): Promise<readonly string[]> {
    let attempt = 0;
    const commandIds: string[] = [];
    await expect.poll(async () => {
        const commandId = `topology-planned-${input.suffix}-${attempt++}`;
        commandIds.push(commandId);
        const result = await input.control.executeResult({
            ...input,
            agentId: input.owner.agentId,
            commandId,
            command: topologyReadCommand(config, input.groupId),
            timeoutMs: 15_000
        }).catch(() => undefined);
        if (!result?.ok) {
            return [];
        }
        return readPlannedSessionIds(input.control.resultValue(result));
    }, {
        message: `Expected planned topology to contain ${input.expectedSessionIds.join(', ')}`,
        timeout: 30_000
    }).toEqual(expect.arrayContaining([...input.expectedSessionIds]));
    return commandIds;
}

async function waitForPresenceRevision(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: WaitForPresenceRevisionInput
): Promise<readonly string[]> {
    let attempt = 0;
    const commandIds: string[] = [];
    await expect.poll(async () => {
        const commandId = `group-presence-${input.suffix}-${input.minimumRevision}-${attempt++}`;
        commandIds.push(commandId);
        const result = await input.control.executeResult({
            ...input,
            agentId: input.owner.agentId,
            commandId,
            command: groupReadCommand(config, input.groupId),
            timeoutMs: 15_000
        }).catch(() => undefined);
        if (!result?.ok) {
            return -1;
        }
        return readPresenceRevision(input.control.resultValue(result)) ?? -1;
    }, {
        message: `Expected presence revision ${input.minimumRevision} for ${input.groupId}`,
        timeout: 30_000
    }).toBeGreaterThanOrEqual(input.minimumRevision);
    return commandIds;
}

async function waitForFormationReadiness(
    input: WaitForFormationReadinessInput
): Promise<Readonly<Partial<Record<AgentPrefix, number>>>> {
    const agents = input.run.readinessScope === 'owner'
        ? [input.run.agents[0]]
        : input.run.agents;
    const durations = await Promise.all(agents.map(async (agent) => ({
        prefix: agent.prefix,
        durationMs: await input.run.control.waitForPeerReadiness({
            runId: input.run.runId,
            agent,
            expectedPeerIds: input.run.agents
                .filter((candidate) => candidate.agentId !== agent.agentId)
                .map((candidate) => input.sessions[candidate.prefix]),
            suffix: input.suffix,
            startedAtMs: input.startedAtMs
        })
    })));
    return Object.fromEntries(
        durations.map(({ prefix, durationMs }) => [prefix, durationMs])
    );
}

function topologyReadCommand(
    config: CreateGroupFormationLifecycleDriverConfig,
    groupId: string
): RallarBlackBoxTestCommand {
    return {
        kind: 'http.request',
        request: {
            path: groupRequestPath(config, groupId, 'topology'),
            method: 'GET'
        },
        response: {
            body: 'json',
            acceptedStatusCodes: [200]
        }
    };
}

function groupReadCommand(
    config: CreateGroupFormationLifecycleDriverConfig,
    groupId: string
): RallarBlackBoxTestCommand {
    return {
        kind: 'http.request',
        request: {
            path: groupRequestPath(config, groupId),
            method: 'GET'
        },
        response: {
            body: 'json',
            acceptedStatusCodes: [200]
        }
    };
}

function groupRequestPath(
    config: CreateGroupFormationLifecycleDriverConfig,
    groupId: string,
    suffix?: string
): string {
    const groupPath = `/api/state/apps/${encodeURIComponent(config.applicationId)}/workspaces/${
        encodeURIComponent(config.workspaceId)
    }/groups/${encodeURIComponent(groupId)}`;
    return suffix ? `${groupPath}/${suffix}` : groupPath;
}

function readPlannedSessionIds(value: Readonly<Record<string, RtcBaselineJson>>): readonly string[] {
    const body = jsonRecord(value.body);
    const snapshot = jsonRecord(body.snapshot);
    return stringArrayValue(snapshot.activeSessionIds);
}

function readPresenceRevision(value: Readonly<Record<string, RtcBaselineJson>>): number | undefined {
    const body = jsonRecord(value.body);
    const revision = jsonRecord(body.causalRevision).presenceRevision;
    return typeof revision === 'number' ? revision : undefined;
}

function readFormationEntryLifecycleState(
    value: Readonly<Record<string, RtcBaselineJson>>
): FormationEntryLifecycleState {
    const body = jsonRecord(value.body);
    const lifecycleState = jsonRecord(body.group).lifecycleState;
    if (lifecycleState === 'forming' || lifecycleState === 'active') {
        return lifecycleState;
    }
    throw new Error(`Expected forming or active group lifecycle state; received ${String(lifecycleState)}`);
}

function jsonRecord(value: RtcBaselineJson | undefined): Readonly<Record<string, RtcBaselineJson>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : {};
}

function stringArrayValue(value: RtcBaselineJson | undefined): readonly string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : [];
}

async function setupGroupMembership(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: Readonly<{
        control: LiveRtcControlPort;
        runId: string;
        owner: LiveRtcControlClient.Agent;
        members: readonly LiveRtcControlClient.Agent[];
        groupId: string;
        suffix: string;
    }>
): Promise<readonly string[]> {
    const groupSegment = encodeURIComponent(input.groupId);
    const createCommandId = `group-create-${input.suffix}`;
    const createRequestId = `rtc-b06-create-${input.suffix}`;
    const joinCommandIds: string[] = [];

    await input.control.executeOk({
        runId: input.runId,
        agentId: input.owner.agentId,
        commandId: createCommandId,
        command: toGroupCreationCommand(config, input)
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
                    path: `/api/state/apps/${encodeURIComponent(config.applicationId)}/workspaces/${
                        encodeURIComponent(config.workspaceId)
                    }/groups/${groupSegment}/members/{auth.clientId}/requests/${encodeURIComponent(requestId)}`,
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
function toGroupCreationCommand(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: Parameters<typeof setupGroupMembership>[1]
): RallarBlackBoxTestCommand {
    return {
        kind: 'http.request',
        request: {
            path: `/api/state/apps/${encodeURIComponent(config.applicationId)}/workspaces/${
                encodeURIComponent(config.workspaceId)
            }/groups/requests/${encodeURIComponent(`rtc-b06-create-${input.suffix}`)}`,
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
    };
}
