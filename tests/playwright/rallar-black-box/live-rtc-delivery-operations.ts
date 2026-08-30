import { expect } from '@playwright/test';
import { openTab } from './full-stack-helpers.ts';
import { createGroupFormationLifecycleDriver } from './group-formation-lifecycle-driver.ts';
import type { LiveRtcControlClient, LiveRtcPerformanceTiming } from './live-rtc-performance-evidence.ts';

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
    readonly groupFormationLifecycleDriver: ReturnType<typeof createGroupFormationLifecycleDriver>;
}

interface RunWebSocketOpenSendCloseMatrixInput {
    readonly control: LiveRtcControlClient;
    readonly runId: string;
    readonly agents: readonly LiveRtcControlClient.Agent[];
    readonly groupId: string;
    readonly suffix: string;
}

interface RunDeliveryMatrixInput {
    readonly control: LiveRtcControlClient;
    readonly runId: string;
    readonly agents: readonly [
        LiveRtcControlClient.Agent,
        LiveRtcControlClient.Agent,
        LiveRtcControlClient.Agent
    ];
    readonly transport: TransportUnderTest;
    readonly groupId: string;
    readonly suffix: string;
}

interface RunDeliveryMatrixResult {
    readonly commandIds: readonly string[];
    readonly sessions: Readonly<Record<AgentPrefix, string>>;
    readonly scenarios: readonly LiveRtcControlClient.DeliveryScenario[];
    readonly timings: readonly LiveRtcPerformanceTiming[];
}

interface RtcFailureProbeInput {
    readonly control: LiveRtcControlClient;
    readonly runId: string;
    readonly agent: LiveRtcControlClient.Agent;
    readonly groupId: string;
    readonly suffix: string;
    readonly targetSessionId: string;
}

interface CloseAndResetAgentsInput {
    readonly control: LiveRtcControlClient;
    readonly runId: string;
    readonly agents: readonly LiveRtcControlClient.Agent[];
    readonly suffix: string;
}

interface CloseAndResetSettledAgentTrioInput extends CloseAndResetAgentsInput {
    readonly agents: readonly [
        LiveRtcControlClient.Agent,
        LiveRtcControlClient.Agent,
        LiveRtcControlClient.Agent
    ];
    readonly sessions: Readonly<Record<AgentPrefix, string>>;
}

export function createLiveRtcDeliveryOperations(
    config: CreateLiveRtcDeliveryOperationsConfig
) {
    const runtime: LiveRtcDeliveryRuntime = {
        ...config,
        groupFormationLifecycleDriver: createGroupFormationLifecycleDriver(config)
    };
    return {
        runWebSocketOpenSendCloseMatrix: async (
            input: RunWebSocketOpenSendCloseMatrixInput
        ) => await runWebSocketOpenSendCloseMatrix(runtime, input),
        runDeliveryMatrix: async (input: RunDeliveryMatrixInput) => await runDeliveryMatrix(runtime, input),
        runAllDeliveryPermutations: async (
            input: RunDeliveryMatrixInput
        ) => await runAllDeliveryPermutations(runtime, input),
        runNackProbe: async (input: RtcFailureProbeInput) => await runNackProbe(runtime, input),
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

function sendPayload(
    runtime: LiveRtcDeliveryRuntime,
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

async function configureAgentForServerCommands(
    runtime: LiveRtcDeliveryRuntime,
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
            command: {
                kind: 'ws.send',
                connection,
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

async function sendMatrixPayload(
    runtime: LiveRtcDeliveryRuntime,
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
    const formation = await runtime.groupFormationLifecycleDriver.run({
        control: input.control,
        runId: input.runId,
        agents: input.agents,
        transport: input.transport,
        groupId: input.groupId,
        suffix: input.suffix,
        readinessScope: 'owner'
    });
    const sessions = formation.sessions;

    const [agentA, agentB, agentC] = input.agents;
    const readinessDurationMs = formation.readinessDurations.A;
    if (readinessDurationMs === undefined) {
        throw new Error('Owner readiness duration was not recorded.');
    }
    const timings: LiveRtcPerformanceTiming[] = [{
        kind: 'peer-ready',
        transport: input.transport,
        senderAgentId: agentA.agentId,
        receiverAgentIds: [agentB.agentId, agentC.agentId],
        durationMs: readinessDurationMs
    }];

    const directMatrixId = `direct-${input.transport}-${input.suffix}`;
    const multicastMatrixId = `multicast-${input.transport}-${input.suffix}`;
    const broadcastMatrixId = `broadcast-${input.transport}-${input.suffix}`;
    const directStartedAtMs = performance.now();
    const sendDirect = await sendMatrixPayload(runtime, {
        ...input,
        sender: agentA,
        deliveryMode: 'direct',
        targetSessionIds: [sessions.B],
        matrixId: directMatrixId
    });
    const directDurationMs = await input.control.waitForMessage({
        runId: input.runId,
        agentId: agentB.agentId,
        transport: input.transport,
        matrixId: directMatrixId,
        deliveryMode: 'direct',
        startedAtMs: directStartedAtMs
    });
    timings.push({
        kind: 'direct-delivery',
        transport: input.transport,
        senderAgentId: agentA.agentId,
        receiverAgentIds: [agentB.agentId],
        durationMs: directDurationMs
    });
    await openTab(agentB.page, 'manual-rallar', 'black-box-runner');
    await expect(
        agentB.page.locator('#panel-manual-rallar .received-inbox-panel')
    )
        .toContainText(directMatrixId, { timeout: 30_000 });

    const multicastStartedAtMs = performance.now();
    const sendMulticast = await sendMatrixPayload(runtime, {
        ...input,
        sender: agentA,
        deliveryMode: 'multicast',
        targetSessionIds: [sessions.B, sessions.C],
        matrixId: multicastMatrixId
    });
    const multicastDurations = await Promise.all([
        input.control.waitForMessage({
            runId: input.runId,
            agentId: agentB.agentId,
            transport: input.transport,
            matrixId: multicastMatrixId,
            deliveryMode: 'multicast',
            startedAtMs: multicastStartedAtMs
        }),
        input.control.waitForMessage({
            runId: input.runId,
            agentId: agentC.agentId,
            transport: input.transport,
            matrixId: multicastMatrixId,
            deliveryMode: 'multicast',
            startedAtMs: multicastStartedAtMs
        })
    ]);
    timings.push({
        kind: 'multicast-delivery',
        transport: input.transport,
        senderAgentId: agentA.agentId,
        receiverAgentIds: [agentB.agentId, agentC.agentId],
        durationMs: Math.max(...multicastDurations)
    });

    const broadcastStartedAtMs = performance.now();
    const sendBroadcast = await sendMatrixPayload(runtime, {
        ...input,
        sender: agentA,
        deliveryMode: 'broadcast',
        matrixId: broadcastMatrixId
    });
    const broadcastDurations = await Promise.all([
        input.control.waitForMessage({
            runId: input.runId,
            agentId: agentB.agentId,
            transport: input.transport,
            matrixId: broadcastMatrixId,
            deliveryMode: 'broadcast',
            startedAtMs: broadcastStartedAtMs
        }),
        input.control.waitForMessage({
            runId: input.runId,
            agentId: agentC.agentId,
            transport: input.transport,
            matrixId: broadcastMatrixId,
            deliveryMode: 'broadcast',
            startedAtMs: broadcastStartedAtMs
        })
    ]);
    timings.push({
        kind: 'broadcast-delivery',
        transport: input.transport,
        senderAgentId: agentA.agentId,
        receiverAgentIds: [agentB.agentId, agentC.agentId],
        durationMs: Math.max(...broadcastDurations)
    });
    await openTab(agentC.page, 'manual-rallar', 'black-box-runner');
    await expect(
        agentC.page.locator('#panel-manual-rallar .received-inbox-panel')
    )
        .toContainText(broadcastMatrixId, { timeout: 30_000 });

    if (input.transport === 'realtime') {
        const healthA = await input.control.executeOk({
            runId: input.runId,
            agentId: agentA.agentId,
            commandId: `health-a-${input.suffix}`,
            command: { kind: 'health' }
        });
        expect(input.control.readyPeerIds(healthA)).toEqual(
            expect.arrayContaining([sessions.B, sessions.C])
        );
    }

    return {
        commandIds: [
            ...formation.commandIds,
            sendDirect,
            sendMulticast,
            sendBroadcast
        ],
        sessions,
        scenarios: [
            {
                matrixId: directMatrixId,
                transport: input.transport,
                deliveryMode: 'direct',
                senderAgentId: agentA.agentId,
                expectedAgentIds: [agentB.agentId],
                allowedAgentIds: [agentB.agentId]
            },
            {
                matrixId: multicastMatrixId,
                transport: input.transport,
                deliveryMode: 'multicast',
                senderAgentId: agentA.agentId,
                expectedAgentIds: [agentB.agentId, agentC.agentId],
                allowedAgentIds: [agentB.agentId, agentC.agentId]
            },
            {
                matrixId: broadcastMatrixId,
                transport: input.transport,
                deliveryMode: 'broadcast',
                senderAgentId: agentA.agentId,
                expectedAgentIds: [agentB.agentId, agentC.agentId],
                allowedAgentIds: input.agents.map((agent) => agent.agentId)
            }
        ],
        timings
    };
}

async function runAllDeliveryPermutations(
    runtime: LiveRtcDeliveryRuntime,
    input: RunDeliveryMatrixInput
): Promise<RunDeliveryMatrixResult> {
    const slug = transportSlug(input.transport);
    const formation = await runtime.groupFormationLifecycleDriver.run({
        control: input.control,
        runId: input.runId,
        agents: input.agents,
        transport: input.transport,
        groupId: input.groupId,
        suffix: input.suffix,
        readinessScope: 'all'
    });
    const sessions = formation.sessions;

    const commandIds = [...formation.commandIds];
    const scenarios: LiveRtcControlClient.DeliveryScenario[] = [];
    const timings: LiveRtcPerformanceTiming[] = input.agents.map((agent) => {
        const durationMs = formation.readinessDurations[agent.prefix];
        if (durationMs === undefined) {
            throw new Error(`Readiness duration for agent ${agent.prefix} was not recorded.`);
        }
        return {
            kind: 'peer-ready',
            transport: input.transport,
            senderAgentId: agent.agentId,
            receiverAgentIds: input.agents
                .filter((candidate) => candidate.agentId !== agent.agentId)
                .map((candidate) => candidate.agentId),
            durationMs
        };
    });

    for (const sender of input.agents) {
        const receivers = input.agents.filter(
            (agent) => agent.agentId !== sender.agentId
        );

        for (const receiver of receivers) {
            const matrixId =
                `${slug}-direct-${sender.prefix.toLowerCase()}-to-${receiver.prefix.toLowerCase()}-${input.suffix}`;
            const startedAtMs = performance.now();
            commandIds.push(
                await sendMatrixPayload(runtime, {
                    ...input,
                    sender,
                    deliveryMode: 'direct',
                    targetSessionIds: [sessions[receiver.prefix]],
                    matrixId
                })
            );
            const durationMs = await input.control.waitForMessage({
                runId: input.runId,
                agentId: receiver.agentId,
                transport: input.transport,
                matrixId,
                deliveryMode: 'direct',
                startedAtMs
            });
            timings.push({
                kind: 'direct-delivery',
                transport: input.transport,
                senderAgentId: sender.agentId,
                receiverAgentIds: [receiver.agentId],
                durationMs
            });
            scenarios.push({
                matrixId,
                transport: input.transport,
                deliveryMode: 'direct',
                senderAgentId: sender.agentId,
                expectedAgentIds: [receiver.agentId],
                allowedAgentIds: [receiver.agentId]
            });
        }

        const multicastMatrixId = `${slug}-multicast-${sender.prefix.toLowerCase()}-${input.suffix}`;
        const multicastStartedAtMs = performance.now();
        commandIds.push(
            await sendMatrixPayload(runtime, {
                ...input,
                sender,
                deliveryMode: 'multicast',
                targetSessionIds: receivers.map((receiver) => sessions[receiver.prefix]),
                matrixId: multicastMatrixId
            })
        );
        const multicastDurations = await Promise.all(
            receivers.map((receiver) =>
                input.control.waitForMessage({
                    runId: input.runId,
                    agentId: receiver.agentId,
                    transport: input.transport,
                    matrixId: multicastMatrixId,
                    deliveryMode: 'multicast',
                    startedAtMs: multicastStartedAtMs
                })
            )
        );
        timings.push({
            kind: 'multicast-delivery',
            transport: input.transport,
            senderAgentId: sender.agentId,
            receiverAgentIds: receivers.map((receiver) => receiver.agentId),
            durationMs: Math.max(...multicastDurations)
        });
        scenarios.push({
            matrixId: multicastMatrixId,
            transport: input.transport,
            deliveryMode: 'multicast',
            senderAgentId: sender.agentId,
            expectedAgentIds: receivers.map((receiver) => receiver.agentId),
            allowedAgentIds: receivers.map((receiver) => receiver.agentId)
        });

        const broadcastMatrixId = `${slug}-broadcast-${sender.prefix.toLowerCase()}-${input.suffix}`;
        const broadcastStartedAtMs = performance.now();
        commandIds.push(
            await sendMatrixPayload(runtime, {
                ...input,
                sender,
                deliveryMode: 'broadcast',
                matrixId: broadcastMatrixId
            })
        );
        const broadcastDurations = await Promise.all(
            receivers.map((receiver) =>
                input.control.waitForMessage({
                    runId: input.runId,
                    agentId: receiver.agentId,
                    transport: input.transport,
                    matrixId: broadcastMatrixId,
                    deliveryMode: 'broadcast',
                    startedAtMs: broadcastStartedAtMs
                })
            )
        );
        timings.push({
            kind: 'broadcast-delivery',
            transport: input.transport,
            senderAgentId: sender.agentId,
            receiverAgentIds: receivers.map((receiver) => receiver.agentId),
            durationMs: Math.max(...broadcastDurations)
        });
        scenarios.push({
            matrixId: broadcastMatrixId,
            transport: input.transport,
            deliveryMode: 'broadcast',
            senderAgentId: sender.agentId,
            expectedAgentIds: receivers.map((receiver) => receiver.agentId),
            allowedAgentIds: input.agents.map((agent) => agent.agentId)
        });
    }

    return {
        commandIds,
        sessions,
        scenarios,
        timings
    };
}

async function runNackProbe(
    runtime: LiveRtcDeliveryRuntime,
    input: RtcFailureProbeInput
): Promise<string> {
    const commandId = `nack-not-yet-in-sync-${input.suffix}`;
    const result = await input.control.executeResult({
        runId: input.runId,
        agentId: input.agent.agentId,
        commandId,
        command: {
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
        },
        timeoutMs: 60_000
    });
    const run = await input.control.fetchRun(input.runId);
    const evidence = JSON.stringify({
        result,
        events: run.events?.filter((event) => event.agentId === input.agent.agentId)
            .slice(-12)
    }).toLowerCase();
    expect(
        evidence.includes('not-yet-in-sync') ||
            evidence.includes('nack') ||
            (result.ok === true && evidence.includes('minsnapshotversion'))
    ).toBe(true);
    return commandId;
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
