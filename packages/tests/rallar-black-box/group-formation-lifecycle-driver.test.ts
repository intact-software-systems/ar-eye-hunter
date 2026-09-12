import { describe, expect, it, vi } from 'vitest';

import {
    createGroupFormationLifecycleDriver,
    type LiveRtcControlPort
} from '../../../tests/playwright/rallar-black-box/create-group-formation-lifecycle-driver.ts';
import type { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import type { LiveRtcJsonRecord } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';
import {
    createLiveRtcFormationOperations,
    type FormationReadiness,
    type LiveRtcFormationOperations
} from '../../../tests/playwright/rallar-black-box/live-rtc-formation-operations.ts';

function createAgent(
    prefix: LiveRtcControlClient.FormationAgent['prefix']
): LiveRtcControlClient.FormationAgent {
    return {
        prefix,
        agentId: `agent-${prefix.toLowerCase()}`,
        actor: `actor-${prefix.toLowerCase()}`,
        connection: `connection-${prefix.toLowerCase()}`,
        refreshRoom: async () => undefined
    };
}

function lifecycleOperation(
    command: LiveRtcControlClient.ExecuteInput
): string | undefined {
    return (
        command.command.kind === 'http.request'
            ? command.command.request.path
            : undefined
    )?.match(/\/lifecycle\/([^/]+)\//u)?.[1];
}

function successfulResult(
    input: LiveRtcControlClient.ExecuteInput,
    value: LiveRtcJsonRecord
): LiveRtcControlClient.Result {
    return {
        agentId: input.agentId,
        commandId: input.commandId,
        ok: true,
        result: { value }
    };
}

function readResultValue(
    result: LiveRtcControlClient.Result
): LiveRtcJsonRecord {
    const value = result.result?.value;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : {};
}

function canonicalFormationReadinessValue(
    agentId: string,
    omitExpectedPeer: boolean
): LiveRtcJsonRecord {
    const expectedPeerIdsByAgentId: Readonly<Record<string, readonly string[]>> = {
        'agent-a': ['session-b', 'session-c-next'],
        'agent-b': ['session-a', 'session-c-next'],
        'agent-c': ['session-a', 'session-b']
    };
    const desiredPeerIds = [...(expectedPeerIdsByAgentId[agentId] ?? [])];
    const readyPeerIds = omitExpectedPeer
        ? desiredPeerIds.slice(0, -1)
        : desiredPeerIds;
    return {
        readyAtEpochMs: 1,
        formation: {
            stage: 'active',
            room: {
                state: 'open',
                desiredPeerIds,
                readyPeerIds,
                acceptedLayoutIdentity: {
                    groupRevision: 1,
                    presenceRevision: 1,
                    version: 1,
                    state: 'active'
                }
            }
        }
    };
}

function canonicalFormationReadinessForSessions(
    agentId: string,
    sessionIds: readonly string[],
    roomRef: FormationReadiness['formation']['roomRef']
): FormationReadiness {
    const ownSessionId = `session-${agentId.slice(-1)}`;
    const desiredPeerIds = sessionIds.filter((sessionId) => sessionId !== ownSessionId);
    return {
        readyAtEpochMs: 1,
        formation: {
            roomRef,
            stage: 'active',
            formationEpoch: 1,
            formationAttemptCount: 1,
            causalRevision: { groupRevision: 1, presenceRevision: 1 },
            transportState: 'flowing',
            dialing: 'accepted',
            memberPolicy: {
                maxConcurrentEdgeSetups: 4,
                transports: 'rtc-and-ws'
            },
            room: {
                state: 'open',
                desiredPeerIds,
                readyPeerIds: desiredPeerIds,
                activePeerIds: desiredPeerIds,
                failedPeerIds: [],
                acceptedLayoutIdentity: {
                    groupRevision: 1,
                    presenceRevision: 1,
                    version: 1,
                    state: 'active'
                }
            }
        }
    };
}

describe('group formation lifecycle driver', () => {
    it('waits for exact current membership and accepts a newer active publication', async () => {
        const commands: LiveRtcControlClient.ExecuteInput[] = [];
        const peerReadinessAgents: string[] = [];
        const peerReadinessParticipantAgentIds: string[][] = [];
        const canonicalRoomReadinessAgents: string[] = [];
        const topologyStates: Array<'removed' | 'active'> = ['removed', 'active'];
        const activeSessionIds = [
            ['stale-session', 'session-a'],
            ['session-a'],
            ['session-a', 'session-b'],
            ['session-a', 'session-b', 'session-c']
        ];
        const control: LiveRtcControlPort = {
            executeOk: async (
                input: LiveRtcControlClient.ExecuteInput
            ): Promise<LiveRtcControlClient.Result> => {
                commands.push(input);
                if (input.command.kind === 'rtc.connect') {
                    return successfulResult(input, {
                        sessionId: `session-${input.agentId.slice(-1)}`
                    });
                }
                if (
                    input.command.kind === 'http.request' &&
                    input.command.request.path?.endsWith('/groups/group')
                ) {
                    return successfulResult(input, {
                        body: { group: { lifecycleState: 'forming' } }
                    });
                }
                if (lifecycleOperation(input) === 'plan') {
                    return successfulResult(input, {
                        body: {
                            group: { formationEpoch: 1 },
                            causalRevision: { groupRevision: 7 }
                        }
                    });
                }
                return successfulResult(input, {});
            },
            executeResult: async (
                input: LiveRtcControlClient.ExecuteInput
            ): Promise<LiveRtcControlClient.Result> => {
                commands.push(input);
                if (
                    input.command.kind === 'http.request' &&
                    input.command.request.path?.endsWith('/groups/group')
                ) {
                    return successfulResult(input, {
                        body: {
                            causalRevision: { presenceRevision: 40 },
                            activeSessions: (activeSessionIds.shift() ?? []).map(
                                (sessionId) => ({ sessionId })
                            )
                        }
                    });
                }
                return successfulResult(input, {
                    body: {
                        snapshot: {
                            sourceGroupStateCausalRevision: {
                                groupRevision: 8,
                                presenceRevision: 3
                            },
                            version: 4,
                            state: topologyStates.shift() ?? 'active',
                            activeSessionIds: ['session-a', 'session-b', 'session-c']
                        }
                    }
                });
            },
            resultValue: readResultValue,
            requireSessionId: (result: LiveRtcControlClient.Result) => {
                const sessionId = readResultValue(result).sessionId;
                if (typeof sessionId !== 'string' || sessionId.length === 0) {
                    throw new Error('Expected the formation agent session identifier.');
                }
                return sessionId;
            },
            readyPeerIds: () => [],
            recordReadinessFailure: async () => undefined,
            waitForMessage: async () => 1,
            waitForPeerAbsence: async () => undefined,
            waitForPeerReadiness: async (input) => {
                peerReadinessAgents.push(input.agent.agentId);
                peerReadinessParticipantAgentIds.push(
                    input.participantAgents.map((participant) => participant.agentId)
                );
                return 1;
            }
        };
        const formation: Pick<LiveRtcFormationOperations, 'readiness'> = {
            readiness: async (input) => {
                canonicalRoomReadinessAgents.push(input.agent.agentId);
                const sessionIds = input.suffix.includes('initial-pair')
                    ? ['session-a', 'session-b']
                    : ['session-a', 'session-b', 'session-c'];
                const desiredPeerIds = sessionIds.filter(
                    (sessionId) => sessionId !== `session-${input.agent.agentId.slice(-1)}`
                );
                return {
                    readyAtEpochMs: 1,
                    formation: {
                        roomRef: {
                            applicationId: 'application',
                            workspaceId: 'workspace',
                            groupId: input.roomRef.groupId
                        },
                        stage: 'active',
                        formationEpoch: 1,
                        formationAttemptCount: 1,
                        causalRevision: { groupRevision: 1, presenceRevision: 1 },
                        transportState: 'flowing',
                        dialing: 'accepted',
                        memberPolicy: {
                            maxConcurrentEdgeSetups: 4,
                            transports: 'rtc-and-ws'
                        },
                        room: {
                            state: 'open',
                            desiredPeerIds,
                            activePeerIds: desiredPeerIds,
                            readyPeerIds: desiredPeerIds,
                            failedPeerIds: [],
                            acceptedLayoutIdentity: {
                                groupRevision: 1,
                                presenceRevision: 1,
                                version: 1,
                                state: 'active'
                            }
                        }
                    }
                };
            }
        };
        const agents = [
            createAgent('A'),
            createAgent('B'),
            createAgent('C')
        ] as const;
        const driver = createGroupFormationLifecycleDriver({
            apiBaseUrl: 'http://api.test',
            applicationId: 'application',
            workspaceId: 'workspace',
            messagesRtcTypeId: 'type',
            messagesRtcTopicId: 'topic',
            formation
        });

        await driver.run({
            control,
            runId: 'run',
            agents,
            transport: 'realtime',
            groupId: 'group',
            suffix: 'removed-layout',
            readinessScope: 'owner'
        });

        const presenceReads = commands.filter((command) => command.commandId.startsWith('group-presence-'));
        const connectBIndex = commands.findIndex(
            (command) => command.agentId === 'agent-b' && command.command.kind === 'rtc.connect'
        );
        expect(presenceReads).toHaveLength(4);
        expect(commands.indexOf(presenceReads[1])).toBeLessThan(connectBIndex);
        expect(
            commands.find((command) => lifecycleOperation(command) === 'connect')
        ).toMatchObject({
            command: {
                request: {
                    body: {
                        expectedFormationEpoch: 1,
                        expectedLayout: {
                            groupRevision: 8,
                            presenceRevision: 3,
                            version: 4,
                            state: 'active'
                        }
                    }
                }
            }
        });
        expect(peerReadinessAgents).toEqual(['agent-a', 'agent-b']);
        expect(peerReadinessParticipantAgentIds).toEqual([
            ['agent-a', 'agent-b'],
            ['agent-a', 'agent-b']
        ]);
        expect(canonicalRoomReadinessAgents).toEqual([
            'agent-a',
            'agent-b',
            'agent-a',
            'agent-b',
            'agent-c'
        ]);
    });

    it.each([
        { failureStage: 'initial-pair' as const, participantAgentIds: ['agent-a', 'agent-b'] },
        { failureStage: 'full-formation' as const, participantAgentIds: ['agent-a', 'agent-b', 'agent-c'] }
    ])('owns the $failureStage readiness diagnostic recipients', async ({ failureStage, participantAgentIds }) => {
        const agents = [createAgent('A'), createAgent('B'), createAgent('C')] as const;
        const recordedFailures: LiveRtcControlClient.RecordReadinessFailureInput[] = [];
        const directReadinessParticipants: string[][] = [];
        const control: LiveRtcControlPort = {
            executeOk: async (input) => {
                if (input.command.kind === 'rtc.connect') {
                    return successfulResult(input, { sessionId: `session-${input.agentId.slice(-1)}` });
                }
                if (
                    input.command.kind === 'http.request' &&
                    input.command.request.path?.endsWith('/groups/group')
                ) {
                    return successfulResult(input, { body: { group: { lifecycleState: 'forming' } } });
                }
                if (lifecycleOperation(input) === 'plan') {
                    return successfulResult(input, {
                        body: {
                            group: { formationEpoch: 1 },
                            causalRevision: { groupRevision: 1 }
                        }
                    });
                }
                return successfulResult(input, {});
            },
            executeResult: async (input) => {
                if (
                    input.command.kind === 'http.request' &&
                    input.command.request.path?.endsWith('/groups/group')
                ) {
                    const expectedCount = Number(/-(\d+)-\d+$/u.exec(input.commandId)?.[1] ?? 0);
                    return successfulResult(input, {
                        body: {
                            activeSessions: ['session-a', 'session-b', 'session-c']
                                .slice(0, expectedCount)
                                .map((sessionId) => ({ sessionId }))
                        }
                    });
                }
                const sessionIds = input.commandId.includes('initial-pair')
                    ? ['session-a', 'session-b']
                    : ['session-a', 'session-b', 'session-c'];
                return successfulResult(input, {
                    body: {
                        snapshot: {
                            sourceGroupStateCausalRevision: {
                                groupRevision: 2,
                                presenceRevision: 2
                            },
                            version: 1,
                            state: 'active',
                            activeSessionIds: sessionIds
                        }
                    }
                });
            },
            resultValue: readResultValue,
            requireSessionId: (result) => String(readResultValue(result).sessionId),
            readyPeerIds: () => [],
            recordReadinessFailure: async (input) => {
                recordedFailures.push(input);
            },
            waitForMessage: async () => 1,
            waitForPeerAbsence: async () => undefined,
            waitForPeerReadiness: async (input) => {
                directReadinessParticipants.push(
                    input.participantAgents.map((participant) => participant.agentId)
                );
                return 1;
            }
        };
        const driver = createGroupFormationLifecycleDriver({
            apiBaseUrl: 'http://api.test',
            applicationId: 'application',
            workspaceId: 'workspace',
            messagesRtcTypeId: 'type',
            messagesRtcTopicId: 'topic',
            formation: {
                readiness: async (input) => {
                    const isInitialPair = input.suffix.includes('initial-pair');
                    if (
                        (failureStage === 'initial-pair' && isInitialPair) ||
                        (failureStage === 'full-formation' && !isInitialPair)
                    ) {
                        throw new Error(`${failureStage} readiness failed`);
                    }
                    return canonicalFormationReadinessForSessions(
                        input.agent.agentId,
                        isInitialPair
                            ? ['session-a', 'session-b']
                            : ['session-a', 'session-b', 'session-c'],
                        input.roomRef
                    );
                }
            }
        });

        await expect(driver.run({
            control,
            runId: 'run-readiness-recipients',
            agents,
            transport: 'realtime',
            groupId: 'group',
            suffix: failureStage,
            readinessScope: 'all'
        })).rejects.toThrow(`${failureStage} readiness failed`);

        expect(directReadinessParticipants).toEqual([
            ['agent-a', 'agent-b'],
            ['agent-a', 'agent-b']
        ]);
        expect(recordedFailures.length).toBeGreaterThan(0);
        expect(recordedFailures.every((failure) =>
            failure.participantAgents.map((participant) => participant.agentId).join(',') ===
                participantAgentIds.join(',')
        )).toBe(true);
    });

    it.each([
        { failureKind: 'command' as const, failure: new Error('canonical readiness command failed') },
        { failureKind: 'refresh' as const, failure: new Error('canonical readiness refresh failed') },
        { failureKind: 'peer-proof' as const, failure: undefined }
    ])('records $failureKind failures before reconnect lifecycle cleanup', async ({ failureKind, failure }) => {
        const operationOrder: string[] = [];
        const recordReadinessFailure = vi.fn(
            async (
                _input: LiveRtcControlClient.RecordReadinessFailureInput
            ) => {
                operationOrder.push('capture');
            }
        );
        const agentA = {
            ...createAgent('A'),
            refreshRoom: async () => {
                if (failureKind === 'refresh') {
                    throw failure;
                }
            }
        };
        const agents = [agentA, createAgent('B'), createAgent('C')] as const;
        const control = {
            executeOk: async (
                input: LiveRtcControlClient.ExecuteInput
            ): Promise<LiveRtcControlClient.Result> => {
                if (input.command.kind === 'rtc.connect') {
                    return successfulResult(input, { sessionId: 'session-c-next' });
                }
                if (
                    input.command.kind === 'formation.readiness' &&
                    input.agentId === 'agent-a' &&
                    failureKind === 'command'
                ) {
                    throw failure;
                }
                if (input.command.kind === 'formation.readiness') {
                    return successfulResult(
                        input,
                        canonicalFormationReadinessValue(
                            input.agentId,
                            input.agentId === 'agent-a' && failureKind === 'peer-proof'
                        )
                    );
                }
                return successfulResult(input, {});
            },
            executeResult: async (input: LiveRtcControlClient.ExecuteInput) => successfulResult(input, {}),
            resultValue: readResultValue,
            requireSessionId: (result: LiveRtcControlClient.Result) => {
                const sessionId = readResultValue(result).sessionId;
                if (typeof sessionId !== 'string') {
                    throw new Error('Expected reconnect session.');
                }
                return sessionId;
            },
            readyPeerIds: () => [],
            waitForMessage: async () => 1,
            waitForPeerAbsence: async () => undefined,
            waitForPeerReadiness: async () => 1,
            recordReadinessFailure
        };
        const driver = createGroupFormationLifecycleDriver({
            apiBaseUrl: 'http://api.test',
            applicationId: 'application',
            workspaceId: 'workspace',
            messagesRtcTypeId: 'type',
            messagesRtcTopicId: 'topic',
            formation: createLiveRtcFormationOperations()
        });

        const reconnect = driver.reconnectAndWaitForPeerReadiness({
            control,
            runId: 'run-canonical-failure',
            reconnectingAgent: agents[2],
            survivingAgents: [agents[0], agents[1]],
            survivingSessionIds: ['session-a', 'session-b'],
            transport: 'realtime',
            groupId: 'group',
            suffix: `canonical-${failureKind}`
        });
        try {
            if (failure) {
                await expect(reconnect).rejects.toBe(failure);
            }
            else {
                await expect(reconnect).rejects.toThrow('exact ready peers');
            }
        }
        finally {
            operationOrder.push('cleanup');
        }

        expect(recordReadinessFailure).toHaveBeenCalledTimes(1);
        expect(recordReadinessFailure).toHaveBeenCalledWith(
            expect.objectContaining({
                runId: 'run-canonical-failure',
                agent: expect.objectContaining({ agentId: 'agent-a', prefix: 'A' }),
                expectedPeerIds: ['session-b', 'session-c-next'],
                suffix: `canonical-${failureKind}`,
                attempt: 0,
                participantAgents: agents
            })
        );
        expect(operationOrder).toEqual(['capture', 'cleanup']);
    });

    it('preserves the canonical lifecycle error when failure capture also fails', async () => {
        const lifecycleFailure = new Error('canonical readiness command failed');
        const diagnosticFailure = new Error('diagnostic capture failed');
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const control = {
            executeOk: async (
                input: LiveRtcControlClient.ExecuteInput
            ): Promise<LiveRtcControlClient.Result> => {
                if (input.command.kind === 'rtc.connect') {
                    return successfulResult(input, { sessionId: 'session-c-next' });
                }
                throw lifecycleFailure;
            },
            executeResult: async (input: LiveRtcControlClient.ExecuteInput) => successfulResult(input, {}),
            resultValue: readResultValue,
            requireSessionId: () => 'session-c-next',
            readyPeerIds: () => [],
            waitForMessage: async () => 1,
            waitForPeerAbsence: async () => undefined,
            waitForPeerReadiness: async () => 1,
            recordReadinessFailure: async () => {
                throw diagnosticFailure;
            }
        };
        const agents = [createAgent('A'), createAgent('B'), createAgent('C')] as const;
        const driver = createGroupFormationLifecycleDriver({
            apiBaseUrl: 'http://api.test',
            applicationId: 'application',
            workspaceId: 'workspace',
            messagesRtcTypeId: 'type',
            messagesRtcTopicId: 'topic',
            formation: createLiveRtcFormationOperations()
        });

        try {
            await expect(
                driver.reconnectAndWaitForPeerReadiness({
                    control,
                    runId: 'run-capture-failure',
                    reconnectingAgent: agents[2],
                    survivingAgents: [agents[0], agents[1]],
                    survivingSessionIds: ['session-a', 'session-b'],
                    transport: 'realtime',
                    groupId: 'group',
                    suffix: 'capture-failure'
                })
            ).rejects.toBe(lifecycleFailure);
            expect(errorLog).toHaveBeenCalledWith(
                'Failed to record RTC readiness diagnostics',
                diagnosticFailure
            );
        }
        finally {
            errorLog.mockRestore();
        }
    });
});
