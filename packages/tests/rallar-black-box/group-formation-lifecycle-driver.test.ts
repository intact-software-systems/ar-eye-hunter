import {
    describe,
    expect,
    it
} from 'vitest';

import type { RallarRtcCaptureUnverifiedError } from '@shared-web/browser/connection/rallar-rtc-capture-unverified-error.ts';
import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';
import type { RtcBaselineJson } from '../../shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';

import {
    createGroupFormationLifecycleDriver,
    type LiveRtcControlPort
} from '../../../tests/playwright/rallar-black-box/create-group-formation-lifecycle-driver.ts';
import type { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
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

const capturedReplacement: LiveRtcControlClient.CapturedConnection = {
    runId: 'retained-native-run',
    agentId: 'agent-c',
    commandId: 'connect-c-realtime-retained',
    connection: 'connection-c-realtime',
    transport: 'realtime' as const,
    sessionId: 'replacement-session-c',
    requestedConfiguration: { mode: 'native' as const, origin: 'step' as const },
    receipt: appliedNativeCapture.value
};
const replacementNativeProof: LiveRtcControlClient.NativeAcquisitionProof = {
    connection: capturedReplacement,
    initialized: {
        kind: 'native-observation-status',
        stage: 'initialized',
        localSessionId: 'replacement-session-c',
        atEpochMs: 123,
        availability: { status: 'observed', value: 'enabled' },
        capture: {
            scopeId: { status: 'observed', value: 'replacement-native-scope-c' },
            scope: 'active',
            ordinaryRowsSuppressed: false,
            admissionLimited: false,
            payloadLimited: false
        }
    },
    source: {
        endpoint: '/runs/retained-native-run/events.jsonl',
        durableOrigin: 'unknown',
        bytesRead: 987,
        retainedBytes: 987,
        retainedPrefixDropped: false,
        transportTruncated: false,
        malformedRows: 0,
        oversizedRows: 0,
        scanLimited: false
    }
};
const missingReplacementNativeStatus = {
    reason: 'initialized-status-unavailable' as const,
    source: null,
    connection: capturedReplacement,
    cause: new Error('No initialized row for the replacement scope was received.')
};
const replacementCaptureConfig = {
    apiBaseUrl: 'http://api.test',
    applicationId: 'application',
    workspaceId: 'workspace',
    messagesRtcTypeId: 'type',
    messagesRtcTopicId: 'topic',
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
    readonly rtcCapture: RtcBaselineJson | undefined;
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

function requireFormationSessionId(result: LiveRtcControlClient.Result): string {
    const sessionId = readResultValue(result).sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('Expected the formation agent session identifier.');
    }
    return sessionId;
}

function createReconnectControl(
    rtcCapture: RtcBaselineJson | undefined
): LiveRtcControlPort {
    return {
        executeOk: async (input) => {
            if (input.command.kind !== 'rtc.connect') {
                throw new Error('Replacement capture fixture requires an RTC Connect command.');
            }
            return successfulResult(input, {
                sessionId: 'replacement-session-c',
                ...(rtcCapture === undefined ? {} : { rtcCapture })
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
            transportState: 'flowing',
            dialing: 'accepted',
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

    it('blocks replacement readiness until acquisition accepts the already-admitted connection', async () => {
        const readinessAgents: string[] = [];
        const acquisitions: Array<typeof capturedReplacement> = [];
        const pendingAcquisition = Promise.withResolvers<Either<typeof missingReplacementNativeStatus, typeof replacementNativeProof>>();
        const nativeAcquisition = {
            readRtcNativeAcquisition: async (connection: typeof capturedReplacement) => {
                acquisitions.push(connection);
                return await pendingAcquisition.promise;
            }
        };
        const reconnectInput = {
            ...replacementCaptureInput,
            control: createReconnectControl(normalizeJson(appliedNativeCapture)),
            nativeAcquisition
        };
        const resultPromise = createGroupFormationLifecycleDriver({
            ...replacementCaptureConfig,
            formation: {
                readiness: async (input: Parameters<LiveRtcFormationOperations['readiness']>[0]) => {
                    readinessAgents.push(input.agent.agentId);
                    return toReplacementFormationReadiness(input);
                }
            }
        }).reconnectAndWaitForPeerReadiness(reconnectInput);

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect.soft(acquisitions).toEqual([capturedReplacement]);
        expect.soft(readinessAgents).toEqual([]);
        pendingAcquisition.resolve(Either.ofRight(replacementNativeProof));
        const result = await resultPromise;

        expect(readinessAgents).toEqual(['agent-a', 'agent-b', 'agent-c']);
        expect(result).toMatchObject({
            rtcCapture: capturedReplacement,
            nativeAcquisition: replacementNativeProof
        });
    });

    it('refuses replacement readiness and preserves the acquired failure with the completed Connect facts', async () => {
        const readinessAgents: string[] = [];
        const reconnectInput = {
            ...replacementCaptureInput,
            control: createReconnectControl(normalizeJson(appliedNativeCapture)),
            nativeAcquisition: {
                readRtcNativeAcquisition: async (_connection: typeof capturedReplacement) =>
                    Either.ofLeft<typeof missingReplacementNativeStatus, typeof replacementNativeProof>(missingReplacementNativeStatus)
            }
        };
        const outcome = await createGroupFormationLifecycleDriver({
            ...replacementCaptureConfig,
            formation: {
                readiness: async (input: Parameters<LiveRtcFormationOperations['readiness']>[0]) => {
                    readinessAgents.push(input.agent.agentId);
                    return toReplacementFormationReadiness(input);
                }
            }
        }).reconnectAndWaitForPeerReadiness(reconnectInput).then(() => undefined, toError);

        expect.soft(outcome?.cause).toBe(missingReplacementNativeStatus.cause);
        expect.soft(outcome).toMatchObject({
            cause: missingReplacementNativeStatus.cause,
            rtcConnectCaptures: [capturedReplacement],
            nativeAcquisitions: [],
            nativeAcquisitionFailure: missingReplacementNativeStatus
        });
        expect(readinessAgents).toEqual([]);
    });

    it('retains the admitted replacement when the acquisition invocation throws before returning a promise', async () => {
        const acquisitionFailure = new Error('The native acquisition port threw during invocation.');
        const effects: string[] = [];
        const control = createReconnectControl(normalizeJson(appliedNativeCapture));
        control.executeResult = async () => {
            effects.push('presence');
            throw new Error('No presence operation may follow the acquisition failure.');
        };
        const reconnectInput = {
            ...replacementCaptureInput,
            control,
            nativeAcquisition: {
                readRtcNativeAcquisition: (_connection: LiveRtcControlClient.CapturedConnection) => {
                    throw acquisitionFailure;
                }
            }
        };
        const outcome = await createGroupFormationLifecycleDriver({
            ...replacementCaptureConfig,
            formation: {
                readiness: async (input: Parameters<LiveRtcFormationOperations['readiness']>[0]) => {
                    effects.push('readiness');
                    return toReplacementFormationReadiness(input);
                }
            }
        }).reconnectAndWaitForPeerReadiness(reconnectInput).then(() => undefined, toError);

        expect.soft(outcome?.cause).toBe(acquisitionFailure);
        expect.soft(outcome).toMatchObject({
            cause: acquisitionFailure,
            rtcConnectCaptures: [capturedReplacement],
            nativeAcquisitions: [],
            nativeAcquisitionFailure: {
                reason: 'acquisition-failed',
                connection: capturedReplacement,
                cause: acquisitionFailure
            }
        });
        expect(effects).toEqual([]);
    });

    it('preserves a successful native acquisition when replacement readiness rejects with its original cause', async () => {
        const readinessFailure = new Error('The surviving peer did not adopt the replacement.');
        const reconnectInput = {
            ...replacementCaptureInput,
            control: createReconnectControl(normalizeJson(appliedNativeCapture)),
            nativeAcquisition: {
                readRtcNativeAcquisition: async (_connection: typeof capturedReplacement) =>
                    Either.ofRight<typeof missingReplacementNativeStatus, typeof replacementNativeProof>(replacementNativeProof)
            }
        };
        const outcome = await createGroupFormationLifecycleDriver({
            ...replacementCaptureConfig,
            formation: {
                readiness: async () => {
                    throw readinessFailure;
                }
            }
        }).reconnectAndWaitForPeerReadiness(reconnectInput).then(() => undefined, toError);

        expect.soft(outcome?.cause).toBe(readinessFailure);
        expect(outcome).toMatchObject({
            cause: readinessFailure,
            rtcConnectCaptures: [capturedReplacement],
            nativeAcquisitions: [replacementNativeProof],
            nativeAcquisitionFailure: null
        });
    });

    it('refuses strict acquisition of an unavailable native capture without calling the acquisition port or readiness', async () => {
        const calls: string[] = [];
        const receipt: RtcSignalingDiagnostics.CaptureReceipt = {
            ...appliedNativeCapture.value,
            nativeScopeId: { status: 'unavailable', reason: 'unsupported' },
            nativeAvailability: { status: 'unavailable', reason: 'unsupported' },
            nativeCoverage: 'unavailable'
        };
        const reconnectInput = {
            ...replacementCaptureInput,
            control: createReconnectControl(normalizeJson({ status: 'observed', value: receipt })),
            nativeAcquisition: {
                readRtcNativeAcquisition: async (_connection: typeof capturedReplacement) => {
                    calls.push('acquisition');
                    return Either.ofRight<typeof missingReplacementNativeStatus, typeof replacementNativeProof>(replacementNativeProof);
                }
            }
        };
        const outcome = await createGroupFormationLifecycleDriver({
            ...replacementCaptureConfig,
            formation: {
                readiness: async (input: Parameters<LiveRtcFormationOperations['readiness']>[0]) => {
                    calls.push('readiness');
                    return toReplacementFormationReadiness(input);
                }
            }
        }).reconnectAndWaitForPeerReadiness(reconnectInput).then(() => undefined, toError);

        expect.soft(outcome).toMatchObject({
            rtcConnectCaptures: [{ ...capturedReplacement, receipt }],
            nativeAcquisitions: [],
            nativeAcquisitionFailure: { reason: 'native-capture-unavailable', connection: { ...capturedReplacement, receipt }, source: null }
        });
        expect(calls).toEqual([]);
    });

    it('refuses a non-Native acquisition request before Connect or readiness effects', async () => {
        const calls: string[] = [];
        const control = createReconnectControl(normalizeJson(appliedNativeCapture));
        const executeOk = control.executeOk;
        control.executeOk = async (input) => {
            calls.push('connect');
            return await executeOk(input);
        };
        const reconnectInput = {
            ...replacementCaptureInput,
            control,
            nativeAcquisition: {
                readRtcNativeAcquisition: async (_connection: typeof capturedReplacement) => {
                    calls.push('acquisition');
                    return Either.ofRight<typeof missingReplacementNativeStatus, typeof replacementNativeProof>(replacementNativeProof);
                }
            }
        };
        const outcome = await createGroupFormationLifecycleDriver({
            ...replacementCaptureConfig,
            rtcCaptureMode: 'signaling',
            formation: {
                readiness: async (input: Parameters<LiveRtcFormationOperations['readiness']>[0]) => {
                    calls.push('readiness');
                    return toReplacementFormationReadiness(input);
                }
            }
        }).reconnectAndWaitForPeerReadiness(reconnectInput).then(() => undefined, toError);

        expect.soft(outcome?.message).toContain('Native acquisition requires an explicit Native capture request');
        expect(calls).toEqual([]);
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

    it('waits for exact current membership and accepts a newer active publication', async () => {
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
        expect(canonicalRoomReadinessAgents).toEqual([
            'agent-a',
            'agent-b',
            'agent-a',
            'agent-b',
            'agent-c'
        ]);
    });
});
