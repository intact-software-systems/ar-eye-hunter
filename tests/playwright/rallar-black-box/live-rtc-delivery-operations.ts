import { expect, type TestInfo } from '@playwright/test';
import { toError } from '@shared/resilience/to-error.ts';
import type { BlackBoxRallarSendInput } from '../../../packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import type {
    RallarBlackBoxTestRtcSendCommand,
    RallarBlackBoxTestWsSendCommand
} from '../../../packages/shared-test/rallar-bb-test/types.ts';
import {
    createGroupFormationLifecycleDriver,
    type GroupFormationLifecycleDriver,
    type LiveRtcControlPort
} from './create-group-formation-lifecycle-driver.ts';
import { openTab } from './full-stack-helpers.ts';
import type { LiveRtcControlClient } from './live-rtc-control-client.ts';
import type { LiveRtcPerformanceTiming } from './live-rtc-performance-evidence.ts';
import { hasLiveRtcNotYetInSyncNack } from './live-rtc-wire-observation.ts';

export type TransportUnderTest = 'realtime' | 'messages.rtc';
export type AgentPrefix = 'A' | 'B' | 'C';

export interface CreateLiveRtcDeliveryOperationsConfig {
    readonly apiBaseUrl: string | undefined;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly messagesRtcTypeId: string;
    readonly messagesRtcTopicId: string;
}

interface LiveRtcDeliveryRuntime extends CreateLiveRtcDeliveryOperationsConfig {
    readonly groupFormationLifecycleDriver: GroupFormationLifecycleDriver;
}

interface RunWebSocketOpenSendCloseMatrixInput {
    readonly control: LiveRtcControlPort;
    readonly runId: string;
    readonly agents: readonly LiveRtcControlClient.FormationAgent[];
    readonly groupId: string;
    readonly suffix: string;
}

interface RunAllDeliveryPermutationsInput {
    readonly control: LiveRtcControlPort;
    readonly runId: string;
    readonly agents: readonly [
        LiveRtcControlClient.FormationAgent,
        LiveRtcControlClient.FormationAgent,
        LiveRtcControlClient.FormationAgent
    ];
    readonly transport: TransportUnderTest;
    readonly groupId: string;
    readonly suffix: string;
}

interface RunDeliveryMatrixInput extends RunAllDeliveryPermutationsInput {
    readonly agents: readonly [LiveRtcControlClient.Agent, LiveRtcControlClient.Agent, LiveRtcControlClient.Agent];
}

interface RunDeliveryMatrixResult {
    readonly commandIds: readonly string[];
    readonly sessions: Readonly<Record<AgentPrefix, string>>;
    readonly scenarios: readonly LiveRtcControlClient.DeliveryScenario[];
    readonly timings: readonly LiveRtcPerformanceTiming[];
}

interface RtcFailureProbeInput {
    readonly control: LiveRtcControlPort;
    readonly runId: string;
    readonly agent: LiveRtcControlClient.Agent;
    readonly groupId: string;
    readonly suffix: string;
    readonly targetSessionId: string;
}

interface ReceivedNackProbeInput extends RtcFailureProbeInput {
    readonly control: LiveRtcControlPort & Pick<LiveRtcControlClient, 'requireSentMessageId' | 'recordReceivedNack'>;
    readonly testInfo: TestInfo;
    readonly senderSessionId: string;
}

interface CloseAndResetAgentsInput {
    readonly control: LiveRtcControlPort;
    readonly runId: string;
    readonly agents: readonly LiveRtcControlClient.FormationAgent[];
    readonly suffix: string;
}

interface CloseAndResetSettledAgentTrioInput extends CloseAndResetAgentsInput {
    readonly agents: readonly [
        LiveRtcControlClient.FormationAgent,
        LiveRtcControlClient.FormationAgent,
        LiveRtcControlClient.FormationAgent
    ];
    readonly sessions: Readonly<Record<AgentPrefix, string>>;
}

export interface LiveRtcDeliveryOperations {
    setupGroupMembership: GroupFormationLifecycleDriver['setupGroupMembership'];
    runGroupFormation: GroupFormationLifecycleDriver['run'];
    reconnectAndWaitForPeerReadiness: GroupFormationLifecycleDriver['reconnectAndWaitForPeerReadiness'];
    sendMatrixPayload(input: SendMatrixPayloadInput): Promise<string>;
    runWebSocketOpenSendCloseMatrix(input: RunWebSocketOpenSendCloseMatrixInput): Promise<readonly string[]>;
    runDeliveryMatrix(input: RunDeliveryMatrixInput): Promise<RunDeliveryMatrixResult>;
    runAllDeliveryPermutations(input: RunAllDeliveryPermutationsInput): Promise<RunDeliveryMatrixResult>;
    runNackProbe(input: ReceivedNackProbeInput): Promise<string>;
    expectClosedTransportFailure(input: RtcFailureProbeInput): Promise<readonly string[]>;
    closeAndResetAgents(input: CloseAndResetAgentsInput): Promise<readonly string[]>;
    closeAndResetSettledAgentTrio(input: CloseAndResetSettledAgentTrioInput): Promise<readonly string[]>;
}

interface LiveRtcMatrixPayload {
    readonly topic: string;
    readonly matrixId: string;
    readonly deliveryMode: string;
    readonly transport: TransportUnderTest;
    readonly runId: string;
    readonly groupId?: string;
}

interface SendMatrixPayloadInput {
    readonly control: LiveRtcControlPort;
    readonly runId: string;
    readonly sender: LiveRtcControlClient.FormationAgent;
    readonly transport: TransportUnderTest;
    readonly groupId: string;
    readonly suffix: string;
    readonly deliveryMode: 'direct' | 'multicast' | 'broadcast';
    readonly targetSessionIds?: readonly string[];
    readonly matrixId: string;
}

export function createLiveRtcDeliveryOperations(
    config: CreateLiveRtcDeliveryOperationsConfig
): LiveRtcDeliveryOperations {
    const runtime: LiveRtcDeliveryRuntime = {
        ...config,
        groupFormationLifecycleDriver: createGroupFormationLifecycleDriver(config)
    };
    return {
        setupGroupMembership: runtime.groupFormationLifecycleDriver.setupGroupMembership,
        runGroupFormation: runtime.groupFormationLifecycleDriver.run,
        reconnectAndWaitForPeerReadiness: runtime.groupFormationLifecycleDriver.reconnectAndWaitForPeerReadiness,
        sendMatrixPayload: (input) => sendMatrixPayload(runtime, input),
        runWebSocketOpenSendCloseMatrix: async (
            input: RunWebSocketOpenSendCloseMatrixInput
        ) => await runWebSocketOpenSendCloseMatrix(runtime, input),
        runDeliveryMatrix: async (input: RunDeliveryMatrixInput) => await runDeliveryMatrix(runtime, input),
        runAllDeliveryPermutations: async (
            input: RunAllDeliveryPermutationsInput
        ) => await runAllDeliveryPermutations(runtime, input),
        runNackProbe: async (input: ReceivedNackProbeInput) => await runNackProbe(runtime, input),
        expectClosedTransportFailure: async (
            input: RtcFailureProbeInput
        ) => await expectClosedTransportFailure(runtime, input),
        closeAndResetAgents,
        closeAndResetSettledAgentTrio
    };
}

function apiWebSocketUrl(apiBaseUrl: string | undefined): string {
    const url = new URL(apiBaseUrl ?? 'http://localhost:8080');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/api/ws/{auth.sessionId}';
    url.search = 'ticket={auth.wsTicket}';
    return url.toString();
}

function transportSlug(transport: TransportUnderTest): string {
    return transport.replace('.', '-');
}

interface SendPayloadInput {
    readonly transport: TransportUnderTest;
    readonly groupId: string;
    readonly targetSessionIds?: readonly string[];
    readonly payload: LiveRtcMatrixPayload;
    readonly minSnapshotVersion?: number;
}

function sendPayload(
    runtime: LiveRtcDeliveryRuntime,
    input: SendPayloadInput
): BlackBoxRallarSendInput {
    if (input.transport === 'messages.rtc') {
        return {
            roomId: input.groupId,
            ...(input.targetSessionIds
                ? { nextHopPeerIds: input.targetSessionIds }
                : {}),
            typeId: runtime.messagesRtcTypeId,
            topicId: runtime.messagesRtcTopicId,
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

interface ConfigureAgentForServerCommandsInput {
    readonly control: LiveRtcControlPort;
    readonly runId: string;
    readonly agent: LiveRtcControlClient.FormationAgent;
    readonly groupId: string;
    readonly suffix: string;
}

async function configureAgentForServerCommands(
    runtime: LiveRtcDeliveryRuntime,
    input: ConfigureAgentForServerCommandsInput
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
                apiBaseUrl: runtime.apiBaseUrl,
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
                    apiBaseUrl: runtime.apiBaseUrl,
                    restoreSession: true,
                    leaveRoomOnClose: false
                }
            }
        }
    });
    return commandId;
}

async function runWebSocketOpenSendCloseMatrix(
    runtime: LiveRtcDeliveryRuntime,
    input: RunWebSocketOpenSendCloseMatrixInput
): Promise<readonly string[]> {
    const commandIds: string[] = [];
    for (const agent of input.agents) {
        commandIds.push(
            await configureAgentForServerCommands(runtime, { ...input, agent })
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
                url: apiWebSocketUrl(runtime.apiBaseUrl),
                timeoutMs: 15_000
            },
            timeoutMs: 30_000
        });
        await input.control.executeOk({
            runId: input.runId,
            agentId: agent.agentId,
            commandId: sendCommandId,
            command: toWebSocketMatrixSendCommand(runtime, input, agent)
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

async function sendMatrixPayload(
    runtime: LiveRtcDeliveryRuntime,
    input: SendMatrixPayloadInput
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
            applicationId: runtime.applicationId,
            workspaceId: runtime.workspaceId,
            roomRef: {
                applicationId: runtime.applicationId,
                workspaceId: runtime.workspaceId,
                groupId: input.groupId
            },
            timeoutMs: 60_000,
            send: sendPayload(runtime, {
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

async function runDeliveryMatrix(
    runtime: LiveRtcDeliveryRuntime,
    input: RunDeliveryMatrixInput
): Promise<RunDeliveryMatrixResult> {
    const formation = await runtime.groupFormationLifecycleDriver.run({ ...input, readinessScope: 'owner' });
    const [sender, agentB, agentC] = input.agents;
    const cases: DeliveryCase[] = [
        { sender, receivers: [agentB], deliveryMode: 'direct', matrixId: `direct-${input.transport}-${input.suffix}` },
        {
            sender,
            receivers: [agentB, agentC],
            deliveryMode: 'multicast',
            matrixId: `multicast-${input.transport}-${input.suffix}`
        },
        {
            sender,
            receivers: [agentB, agentC],
            deliveryMode: 'broadcast',
            matrixId: `broadcast-${input.transport}-${input.suffix}`
        }
    ];
    const completed: CompletedDeliveryCase[] = [];
    for (const deliveryCase of cases) {
        completed.push(await runDeliveryCase(runtime, { run: input, sessions: formation.sessions, deliveryCase }));
        if (deliveryCase.deliveryMode === 'direct') {
            await observeVisibleInbox(agentB, deliveryCase.matrixId);
        }
        if (deliveryCase.deliveryMode === 'broadcast') {
            await observeVisibleInbox(agentC, deliveryCase.matrixId);
        }
    }
    if (input.transport === 'realtime') {
        const health = await input.control.executeOk({
            runId: input.runId,
            agentId: sender.agentId,
            commandId: `health-a-${input.suffix}`,
            command: { kind: 'health' }
        });
        expect(input.control.readyPeerIds(health)).toEqual(
            expect.arrayContaining([formation.sessions.B, formation.sessions.C])
        );
    }
    return {
        commandIds: [...formation.commandIds, ...completed.map((entry) => entry.commandId)],
        sessions: formation.sessions,
        scenarios: completed.map((entry) => entry.scenario),
        timings: [...toReadinessTimings(input, formation, 'owner'), ...completed.map((entry) => entry.timing)]
    };
}

async function runAllDeliveryPermutations(
    runtime: LiveRtcDeliveryRuntime,
    input: RunAllDeliveryPermutationsInput
): Promise<RunDeliveryMatrixResult> {
    const formation = await runtime.groupFormationLifecycleDriver.run({ ...input, readinessScope: 'all' });
    const slug = transportSlug(input.transport);
    const completed: CompletedDeliveryCase[] = [];
    for (const sender of input.agents) {
        const receivers = input.agents.filter((agent) => agent.agentId !== sender.agentId);
        const cases: DeliveryCase[] = receivers.map((receiver) => ({
            sender,
            receivers: [receiver],
            deliveryMode: 'direct',
            matrixId:
                `${slug}-direct-${sender.prefix.toLowerCase()}-to-${receiver.prefix.toLowerCase()}-${input.suffix}`
        }));
        for (const deliveryMode of ['multicast', 'broadcast'] as const) {
            cases.push({
                sender,
                receivers,
                deliveryMode,
                matrixId: `${slug}-${deliveryMode}-${sender.prefix.toLowerCase()}-${input.suffix}`
            });
        }
        for (const deliveryCase of cases) {
            completed.push(await runDeliveryCase(runtime, { run: input, sessions: formation.sessions, deliveryCase }));
        }
    }
    return {
        commandIds: [...formation.commandIds, ...completed.map((entry) => entry.commandId)],
        sessions: formation.sessions,
        scenarios: completed.map((entry) => entry.scenario),
        timings: [...toReadinessTimings(input, formation, 'all'), ...completed.map((entry) => entry.timing)]
    };
}

async function runNackProbe(
    runtime: LiveRtcDeliveryRuntime,
    input: ReceivedNackProbeInput
): Promise<string> {
    await input.agent.page.evaluate(() => {
        if (!window.__liveRtcWireObservation) {
            throw new Error('RTC wire observer is missing.');
        }
        window.__liveRtcWireObservation.start();
    });
    const commandId = `nack-not-yet-in-sync-${input.suffix}`;
    try {
        const result = await input.control.executeOk({
            runId: input.runId,
            agentId: input.agent.agentId,
            commandId,
            command: toNackProbeCommand(runtime, input),
            timeoutMs: 60_000
        });
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
        try {
            await input.agent.page.evaluate(() => window.__liveRtcWireObservation?.stop());
        }
        catch (cause) {
            console.error('Failed to stop live RTC NACK wire observation', toError(cause));
        }
    }
}

async function expectClosedTransportFailure(
    runtime: LiveRtcDeliveryRuntime,
    input: RtcFailureProbeInput
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
            send: sendPayload(runtime, {
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
    input: CloseAndResetAgentsInput
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
    input: CloseAndResetSettledAgentTrioInput
): Promise<readonly string[]> {
    const commandIds: string[] = [];
    const closeAndReset = async (
        agent: LiveRtcControlClient.FormationAgent
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

interface DeliveryCase {
    readonly sender: LiveRtcControlClient.FormationAgent;
    readonly receivers: readonly LiveRtcControlClient.FormationAgent[];
    readonly deliveryMode: 'direct' | 'multicast' | 'broadcast';
    readonly matrixId: string;
}
interface RunDeliveryCaseInput {
    readonly run: RunAllDeliveryPermutationsInput;
    readonly sessions: Readonly<Record<AgentPrefix, string>>;
    readonly deliveryCase: DeliveryCase;
}
interface CompletedDeliveryCase {
    readonly commandId: string;
    readonly scenario: LiveRtcControlClient.DeliveryScenario;
    readonly timing: LiveRtcPerformanceTiming;
}
async function runDeliveryCase(
    runtime: LiveRtcDeliveryRuntime,
    input: RunDeliveryCaseInput
): Promise<CompletedDeliveryCase> {
    const { sender, receivers, deliveryMode, matrixId } = input.deliveryCase;
    const startedAtMs = performance.now();
    const commandId = await sendMatrixPayload(runtime, {
        ...input.run,
        sender,
        deliveryMode,
        matrixId,
        targetSessionIds: deliveryMode === 'broadcast'
            ? undefined
            : receivers.map((receiver) => input.sessions[receiver.prefix])
    });
    const durations = await Promise.all(receivers.map((receiver) =>
        input.run.control.waitForMessage({
            runId: input.run.runId,
            senderAgentId: sender.agentId,
            agentId: receiver.agentId,
            transport: input.run.transport,
            matrixId,
            deliveryMode,
            startedAtMs
        })
    ));
    const receiverAgentIds = receivers.map((receiver) => receiver.agentId);
    return {
        commandId,
        scenario: {
            matrixId,
            transport: input.run.transport,
            deliveryMode,
            senderAgentId: sender.agentId,
            expectedAgentIds: receiverAgentIds,
            allowedAgentIds: deliveryMode === 'broadcast'
                ? input.run.agents.map((agent) => agent.agentId)
                : receiverAgentIds
        },
        timing: {
            kind: deliveryMode === 'direct'
                ? 'direct-delivery'
                : deliveryMode === 'multicast'
                ? 'multicast-delivery'
                : 'broadcast-delivery',
            transport: input.run.transport,
            senderAgentId: sender.agentId,
            receiverAgentIds,
            durationMs: Math.max(...durations)
        }
    };
}
async function observeVisibleInbox(agent: LiveRtcControlClient.Agent, matrixId: string): Promise<void> {
    await openTab(agent.page, 'manual-rallar', 'black-box-runner');
    await expect(agent.page.locator('#panel-manual-rallar .received-inbox-panel')).toContainText(matrixId, {
        timeout: 30_000
    });
}
function toReadinessTimings(
    input: RunAllDeliveryPermutationsInput,
    formation: Awaited<ReturnType<GroupFormationLifecycleDriver['run']>>,
    readinessScope: 'owner' | 'all'
): LiveRtcPerformanceTiming[] {
    const readinessAgents = readinessScope === 'owner' ? [input.agents[0]] : input.agents;
    return readinessAgents.map((agent) => {
        const durationMs = formation.readinessDurations[agent.prefix];
        if (durationMs === undefined) {
            throw new Error(`Readiness duration for agent ${agent.prefix} was not recorded.`);
        }
        return {
            kind: 'peer-ready',
            transport: input.transport,
            senderAgentId: agent.agentId,
            receiverAgentIds: input.agents.filter((candidate) => candidate.agentId !== agent.agentId).map((candidate) =>
                candidate.agentId
            ),
            durationMs
        };
    });
}
function toWebSocketMatrixSendCommand(
    runtime: LiveRtcDeliveryRuntime,
    input: RunWebSocketOpenSendCloseMatrixInput,
    agent: LiveRtcControlClient.FormationAgent
): RallarBlackBoxTestWsSendCommand {
    return {
        kind: 'ws.send',
        connection: `ws-${agent.prefix.toLowerCase()}-${input.suffix}`,
        data: {
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
                contextId: `${runtime.applicationId}:${runtime.workspaceId}:${input.groupId}`
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
        }
    };
}
function toNackProbeCommand(
    runtime: LiveRtcDeliveryRuntime,
    input: RtcFailureProbeInput
): RallarBlackBoxTestRtcSendCommand {
    return {
        kind: 'rtc.send',
        connection: `${input.agent.connection}-messages-rtc`,
        transport: 'messages.rtc',
        applicationId: runtime.applicationId,
        workspaceId: runtime.workspaceId,
        roomRef: {
            applicationId: runtime.applicationId,
            workspaceId: runtime.workspaceId,
            groupId: input.groupId
        },
        minSnapshotVersion: 9_999_999,
        timeoutMs: 45_000,
        send: sendPayload(runtime, {
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
    };
}
