// dprint-ignore
import {
    expect,
    type Page
} from '@playwright/test';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
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
    readonly control: GroupFormationLifecycleControl;
    readonly runId: string;
    readonly agents: readonly [GroupFormationLifecycleAgent, GroupFormationLifecycleAgent, GroupFormationLifecycleAgent];
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
    readonly control: GroupFormationLifecycleControl;
    readonly runId: string;
    readonly reconnectingAgent: GroupFormationLifecycleAgent;
    readonly readinessAgent: GroupFormationLifecycleAgent;
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
    readonly control: GroupFormationLifecycleControl;
    readonly runId: string;
    readonly agent: GroupFormationLifecycleAgent;
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

interface ConnectedGroupLifecycle {
    readonly commandIds: readonly string[];
    readonly readinessDurations: Readonly<Partial<Record<AgentPrefix, number>>>;
}

interface ConnectGroupLifecycleInput {
    readonly run: RunGroupFormationLifecycleInput;
    readonly sessions: Readonly<Record<AgentPrefix, string>>;
    readonly lifecycleSuffix: string;
}

interface LifecycleStageReceipt {
    readonly commandIds: readonly string[];
    readonly formationEpoch: number;
    readonly groupRevision: number;
}

interface PublishedGroupLayout {
    readonly commandIds: readonly string[];
    readonly identity: GroupLayoutIdentity;
}

interface GroupLifecycleCommandInput {
    readonly control: GroupFormationLifecycleControl;
    readonly runId: string;
    readonly owner: GroupFormationLifecycleAgent;
    readonly groupId: string;
    readonly suffix: string;
}

interface ActivateGroupInput extends GroupLifecycleCommandInput {
    readonly agents: readonly [GroupFormationLifecycleAgent, GroupFormationLifecycleAgent, GroupFormationLifecycleAgent];
    readonly transport: TransportUnderTest;
}

interface WaitForPlannedLayoutInput extends GroupLifecycleCommandInput {
    readonly expectedSessionIds: readonly string[];
    readonly expectedFormationEpoch: number;
    readonly expectedGroupRevision: number;
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

interface GroupFormationLifecycleControl {
    executeResult(
        input: LiveRtcControlClient.ExecuteInput
    ): Promise<LiveRtcControlClient.Result>;
    executeOk(
        input: LiveRtcControlClient.ExecuteInput
    ): Promise<LiveRtcControlClient.Result>;
    resultValue(
        result: LiveRtcControlClient.Result
    ): { [key: string]: RtcBaselineJson; };
    requireSessionId(
        result: LiveRtcControlClient.Result,
        commandId: string
    ): string;
    waitForPeerReadiness(
        input: GroupFormationLifecycleReadinessInput
    ): Promise<number>;
}

interface GroupFormationLifecycleAgent {
    readonly prefix: AgentPrefix;
    readonly agentId: string;
    readonly actor: string;
    readonly connection: string;
    readonly page: Readonly<{
        evaluate(pageFunction: () => Promise<void>): Promise<void>;
    }>;
}

interface GroupFormationLifecycleReadinessInput {
    readonly runId: string;
    readonly agent: GroupFormationLifecycleAgent;
    readonly expectedPeerIds: readonly string[];
    readonly suffix: string;
    readonly startedAtMs: number;
}

export function createGroupFormationLifecycleDriver(
    config: CreateGroupFormationLifecycleDriverConfig
): GroupFormationLifecycleDriver {
    return {
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
    const lifecycle = await connectGroupLifecycle(config, {
        run: input,
        sessions,
        lifecycleSuffix,
        readinessStartedAtMs: formationConnections.readinessStartedAtMs
    });
    return {
        commandIds: [
            ...formationConnections.connectResults.map((result) => result.commandId),
            ...formationConnections.presenceCommandIds,
            ...lifecycle.commandIds
        ],
        sessions,
        readinessDurations: lifecycle.readinessDurations
    };
}

async function connectGroupLifecycle(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: ConnectGroupLifecycleInput & Readonly<{ readinessStartedAtMs: number; }>
): Promise<ConnectedGroupLifecycle> {
    const owner = input.run.agents[0];
    const topologyCommandId = await configureMeshTopology(config, {
        ...input.run,
        owner,
        suffix: input.lifecycleSuffix
    });
    const stageReceipt = await enterGroupConnectionCycle(config, {
        ...input.run,
        owner,
        suffix: input.lifecycleSuffix
    });
    const plannedLayout = await waitForPlannedLayout(config, {
        ...input.run,
        owner,
        suffix: input.lifecycleSuffix,
        expectedSessionIds: Object.values(input.sessions),
        expectedFormationEpoch: stageReceipt.formationEpoch,
        expectedGroupRevision: stageReceipt.groupRevision
    });
    const connectCommandId = await connectPublishedLayout(config, {
        ...input.run,
        owner,
        suffix: input.lifecycleSuffix,
        expectedFormationEpoch: stageReceipt.formationEpoch,
        expectedLayout: plannedLayout.identity
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
            ...stageReceipt.commandIds,
            ...plannedLayout.commandIds,
            connectCommandId,
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

async function enterGroupConnectionCycle(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: GroupLifecycleCommandInput
): Promise<LifecycleStageReceipt> {
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
    const operation = lifecycleState === 'forming' ? 'plan' : 'reconfigure';
    const commandId = `group-${operation}-${input.suffix}`;
    const result = await input.control.executeOk({
        ...input,
        agentId: input.owner.agentId,
        commandId,
        command: {
            kind: 'http.request',
            request: {
                path: groupRequestPath(
                    config,
                    input.groupId,
                    `lifecycle/${operation}/requests/${pathSegment(`${operation}-${input.suffix}`)}`
                ),
                method: 'POST',
                body: operation === 'reconfigure' ? { landing: 'hold' } : {}
            },
            response: {
                body: 'json',
                acceptedStatusCodes: [200]
            }
        }
    });
    return {
        commandIds: [readCommandId, commandId],
        ...readLifecycleStageReceipt(input.control.resultValue(result), commandId)
    };
}

async function connectPublishedLayout(
    config: CreateGroupFormationLifecycleDriverConfig,
    input: GroupLifecycleCommandInput & Readonly<{
        expectedFormationEpoch: number;
        expectedLayout: GroupLayoutIdentity;
    }>
): Promise<string> {
    const commandId = `group-connect-${input.suffix}`;
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
                    `lifecycle/connect/requests/${pathSegment(`connect-${input.suffix}`)}`
                ),
                method: 'POST',
                body: {
                    expectedFormationEpoch: input.expectedFormationEpoch,
                    expectedLayout: input.expectedLayout
                }
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
    agents: readonly [GroupFormationLifecycleAgent, GroupFormationLifecycleAgent, GroupFormationLifecycleAgent]
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
): Promise<PublishedGroupLayout> {
    let attempt = 0;
    const commandIds: string[] = [];
    let plannedLayout: GroupLayoutIdentity | undefined;
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
            return false;
        }
        const candidate = readActivePublishedLayout(input.control.resultValue(result));
        if (
            candidate === undefined ||
            candidate.identity.groupRevision !== input.expectedGroupRevision ||
            !input.expectedSessionIds.every((sessionId) => candidate.sessionIds.includes(sessionId))
        ) {
            return false;
        }
        plannedLayout = candidate.identity;
        return true;
    }, {
        message: `Expected a fresh epoch ${input.expectedFormationEpoch} planned topology with ${input.expectedSessionIds.join(', ')}`,
        timeout: 30_000
    }).toBe(true);
    if (!plannedLayout) {
        throw new Error(`Planned layout did not resolve for formation epoch ${input.expectedFormationEpoch}.`);
    }
    return { commandIds, identity: plannedLayout };
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
    const groupPath = `/api/state/apps/${pathSegment(config.applicationId)}/workspaces/${
        pathSegment(config.workspaceId)
    }/groups/${pathSegment(groupId)}`;
    return suffix ? `${groupPath}/${suffix}` : groupPath;
}

function readActivePublishedLayout(
    value: Readonly<Record<string, RtcBaselineJson>>
): Readonly<{ sessionIds: readonly string[]; identity: GroupLayoutIdentity; }> | undefined {
    const body = jsonRecord(value.body);
    const snapshot = jsonRecord(body.snapshot);
    const sourceRevision = jsonRecord(snapshot.sourceGroupStateCausalRevision);
    const groupRevision = numberValue(sourceRevision.groupRevision);
    const presenceRevision = numberValue(sourceRevision.presenceRevision);
    const version = numberValue(snapshot.version);
    const state = snapshot.state;
    if (
        groupRevision === undefined ||
        presenceRevision === undefined ||
        version === undefined ||
        state !== 'active'
    ) {
        return undefined;
    }
    return {
        sessionIds: stringArrayValue(snapshot.activeSessionIds),
        identity: { groupRevision, presenceRevision, version, state }
    };
}

function readLifecycleStageReceipt(
    value: Readonly<Record<string, RtcBaselineJson>>,
    commandId: string
): Omit<LifecycleStageReceipt, 'commandIds'> {
    const body = jsonRecord(value.body);
    const group = jsonRecord(body.group);
    const causalRevision = jsonRecord(body.causalRevision);
    const formationEpoch = numberValue(group.formationEpoch);
    const groupRevision = numberValue(causalRevision.groupRevision);
    if (formationEpoch === undefined || groupRevision === undefined) {
        throw new Error(`Lifecycle command ${commandId} did not return its formation epoch and group revision.`);
    }
    return { formationEpoch, groupRevision };
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

function numberValue(value: RtcBaselineJson | undefined): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
}

function pathSegment(value: string): string {
    return encodeURIComponent(value);
}
