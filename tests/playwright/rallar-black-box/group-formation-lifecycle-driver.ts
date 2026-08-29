// dprint-ignore
import {
    expect,
    type APIRequestContext,
    type Page
} from '@playwright/test';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/types.ts';

type TransportUnderTest = 'realtime' | 'messages.rtc';
type AgentPrefix = 'A' | 'B' | 'C';
type ReadinessScope = 'owner' | 'all';

interface FormationAgent {
    readonly page: Page;
    readonly prefix: AgentPrefix;
    readonly agentId: string;
    readonly actor: string;
    readonly connection: string;
}

interface FormationControlResult {
    readonly ok: boolean;
    readonly failureDetails: string;
    readonly sessionId?: string;
    readonly plannedSessionIds: readonly string[];
    readonly presenceRevision?: number;
    readonly readyPeerIds: readonly string[];
}

interface ExecuteControlCommandInput {
    readonly request: APIRequestContext;
    readonly runId: string;
    readonly agentId: string;
    readonly commandId: string;
    readonly command: RallarBlackBoxTestCommand;
    readonly timeout?: number;
}

interface CreateGroupFormationLifecycleDriverConfig {
    readonly apiBaseUrl: string | undefined;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly messagesRtcTypeId: string;
    readonly messagesRtcTopicId: string;
    readonly executeResult: (
        input: ExecuteControlCommandInput
    ) => Promise<FormationControlResult>;
}

interface RunGroupFormationLifecycleInput {
    readonly request: APIRequestContext;
    readonly runId: string;
    readonly agents: readonly [FormationAgent, FormationAgent, FormationAgent];
    readonly transport: TransportUnderTest;
    readonly groupId: string;
    readonly suffix: string;
    readonly readinessScope: ReadinessScope;
}

interface GroupFormationLifecycleRun {
    readonly commandIds: readonly string[];
    readonly sessions: Readonly<Record<AgentPrefix, string>>;
}

interface ReconnectFormationAgentInput {
    readonly request: APIRequestContext;
    readonly runId: string;
    readonly reconnectingAgent: FormationAgent;
    readonly readinessAgent: FormationAgent;
    readonly transport: TransportUnderTest;
    readonly groupId: string;
    readonly suffix: string;
}

interface GroupFormationLifecycleDriver {
    run(
        input: RunGroupFormationLifecycleInput
    ): Promise<GroupFormationLifecycleRun>;
    reconnectAndWaitForPeerReadiness(
        input: ReconnectFormationAgentInput
    ): Promise<FormationAgentConnection>;
}

interface ConnectFormationAgentInput {
    readonly request: APIRequestContext;
    readonly runId: string;
    readonly agent: FormationAgent;
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
}

interface EstablishGroupLifecycleInput {
    readonly run: RunGroupFormationLifecycleInput;
    readonly sessions: Readonly<Record<AgentPrefix, string>>;
    readonly lifecycleSuffix: string;
}

interface GroupLifecycleCommandInput {
    readonly request: APIRequestContext;
    readonly runId: string;
    readonly owner: FormationAgent;
    readonly groupId: string;
    readonly suffix: string;
}

interface ActivateGroupInput extends GroupLifecycleCommandInput {
    readonly agents: readonly [FormationAgent, FormationAgent, FormationAgent];
    readonly transport: TransportUnderTest;
}

interface WaitForPlannedLayoutInput extends GroupLifecycleCommandInput {
    readonly expectedSessionIds: readonly string[];
}

interface WaitForPresenceRevisionInput extends GroupLifecycleCommandInput {
    readonly minimumRevision: number;
}

interface WaitForPeerReadinessInput {
    readonly request: APIRequestContext;
    readonly runId: string;
    readonly agent: FormationAgent;
    readonly expectedPeerIds: readonly string[];
    readonly suffix: string;
}

interface WaitForFormationReadinessInput {
    readonly run: RunGroupFormationLifecycleInput;
    readonly sessions: Readonly<Record<AgentPrefix, string>>;
    readonly suffix: string;
}

export function createGroupFormationLifecycleDriver(
    config: CreateGroupFormationLifecycleDriverConfig
): GroupFormationLifecycleDriver {
    return {
        run: async (input) => await runGroupFormationLifecycle(config, input),
        reconnectAndWaitForPeerReadiness: async (input) => {
            const connection = await connectFormationAgent(config, {
                request: input.request,
                runId: input.runId,
                agent: input.reconnectingAgent,
                transport: input.transport,
                groupId: input.groupId,
                suffix: input.suffix
            });
            await waitForPeerReadiness(config, {
                request: input.request,
                runId: input.runId,
                agent: input.readinessAgent,
                expectedPeerIds: [connection.sessionId],
                suffix: input.suffix
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
    const lifecycleCommandIds = await establishGroupLifecycle(config, {
        run: input,
        sessions,
        lifecycleSuffix
    });
    return {
        commandIds: [
            ...formationConnections.connectResults.map((result) => result.commandId),
            ...formationConnections.presenceCommandIds,
            ...lifecycleCommandIds
        ],
        sessions
    };
}

async function establishGroupLifecycle(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: EstablishGroupLifecycleInput
): Promise<readonly string[]> {
    const owner = input.run.agents[0];
    const topologyCommandId = await configureMeshTopology(config, {
        ...input.run,
        owner,
        suffix: input.lifecycleSuffix
    });
    const establishCommandId = await beginGroupConnection(config, {
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
    await waitForFormationReadiness(
        config,
        {
            run: input.run,
            sessions: input.sessions,
            suffix: input.lifecycleSuffix
        }
    );
    const activateCommandId = await activateAndRefreshAcceptedLayout(config, {
        ...input.run,
        owner,
        agents: input.run.agents
    });

    return [
        topologyCommandId,
        establishCommandId,
        ...plannedLayoutCommandIds,
        activateCommandId
    ];
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
        presenceCommandIds: [...presenceA, ...presenceB, ...presenceC]
    };
}

async function connectFormationAgent(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: ConnectFormationAgentInput
): Promise<FormationAgentConnection> {
    const transport = input.transport.replace('.', '-');
    const commandId = `connect-${input.agent.prefix.toLowerCase()}-${transport}-${input.suffix}`;
    const result = await executeOk(config, {
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
        timeout: 60_000
    });
    return {
        commandId,
        sessionId: requireSessionId(result.sessionId, commandId)
    };
}

async function configureMeshTopology(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: GroupLifecycleCommandInput
): Promise<string> {
    const commandId = `topology-mesh-${input.suffix}`;
    await executeOk(config, {
        ...input,
        agentId: input.owner.agentId,
        commandId,
        command: {
            kind: 'http.request',
            request: {
                path: groupRequestPath(
                    config,
                    input.groupId,
                    `topology/config/requests/${pathSegment(`topology-mesh-${input.suffix}`)}`
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

async function beginGroupConnection(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: GroupLifecycleCommandInput
): Promise<string> {
    const commandId = `group-establish-${input.suffix}`;
    await executeOk(config, {
        ...input,
        agentId: input.owner.agentId,
        commandId,
        command: {
            kind: 'http.request',
            request: {
                path: groupRequestPath(
                    config,
                    input.groupId,
                    `lifecycle/establish/requests/${pathSegment(`establish-${input.suffix}`)}`
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
    return commandId;
}

async function activateAndRefreshAcceptedLayout(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: ActivateGroupInput
): Promise<string> {
    const transport = input.transport.replace('.', '-');
    const commandId = `group-activate-${transport}-${input.suffix}`;
    await executeOk(config, {
        ...input,
        agentId: input.owner.agentId,
        commandId,
        command: {
            kind: 'http.request',
            request: {
                path: groupRequestPath(
                    config,
                    input.groupId,
                    `lifecycle/activate/requests/${pathSegment(`activate-${transport}-${input.suffix}`)}`
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
    agents: readonly [FormationAgent, FormationAgent, FormationAgent]
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
        const result = await config.executeResult({
            ...input,
            agentId: input.owner.agentId,
            commandId,
            command: topologyReadCommand(config, input.groupId),
            timeout: 15_000
        }).catch(() => undefined);
        if (!result?.ok) {
            return [];
        }
        return result.plannedSessionIds;
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
        const result = await config.executeResult({
            ...input,
            agentId: input.owner.agentId,
            commandId,
            command: groupReadCommand(config, input.groupId),
            timeout: 15_000
        }).catch(() => undefined);
        if (!result?.ok) {
            return -1;
        }
        return result.presenceRevision ?? -1;
    }, {
        message: `Expected presence revision ${input.minimumRevision} for ${input.groupId}`,
        timeout: 30_000
    }).toBeGreaterThanOrEqual(input.minimumRevision);
    return commandIds;
}

async function waitForFormationReadiness(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: WaitForFormationReadinessInput
): Promise<void> {
    const agents = input.run.readinessScope === 'owner'
        ? [input.run.agents[0]]
        : input.run.agents;
    await Promise.all(agents.map((agent) =>
        waitForPeerReadiness(config, {
            ...input.run,
            agent,
            expectedPeerIds: input.run.agents
                .filter((candidate) => candidate.agentId !== agent.agentId)
                .map((candidate) => input.sessions[candidate.prefix]),
            suffix: input.suffix
        })
    ));
}

async function waitForPeerReadiness(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: WaitForPeerReadinessInput
): Promise<void> {
    let attempt = 0;
    await expect.poll(async () => {
        const result = await config.executeResult({
            ...input,
            agentId: input.agent.agentId,
            commandId: `health-ready-${input.agent.prefix.toLowerCase()}-${input.suffix}-${attempt++}`,
            command: { kind: 'health' },
            timeout: 15_000
        }).catch(() => undefined);
        if (!result?.ok) {
            return [];
        }
        return result.readyPeerIds;
    }, {
        message: `Expected ${input.agent.agentId} to see ready peers ${
            input.expectedPeerIds.join(', ')
        } for ${input.suffix}`,
        timeout: 60_000
    }).toEqual(expect.arrayContaining([...input.expectedPeerIds]));
}

async function executeOk(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: ExecuteControlCommandInput
): Promise<FormationControlResult> {
    const result = await config.executeResult(input);
    expect(
        result.ok,
        `Expected command ${input.commandId} for agent ${input.agentId} to succeed: ${result.failureDetails}`
    ).toBe(true);
    return result;
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
    const groupPath = `/api/state/apps/${pathSegment(config.applicationId)}/workspaces/${
        pathSegment(config.workspaceId)
    }/groups/${pathSegment(groupId)}`;
    return suffix ? `${groupPath}/${suffix}` : groupPath;
}

function requireSessionId(
    sessionId: string | undefined,
    commandId: string
): string {
    if (!sessionId) {
        throw new Error(`Connect result ${commandId} did not include a sessionId.`);
    }
    return sessionId;
}

function pathSegment(value: string): string {
    return encodeURIComponent(value);
}
