import {
    describe,
    expect,
    it
} from 'vitest';

import type { RtcNativeCapturedConnection } from '@shared-test/black-box-runner/artifacts/rtc-native-acquisition.ts';
import { computeEnqueuedCommandWaitMs } from '@shared-test/rallar-bb-test/browser-test-budgets/compute-command-result-wait-ms.ts';
import { FORMATION_CONNECT_RESULT_WAIT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-formation-waits.ts';
import type { RallarRtcCaptureUnverifiedError } from '@shared-web/browser/connection/rallar-rtc-capture-unverified-error.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import {
    createGroupFormationLifecycleDriver,
    type LiveRtcControlPort
} from '../../../tests/playwright/rallar-black-box/create-group-formation-lifecycle-driver.ts';
import {
    resolveLiveRtcResultPollTimeoutMs,
    type LiveRtcControlClient
} from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import { normalizeJson, type LiveRtcJsonRecord } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';
import type { LiveRtcFormationOperations } from '../../../tests/playwright/rallar-black-box/live-rtc-formation-operations.ts';

const appliedNativeCapture: RtcSignalingDiagnostics.Readout<RtcSignalingDiagnostics.CaptureReceipt> = {
    status: 'observed',
    value: {
        configuration: { mode: 'native', origin: 'step' },
        application: { status: 'applied', mode: 'native' },
        connectionId: { status: 'observed', value: 'replacement-connection-c' },
        nativeScopeId: { status: 'observed', value: 'replacement-native-scope-c' },
        configurationVersion: 1,
        nativeAvailability: { status: 'observed', value: 'enabled' },
        nativeCoverage: 'attached'
    }
};

const capturedReplacement: RtcNativeCapturedConnection & { readonly almDiagnostics: boolean; } = {
    almDiagnostics: true,
    runId: 'retained-native-run',
    agentId: 'agent-c',
    commandId: 'connect-c-realtime-retained',
    connection: 'connection-c-realtime',
    transport: 'realtime' as const,
    sessionId: 'replacement-session-c',
    requestedConfiguration: { mode: 'native' as const, origin: 'step' as const },
    receipt: appliedNativeCapture.value
};
const replacementCaptureConfig = {
    apiBaseUrl: 'http://api.test',
    applicationId: 'application',
    workspaceId: 'workspace',
    messagesRtcTypeId: 'type',
    messagesRtcTopicId: 'topic',
    almDiagnostics: true,
    rtcCaptureMode: 'native' as const,
    formation: { readiness: async (input: Parameters<LiveRtcFormationOperations['readiness']>[0]) => toReplacementFormationReadiness(input) }
};
const replacementCaptureInput = {
    runId: 'retained-native-run',
    reconnectingAgent: createAgent('C'),
    survivingAgents: [createAgent('A'), createAgent('B')] as const,
    survivingSessionIds: ['session-a', 'session-b'] as const,
    transport: 'realtime' as const,
    groupId: 'group',
    suffix: 'retained'
};

interface FormationCaptureReceiptCase {
    readonly description: string;
    readonly rtcCapture: ApiJsonValue | undefined;
    readonly reason: RallarRtcCaptureUnverifiedError.Reason;
}

const rejectedCaptureReceipts: readonly FormationCaptureReceiptCase[] = [
    { description: 'absent receipt', rtcCapture: undefined, reason: 'receipt-unavailable' },
    {
        description: 'unsupported receipt readout',
        rtcCapture: { status: 'unavailable', reason: 'unsupported' },
        reason: 'receipt-unavailable'
    },
    {
        description: 'unverified configuration version',
        rtcCapture: normalizeJson({ status: 'observed', value: { ...appliedNativeCapture.value, configurationVersion: 2 } }),
        reason: 'configuration-version-unverified'
    },
    {
        description: 'absent connection identity',
        rtcCapture: normalizeJson({
            status: 'observed',
            value: { ...appliedNativeCapture.value, connectionId: { status: 'unavailable', reason: 'absent' } }
        }),
        reason: 'connection-identity-unverified'
    },
    {
        description: 'empty connection identity',
        rtcCapture: normalizeJson({
            status: 'observed',
            value: { ...appliedNativeCapture.value, connectionId: { status: 'observed', value: '' } }
        }),
        reason: 'connection-identity-unverified'
    },
    {
        description: 'different resolved mode',
        rtcCapture: normalizeJson({
            status: 'observed',
            value: { ...appliedNativeCapture.value, configuration: { mode: 'signaling', origin: 'step' } }
        }),
        reason: 'mode-mismatch'
    },
    {
        description: 'different applied mode',
        rtcCapture: normalizeJson({
            status: 'observed',
            value: { ...appliedNativeCapture.value, application: { status: 'applied', mode: 'off' } }
        }),
        reason: 'mode-mismatch'
    },
    ...(['sink-unavailable', 'unsupported', 'initialization-failed'] as const).map((reason) => ({
        description: `${reason} application`,
        rtcCapture: normalizeJson({
            status: 'observed',
            value: { ...appliedNativeCapture.value, application: { status: 'unavailable', reason } }
        }),
        reason: 'application-unavailable' as const
    }))
];

const malformedCaptureReceipts: readonly FormationCaptureReceiptCase[] = [
    {
        description: 'numeric native scope identity',
        rtcCapture: normalizeJson({
            status: 'observed',
            value: { ...appliedNativeCapture.value, nativeScopeId: { status: 'observed', value: 1 } }
        }),
        reason: 'receipt-unavailable'
    },
    {
        description: 'invalid observed native availability',
        rtcCapture: normalizeJson({
            status: 'observed',
            value: { ...appliedNativeCapture.value, nativeAvailability: { status: 'observed', value: 'disabled' } }
        }),
        reason: 'receipt-unavailable'
    },
    {
        description: 'invalid native coverage',
        rtcCapture: normalizeJson({ status: 'observed', value: { ...appliedNativeCapture.value, nativeCoverage: 'complete' } }),
        reason: 'receipt-unavailable'
    },
    {
        description: 'missing mandatory native scope readout',
        rtcCapture: normalizeJson({
            status: 'observed',
            value: {
                configuration: { mode: 'native', origin: 'step' },
                application: { status: 'applied', mode: 'native' },
                connectionId: { status: 'observed', value: 'replacement-connection-c' },
                configurationVersion: 1,
                nativeAvailability: { status: 'observed', value: 'enabled' },
                nativeCoverage: 'attached'
            }
        }),
        reason: 'receipt-unavailable'
    },
    {
        description: 'unrecognized configuration origin',
        rtcCapture: normalizeJson({
            status: 'observed',
            value: { ...appliedNativeCapture.value, configuration: { mode: 'native', origin: 'request' } }
        }),
        reason: 'receipt-unavailable'
    },
    {
        description: 'unrecognized unavailable reason',
        rtcCapture: normalizeJson({
            status: 'observed',
            value: { ...appliedNativeCapture.value, nativeScopeId: { status: 'unavailable', reason: 'missing' } }
        }),
        reason: 'receipt-unavailable'
    }
];

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
        result: { value: { ...(input.command.kind === 'rtc.connect' ? { almDiagnostics: true } : {}), ...value } }
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

function requireFormationSessionId(result: LiveRtcControlClient.Result): string {
    const sessionId = readResultValue(result).sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('Expected the formation agent session identifier.');
    }
    return sessionId;
}

function createReconnectControl(
    rtcCapture: ApiJsonValue | undefined
): LiveRtcControlPort {
    return {
        executeOk: async (input) => {
            if (input.command.kind !== 'rtc.connect') {
                throw new Error('Replacement capture fixture requires an RTC Connect command.');
            }
            return successfulResult(input, {
                sessionId: 'replacement-session-c',
                ...(rtcCapture === undefined ? {} : { rtcCapture: normalizeJson(rtcCapture) })
            });
        },
        executeResult: async () => {
            throw new Error('Replacement capture fixture does not provide HTTP results.');
        },
        resultValue: readResultValue,
        requireSessionId: requireFormationSessionId,
        readyPeerIds: () => [],
        waitForMessage: async () => 1,
        waitForPeerAbsence: async () => undefined,
        waitForPeerReadiness: async () => 1
    };
}

function toReplacementFormationReadiness(
    input: Parameters<LiveRtcFormationOperations['readiness']>[0]
): Awaited<ReturnType<LiveRtcFormationOperations['readiness']>> {
    const ownSession = input.agent.prefix === 'C' ? 'replacement-session-c' : `session-${input.agent.prefix.toLowerCase()}`;
    const peerIds = ['session-a', 'session-b', 'replacement-session-c'].filter((sessionId) => sessionId !== ownSession);
    return {
        readyAtEpochMs: 1,
        formation: {
            roomRef: input.roomRef,
            stage: 'active',
            formationEpoch: 1,
            formationAttemptCount: 1,
            causalRevision: { groupRevision: 1, presenceRevision: 1 },
            activeSessionCount: 3,
            transportState: 'flowing',
            dialing: 'accepted-and-planned',
            memberPolicy: { maxConcurrentEdgeSetups: 4, transports: 'rtc-and-ws' },
            room: {
                state: 'open',
                desiredPeerIds: peerIds,
                activePeerIds: peerIds,
                readyPeerIds: peerIds,
                failedPeerIds: [],
                acceptedLayoutIdentity: { groupRevision: 1, presenceRevision: 1, version: 1, state: 'active' }
            }
        }
    };
}

describe('group formation lifecycle driver', () => {
    it.each([true, false])('routes and verifies ALM %s on a reconnect with retained history', async (almDiagnostics) => {
        const control = createReconnectControl(normalizeJson(appliedNativeCapture));
        const executeOk = control.executeOk;
        let connectPayload: LiveRtcControlClient.ExecuteInput['command'] | undefined;
        control.executeOk = async (input) => {
            connectPayload = input.command;
            const result = await executeOk(input);
            return { ...result, result: { value: { ...readResultValue(result), almDiagnostics } } };
        };
        const config = { ...replacementCaptureConfig, almDiagnostics };
        const driver = createGroupFormationLifecycleDriver(config);
        config.almDiagnostics = !almDiagnostics;
        const result = await driver.reconnectAndWaitForPeerReadiness({ ...replacementCaptureInput, control });
        expect(connectPayload).toMatchObject({ kind: 'rtc.connect', rallar: { almDiagnostics } });
        expect(result.rtcCapture).toMatchObject({ almDiagnostics });
    });

    // The driver waited 60 s for a Connect whose own timeout is a 135 s SDK connect and room join.
    it('waits for a Connect result as long as the Connect may take, then the control client\'s poll', async () => {
        const control = createReconnectControl(normalizeJson(appliedNativeCapture));
        const executeOk = control.executeOk;
        const connects: LiveRtcControlClient.ExecuteInput[] = [];
        control.executeOk = async (input) => {
            connects.push(input);
            return await executeOk(input);
        };
        const driver = createGroupFormationLifecycleDriver(replacementCaptureConfig);
        await driver.reconnectAndWaitForPeerReadiness({ ...replacementCaptureInput, control });

        expect(connects).toHaveLength(1);
        expect(connects[0].command).toMatchObject({ kind: 'rtc.connect', roomId: 'group', timeoutMs: 135_000 });
        expect(connects[0].timeoutMs).toBeUndefined();
        expect(resolveLiveRtcResultPollTimeoutMs(connects[0])).toBe(135_000 + 45_000);
        expect(computeEnqueuedCommandWaitMs(resolveLiveRtcResultPollTimeoutMs(connects[0]))).toBe(FORMATION_CONNECT_RESULT_WAIT_MS);
    });

    it.each(['missing', 'mismatch', 'foreign-command', 'foreign-agent'])('refuses %s ALM application before reconnect readiness', async (failure) => {
        const control = createReconnectControl(normalizeJson(appliedNativeCapture));
        const executeOk = control.executeOk;
        control.executeOk = async (input) => {
            const result = await executeOk(input);
            return {
                ...result,
                commandId: failure === 'foreign-command' ? 'earlier-connect' : result.commandId,
                agentId: failure === 'foreign-agent' ? 'other-agent' : result.agentId,
                result: {
                    value: {
                        sessionId: readResultValue(result).sessionId,
                        rtcCapture: readResultValue(result).rtcCapture ?? null,
                        ...(failure === 'missing' ? {} : { almDiagnostics: failure === 'mismatch' })
                    }
                }
            };
        };
        await expect(
            createGroupFormationLifecycleDriver({ ...replacementCaptureConfig, almDiagnostics: false }).reconnectAndWaitForPeerReadiness({
                ...replacementCaptureInput,
                control
            })
        ).rejects.toThrow(/ALM.*unverified/);
    });

    it.each([
        {
            mode: 'off' as const,
            expectedNativeScope: { status: 'unavailable', reason: 'not-applicable' },
            expectedNativeAvailability: { status: 'unavailable', reason: 'disabled' },
            expectedNativeCoverage: 'not-applicable'
        },
        {
            mode: 'signaling' as const,
            expectedNativeScope: { status: 'unavailable', reason: 'not-applicable' },
            expectedNativeAvailability: { status: 'unavailable', reason: 'disabled' },
            expectedNativeCoverage: 'not-applicable'
        },
        {
            mode: 'native' as const,
            expectedNativeScope: { status: 'unavailable', reason: 'unsupported' },
            expectedNativeAvailability: { status: 'unavailable', reason: 'unsupported' },
            expectedNativeCoverage: 'unavailable'
        }
    ])(
        'retains the actual $mode replacement Connect receipt with its request and session attribution',
        async ({ mode, expectedNativeScope, expectedNativeAvailability, expectedNativeCoverage }) => {
            const receipt: RtcSignalingDiagnostics.CaptureReceipt = {
                configuration: { mode, origin: 'step' },
                application: { status: 'applied', mode },
                connectionId: { status: 'observed', value: 'returned-replacement-connection' },
                nativeScopeId: { status: 'unavailable', reason: mode === 'native' ? 'unsupported' : 'not-applicable' },
                configurationVersion: 1,
                nativeAvailability: { status: 'unavailable', reason: mode === 'native' ? 'unsupported' : 'disabled' },
                nativeCoverage: mode === 'native' ? 'unavailable' : 'not-applicable'
            };
            const result = await createGroupFormationLifecycleDriver({
                ...replacementCaptureConfig,
                rtcCaptureMode: mode
            }).reconnectAndWaitForPeerReadiness({
                ...replacementCaptureInput,
                control: createReconnectControl(normalizeJson({ status: 'observed', value: receipt }))
            });

            expect(result).toMatchObject({
                commandId: 'connect-c-realtime-retained',
                sessionId: 'replacement-session-c',
                rtcCapture: {
                    runId: 'retained-native-run',
                    agentId: 'agent-c',
                    commandId: 'connect-c-realtime-retained',
                    connection: 'connection-c-realtime',
                    transport: 'realtime',
                    sessionId: 'replacement-session-c',
                    requestedConfiguration: { mode, origin: 'step' },
                    receipt: {
                        configuration: { mode, origin: 'step' },
                        application: { status: 'applied', mode },
                        connectionId: { status: 'observed', value: 'returned-replacement-connection' },
                        nativeScopeId: expectedNativeScope,
                        configurationVersion: 1,
                        nativeAvailability: expectedNativeAvailability,
                        nativeCoverage: expectedNativeCoverage
                    }
                }
            });
        }
    );

    it('retains the requested mode captured before caller configuration changes during Connect', async () => {
        const selectedConfig = { ...replacementCaptureConfig, rtcCaptureMode: 'native' as RtcSignalingDiagnostics.CaptureMode };
        const control = createReconnectControl(normalizeJson(appliedNativeCapture));
        const executeOk = control.executeOk;
        control.executeOk = async (input) => {
            const result = await executeOk(input);
            selectedConfig.rtcCaptureMode = 'off';
            return result;
        };
        const result = await createGroupFormationLifecycleDriver(selectedConfig).reconnectAndWaitForPeerReadiness({
            ...replacementCaptureInput,
            control
        });

        expect(result).toMatchObject({ rtcCapture: capturedReplacement });
    });

    it('rejects an unverified explicit receipt before extracting its returned session or waiting for readiness', async () => {
        const effects: string[] = [];
        const control = createReconnectControl(undefined);
        control.requireSessionId = () => {
            effects.push('session');
            throw new Error('The Connect result also lacks a returned session.');
        };
        const outcome = await createGroupFormationLifecycleDriver({
            ...replacementCaptureConfig,
            formation: {
                readiness: async (input: Parameters<LiveRtcFormationOperations['readiness']>[0]) => {
                    effects.push('readiness');
                    return toReplacementFormationReadiness(input);
                }
            }
        }).reconnectAndWaitForPeerReadiness({ ...replacementCaptureInput, control }).then(() => undefined, toError);

        expect.soft(outcome).toMatchObject({ code: 'RALLAR_RTC_CAPTURE_UNVERIFIED', reason: 'receipt-unavailable' });
        expect(effects).toEqual([]);
    });

    it.each([...rejectedCaptureReceipts, ...malformedCaptureReceipts])('rejects $description before replacement readiness', async ({ rtcCapture, reason }) => {
        const readinessAgents: string[] = [];
        const selectedConfig = {
            apiBaseUrl: 'http://api.test',
            applicationId: 'application',
            workspaceId: 'workspace',
            messagesRtcTypeId: 'type',
            messagesRtcTopicId: 'topic',
            almDiagnostics: true,
            rtcCaptureMode: 'native' as const,
            formation: {
                readiness: async (input: Parameters<LiveRtcFormationOperations['readiness']>[0]) => {
                    readinessAgents.push(input.agent.agentId);
                    return toReplacementFormationReadiness(input);
                }
            }
        };
        const outcome = await createGroupFormationLifecycleDriver(selectedConfig).reconnectAndWaitForPeerReadiness({
            control: createReconnectControl(rtcCapture),
            runId: 'required-capture-run',
            reconnectingAgent: createAgent('C'),
            survivingAgents: [createAgent('A'), createAgent('B')],
            survivingSessionIds: ['session-a', 'session-b'],
            transport: 'realtime',
            groupId: 'group',
            suffix: 'required-capture'
        }).then(() => undefined, toError);

        expect.soft(outcome).toMatchObject({ code: 'RALLAR_RTC_CAPTURE_UNVERIFIED', reason });
        expect(readinessAgents).toEqual([]);
    });

    it.each([
        {
            testName: 'accepts an applied capture receipt before replacement readiness',
            rtcCapture: normalizeJson(appliedNativeCapture)
        },
        {
            testName: 'accepts an applied mode with unavailable native readouts for basic replacement admission',
            rtcCapture: normalizeJson({
                status: 'observed',
                value: {
                    ...appliedNativeCapture.value,
                    nativeScopeId: { status: 'unavailable', reason: 'unsupported' },
                    nativeAvailability: { status: 'unavailable', reason: 'unsupported' },
                    nativeCoverage: 'unavailable'
                }
            })
        }
    ])('$testName', async ({ rtcCapture }) => {
        const readinessAgents: string[] = [];
        const selectedConfig = {
            apiBaseUrl: 'http://api.test',
            applicationId: 'application',
            workspaceId: 'workspace',
            messagesRtcTypeId: 'type',
            messagesRtcTopicId: 'topic',
            almDiagnostics: true,
            rtcCaptureMode: 'native' as const,
            formation: {
                readiness: async (input: Parameters<LiveRtcFormationOperations['readiness']>[0]) => {
                    readinessAgents.push(input.agent.agentId);
                    return toReplacementFormationReadiness(input);
                }
            }
        };

        const result = await createGroupFormationLifecycleDriver(selectedConfig).reconnectAndWaitForPeerReadiness({
            control: createReconnectControl(rtcCapture),
            runId: 'required-capture-run',
            reconnectingAgent: createAgent('C'),
            survivingAgents: [createAgent('A'), createAgent('B')],
            survivingSessionIds: ['session-a', 'session-b'],
            transport: 'realtime',
            groupId: 'group',
            suffix: 'required-capture'
        });

        expect(result.sessionId).toBe('replacement-session-c');
        expect(readinessAgents).toEqual(['agent-a', 'agent-b', 'agent-c']);
    });

    it.each([true, false])('waits for current membership and certifies initial ALM %s for every agent', async (almDiagnostics) => {
        const commands: LiveRtcControlClient.ExecuteInput[] = [];
        const peerReadinessAgents: string[] = [];
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
                        sessionId: `session-${input.agentId.slice(-1)}`,
                        almDiagnostics
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
            requireSessionId: requireFormationSessionId,
            readyPeerIds: () => [],
            waitForMessage: async () => 1,
            waitForPeerAbsence: async () => undefined,
            waitForPeerReadiness: async (input) => {
                peerReadinessAgents.push(input.agent.agentId);
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
                        activeSessionCount: sessionIds.length,
                        transportState: 'flowing',
                        dialing: 'accepted-and-planned',
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
            almDiagnostics,
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

        expect(
            commands.filter((entry) => entry.command.kind === 'rtc.connect').map((entry) =>
                entry.command.kind === 'rtc.connect' && entry.command.rallar?.almDiagnostics
            )
        ).toEqual([almDiagnostics, almDiagnostics, almDiagnostics]);
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
        expect(canonicalRoomReadinessAgents).toEqual([
            'agent-a',
            'agent-b',
            'agent-a',
            'agent-b',
            'agent-c'
        ]);
    });
});
