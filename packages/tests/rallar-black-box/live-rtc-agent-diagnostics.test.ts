import {
    describe,
    expect,
    it
} from 'vitest';
import { controlEventArtifactJsonl } from '../../../apps/rallar-black-box-control-server/src/control-artifacts.ts';
import { BlackBoxRallarRuntimeDiagnostics } from '../../shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts';
import { toRallarBrowserEventInput } from '../../shared-test/rallar-bb-test/browser/to-rallar-browser-event-input.ts';
import { toControlEventEnvelope } from '../../shared-test/rallar-bb-test/control-protocol.ts';
import { createDefaultRallarBlackBoxBrowserTestRuntime } from '../../shared-test/rallar-bb-test/mod.ts';
import type { ApiJsonValue } from '../../shared/api/api-json-value.ts';

import {
    buildLiveRtcAgentDiagnostics,
    decodeAgentDiagnostics,
    toLiveRtcLifecycleHistory
} from '../../../tests/playwright/rallar-black-box/live-rtc-agent-diagnostics.ts';
import { countUnexpectedLiveRtcDeliveries, type LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import { normalizeJson, requiredJsonArray, requiredJsonRecord } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';

interface NotificationFixture {
    readonly name: string;
    readonly fields: object;
    readonly expected: object;
}

const unavailableNotifications: readonly NotificationFixture[] = [
    { name: 'absent', fields: {}, expected: { peerObservation: null, laneObservation: null } },
    { name: 'wrong-peer', fields: { peer: { peerId: 'other', connection: { state: 'Open' }, lanes: [] } }, expected: { peerObservation: null } },
    { name: 'wrong-lane-peer', fields: { lane: { peerId: 'other', laneId: 'realtime', isOpen: true } }, expected: { laneObservation: null } },
    { name: 'wrong-lane', fields: { lane: { peerId: 'session-b', laneId: 'other', isOpen: true } }, expected: { laneObservation: null } },
    {
        name: 'oversized-peer',
        fields: { peerId: 'p'.repeat(257), peer: { peerId: 'p'.repeat(257), connection: { state: 'Open' } } },
        expected: { peerId: null, peerObservation: null }
    },
    {
        name: 'oversized-lane',
        fields: { laneId: 'l'.repeat(257), lane: { peerId: 'session-b', laneId: 'l'.repeat(257), isOpen: true } },
        expected: { laneId: null, laneObservation: null }
    },
    { name: 'missing-connection-and-lanes', fields: { peer: { peerId: 'session-b' } }, expected: { peerObservation: { connection: null, lanes: null } } },
    { name: 'invalid-lane-collection', fields: { peer: { peerId: 'session-b', lanes: 'invalid' } }, expected: { peerObservation: { lanes: null } } },
    {
        name: 'invalid-lane-members',
        fields: { peer: { peerId: 'session-b', lanes: [null, { peerId: 'other', laneId: 'realtime' }, { peerId: 'session-b', laneId: 'l'.repeat(257) }] } },
        expected: { peerObservation: { lanes: [null, null, null] } }
    }
];

const admittedSignal = { kind: 'admission-outcome', workerId: 'worker', msgId: 'signal', typeId: 'rtc-signaling', carrier: 'ws', outcome: 'committed' };
const dispatchedSignal = {
    kind: 'claim-settled',
    lane: 'durable',
    workerId: 'worker',
    effectId: 'dispatch',
    msgId: 'signal',
    subjectMsgId: 'signal',
    typeId: null,
    payloadKind: 'dispatch-local',
    outcome: 'completed',
    attempts: 1,
    queueWaitMs: 0,
    durationMs: 0,
    dueAtMs: 5,
    batchStartedAtMs: 5,
    startedAtMs: 5
};

function toNotificationHistory(jsonl: string) {
    return toLiveRtcLifecycleHistory({
        jsonl,
        bytesRead: Buffer.byteLength(jsonl),
        retainedBytes: Buffer.byteLength(jsonl),
        retainedPrefixDropped: false,
        transportTruncated: false,
        failureInterval: { caseId: 'retention-100', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'current-cycle-before-close' },
        cycle: 8,
        agentIds: ['agent-a', 'agent-b', 'agent-c']
    })['agent-a'];
}

function toSignalingRow(event: object, name = 'event', agentId = 'agent-a'): string {
    return JSON.stringify({
        name,
        agentId,
        atEpochMs: 120,
        value: { topic: 'rallar.browser.alm.inbound_diagnostics', payload: { atEpochMs: 119, data: event } }
    });
}

describe('live RTC diagnostic normalization', () => {
    it('retains only bounded formation identity and readiness facts beside native RTC facts', () => {
        const diagnostics = buildLiveRtcAgentDiagnostics('agent-b', {
            rallar: {
                credential: 'secret-root-sentinel',
                rtcStatus: { activePeerIds: ['session-a'], readyPeerIds: ['session-a'] },
                rtcDiagnostics: {
                    sessionId: 'session-b',
                    generatedAtEpochMs: 123,
                    peerCount: 1,
                    connectedPeerCount: 1,
                    relayPeerCount: 0,
                    peers: [{
                        peerId: 'session-a',
                        connection: { reconnecting: false },
                        lanes: [{ laneId: 'messages.rtc', isOpen: true, isReconnectable: true }]
                    }]
                },
                formation: {
                    roomRef: { applicationId: 'app', workspaceId: 'space', groupId: 'room', token: 'secret-room-sentinel' },
                    stage: 'connecting',
                    payload: 'secret-payload-sentinel',
                    room: {
                        state: 'connecting',
                        desiredPeerIds: ['session-a', 'session-c'],
                        readyPeerIds: ['session-a'],
                        activePeerIds: ['session-a'],
                        failedPeerIds: [],
                        acceptedLayoutIdentity: { groupRevision: 2, presenceRevision: 3, version: 4, state: 'active', sdp: 'secret-sdp-sentinel' },
                        candidates: 'secret-candidate-sentinel'
                    }
                }
            }
        });

        expect(diagnostics.details).toMatchObject({
            formation: {
                observation: 'health-summary-not-readiness-wait-result',
                available: true,
                roomRef: { applicationId: 'app', workspaceId: 'space', groupId: 'room' },
                stage: 'connecting',
                roomTransportState: 'connecting',
                desiredPeerIds: ['session-a', 'session-c'],
                readyPeerIds: ['session-a'],
                activePeerIds: ['session-a'],
                failedPeerIds: [],
                acceptedLayoutIdentity: { groupRevision: 2, presenceRevision: 3, version: 4, state: 'active' }
            }
        });
        expect(diagnostics.laneStates).toEqual([{ peerId: 'session-a', laneId: 'messages.rtc', isOpen: true, isReconnectable: true }]);
        expect(JSON.stringify(diagnostics)).not.toContain('secret-');
    });

    it('reports unavailable formation explicitly without inventing peer or room state', () => {
        const diagnostics = buildLiveRtcAgentDiagnostics('agent-a', {
            rallar: {
                rtcStatus: { activePeerIds: [], readyPeerIds: [] },
                rtcDiagnostics: { generatedAtEpochMs: 123, peerCount: 0, connectedPeerCount: 0, relayPeerCount: 0, peers: [] }
            }
        });
        expect(diagnostics.details).toMatchObject({
            formation: { observation: 'health-summary-not-readiness-wait-result', available: false }
        });
    });

    it('bounds formation output and retains explicit missing fields without turning them into empty peers', () => {
        const diagnostics = buildLiveRtcAgentDiagnostics('agent-a', {
            rallar: {
                rtcStatus: { activePeerIds: [], readyPeerIds: [] },
                rtcDiagnostics: { generatedAtEpochMs: 123, peerCount: 0, connectedPeerCount: 0, relayPeerCount: 0, peers: [] },
                formation: {
                    stage: 'connecting',
                    roomRef: { groupId: 'x'.repeat(257) },
                    room: { state: 'secret-invalid-state-sentinel', desiredPeerIds: Array.from({ length: 101 }, () => 'session-b'), readyPeerIds: [42] }
                }
            }
        });
        expect(diagnostics.details).toMatchObject({
            formation: {
                available: true,
                roomRef: { applicationId: null, workspaceId: null, groupId: null },
                roomTransportState: null,
                desiredPeerIds: Array(100).fill('session-b'),
                readyPeerIds: null,
                activePeerIds: null,
                failedPeerIds: null,
                peerIdentitiesTruncated: true,
                acceptedLayoutIdentity: null
            }
        });
    });

    it('reads historical details and the current extension through the same unchanged checkpoint contract', () => {
        const historical = decodeAgentDiagnostics({
            agentId: 'agent-a',
            settledPeerIds: [],
            readyPeerIds: [],
            laneStates: [],
            connectionTimerActive: false,
            peerCount: 0,
            connectedPeerCount: 0,
            relayPeerCount: 0,
            details: { generatedAtEpochMs: 123, status: { activePeerIds: [], readyPeerIds: [] } }
        });
        const current = decodeAgentDiagnostics({
            agentId: 'agent-b',
            settledPeerIds: ['session-a'],
            readyPeerIds: ['session-a'],
            laneStates: [{ peerId: 'session-a', laneId: 'messages.rtc', isOpen: true, isReconnectable: true }],
            connectionTimerActive: false,
            peerCount: 1,
            connectedPeerCount: 1,
            relayPeerCount: 0,
            details: { generatedAtEpochMs: 456, formation: { available: true, stage: 'connecting' } }
        });
        expect(historical?.details).toEqual({ generatedAtEpochMs: 123, status: { activePeerIds: [], readyPeerIds: [] } });
        expect(current?.details).toEqual({ generatedAtEpochMs: 456, formation: { available: true, stage: 'connecting' } });
    });

    it('sorts stable state and distinguishes absent timers from active timers', () => {
        const stable = buildLiveRtcAgentDiagnostics('agent-a', {
            rallar: {
                rtcStatus: {
                    activePeerIds: ['peer-c', 'peer-b'],
                    readyPeerIds: ['peer-c', 'peer-b']
                },
                rtcDiagnostics: {
                    sessionId: 'session-a',
                    generatedAtEpochMs: 10,
                    peerCount: 2,
                    connectedPeerCount: 2,
                    relayPeerCount: 0,
                    peers: [
                        {
                            peerId: 'peer-c',
                            connection: {
                                disconnectPending: false,
                                reconnecting: false
                            },
                            lanes: [{
                                peerId: 'peer-c',
                                laneId: 'realtime',
                                isOpen: true,
                                isReconnectable: true
                            }]
                        },
                        {
                            peerId: 'peer-b',
                            connection: {
                                disconnectPending: false,
                                reconnecting: false
                            },
                            connectionDiagnostics: {
                                reconnectAttemptsInFlight: 0,
                                hasReconnectTimer: false
                            },
                            lanes: [{
                                peerId: 'peer-b',
                                laneId: 'messages.rtc',
                                isOpen: true,
                                isReconnectable: true
                            }]
                        }
                    ]
                }
            }
        });
        const activeTimer = buildLiveRtcAgentDiagnostics('agent-a', {
            rallar: {
                rtcStatus: {
                    activePeerIds: ['peer-b'],
                    readyPeerIds: ['peer-b']
                },
                rtcDiagnostics: {
                    sessionId: 'session-a',
                    generatedAtEpochMs: 11,
                    peerCount: 1,
                    connectedPeerCount: 1,
                    relayPeerCount: 0,
                    peers: [{
                        peerId: 'peer-b',
                        connection: {
                            disconnectPending: false,
                            reconnecting: false
                        },
                        connectionDiagnostics: {
                            reconnectAttemptsInFlight: 1,
                            hasReconnectTimer: true
                        },
                        lanes: []
                    }]
                }
            }
        });

        expect(stable).toMatchObject({
            settledPeerIds: ['peer-b', 'peer-c'],
            readyPeerIds: ['peer-b', 'peer-c'],
            laneStates: [
                expect.objectContaining({ peerId: 'peer-b' }),
                expect.objectContaining({ peerId: 'peer-c' })
            ],
            connectionTimerActive: false
        });
        expect(activeTimer.connectionTimerActive).toBe(true);
    });

    it('counts delivery to a receiver outside the scenario allowlist', () => {
        const scenario = {
            matrixId: 'direct-a-to-b',
            transport: 'realtime' as const,
            deliveryMode: 'direct' as const,
            senderAgentId: 'agent-a',
            expectedAgentIds: ['agent-b'],
            allowedAgentIds: ['agent-b']
        };
        const event = (agentId: string): LiveRtcControlClient.Event => ({
            agentId,
            payload: {
                kind: 'message',
                transport: 'realtime',
                payload: {
                    data: {
                        matrixId: scenario.matrixId,
                        deliveryMode: scenario.deliveryMode
                    }
                }
            }
        });

        expect(countUnexpectedLiveRtcDeliveries({
            events: [event('agent-b'), event('agent-c')],
            scenarios: [scenario]
        })).toBe(1);
    });
});

describe('lifecycle notification observations', () => {
    it.each(unavailableNotifications)('marks $name observations unavailable without substituting event.status', ({ fields, expected }) => {
        const jsonl = JSON.stringify({
            name: 'notification',
            agentId: 'agent-a',
            atEpochMs: 120,
            value: {
                topic: 'rallar.browser.rtc.lifecycle',
                payload: {
                    atEpochMs: 119,
                    data: {
                        kind: 'lane-error',
                        atEpochMs: 118,
                        peerId: 'session-b',
                        laneId: 'realtime',
                        status: { peers: [{ peerId: 'session-b', connection: { state: 'Open' } }] },
                        ...fields
                    }
                }
            }
        });
        expect(toNotificationHistory(jsonl)).toMatchObject({
            coverage: 'unknown',
            events: [{ eventId: 'notification', kind: 'lane-error', controlAtEpochMs: 120, observation: 'facade-current-at-notification', ...expected }]
        });
    });

    it('retains valid zeros and booleans while invalid fields stay null and raw roots stay private', () => {
        const jsonl =
            '{"name":"invalid-fields","agentId":"agent-a","atEpochMs":120,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"lane-error","peerId":"session-b","laneId":"realtime","peer":{"peerId":"session-b","connection":{"state":"secret-field-sentinel","connectionState":"Open","iceConnectionState":"invented","iceGatheringState":"completed","signalingState":"connecting","hasLocalDescription":"false","hasRemoteDescription":false,"makingOffer":0,"iceCandidateQueueSize":-1,"signaling":{"outboundOfferCount":0,"outboundAnswerCount":null,"outboundIceCandidateCount":"3","inboundOfferCount":-1,"inboundIceCandidateCount":true,"outboundSignalingErrorCount":{},"inboundSignalingErrorCount":0},"localStreamId":"secret-field-sentinel","remoteStreamIds":["secret-field-sentinel"],"ignoreOffer":"secret-field-sentinel"},"lanes":[]},"lane":{"peerId":"session-b","laneId":"realtime","isOpen":"true","isReconnectable":false,"channel":{"readyState":"secret-field-sentinel","state":"secret-field-sentinel","candidate":"secret-field-sentinel"}},"status":"secret-field-sentinel","signaling":{"reason":"secret-field-sentinel"},"credentials":"secret-field-sentinel","error":"secret-field-sentinel"}}}}';
        const history = toNotificationHistory(jsonl);
        expect(history).toMatchObject({
            events: [{
                peerObservation: {
                    peerId: 'session-b',
                    connection: {
                        state: null,
                        connectionState: null,
                        iceConnectionState: null,
                        iceGatheringState: null,
                        signalingState: null,
                        hasLocalDescription: null,
                        hasRemoteDescription: false,
                        makingOffer: null,
                        iceCandidateQueueSize: null,
                        signaling: {
                            outboundOfferCount: 0,
                            outboundAnswerCount: null,
                            outboundIceCandidateCount: null,
                            inboundOfferCount: null,
                            inboundAnswerCount: null,
                            inboundIceCandidateCount: null,
                            outboundSignalingErrorCount: null,
                            inboundSignalingErrorCount: 0
                        }
                    },
                    lanes: []
                },
                laneObservation: { peerId: 'session-b', laneId: 'realtime', isOpen: null, isReconnectable: false, readyState: null }
            }]
        });
        expect(JSON.stringify(history)).not.toContain('secret-field-sentinel');
        expect(JSON.stringify(history)).not.toContain('ignoreOffer');
    });

    it('keeps event identity when legal JSON exponents overflow numeric observations', () => {
        const history = toNotificationHistory(
            '{"name":"overflow","agentId":"agent-a","atEpochMs":120,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-timeout","peerId":"session-b","peer":{"peerId":"session-b","connection":{"iceCandidateQueueSize":1e400,"signaling":{"outboundOfferCount":1e400,"inboundOfferCount":0}},"lanes":[]}}}}}'
        );
        expect(history).toMatchObject({
            observed: { retainedRows: 1, malformedRows: 0 },
            events: [{
                eventId: 'overflow',
                peerObservation: {
                    connection: { iceCandidateQueueSize: null, signaling: { outboundOfferCount: null, inboundOfferCount: 0 } }
                }
            }]
        });
    });
});

describe('RTC signaling evidence correlation', () => {
    it('joins reversed recorder arrival and repeated identical admission facts without inventing another message', () => {
        const history = toNotificationHistory([
            toSignalingRow(dispatchedSignal, 'dispatch'),
            toSignalingRow(admittedSignal, 'admission'),
            toSignalingRow(admittedSignal, 'duplicate')
        ].join('\n'));
        expect(history).toMatchObject({
            events: [
                {
                    eventId: 'dispatch',
                    typeId: null,
                    identifiedTypeId: 'rtc-signaling',
                    admissionLink: { sourceObserved: 'matched', retained: 'matched' },
                    queueWaitMs: 0,
                    intraBatchWaitMs: 0,
                    durationMs: 0
                },
                { eventId: 'admission', dispatchLink: { sourceObserved: 'matched', retained: 'matched' } },
                { eventId: 'duplicate', dispatchLink: { sourceObserved: 'matched', retained: 'matched' } }
            ]
        });
    });

    it('retains local commit zeros while invalid identities vocabulary and legal numeric overflow remain null', () => {
        const history = toNotificationHistory(
            '{"name":"commit","agentId":"agent-a","atEpochMs":120,"value":{"topic":"rallar.browser.alm.outbound_diagnostics","payload":{"atEpochMs":119,"data":{"kind":"commit-phases","senderId":"","msgId":false,"typeId":"rtc-signaling","lane":"private-state","origin":"private-origin","commitOutcome":"private-outcome","readDurationMs":0,"readOperationCount":1e400,"commitDurationMs":-1,"route":{"token":"private-token"},"payload":{"candidate":"private-candidate"},"error":"private-error"}}}}'
        );
        expect(history).toMatchObject({
            observed: { malformedRows: 0, retainedRows: 1 },
            events: [{
                eventId: 'commit',
                senderId: null,
                msgId: null,
                typeId: 'rtc-signaling',
                lane: null,
                origin: null,
                commitOutcome: null,
                readDurationMs: 0,
                readOperationCount: null,
                commitDurationMs: null,
                observation: 'local-admission-store-commit-not-network-delivery'
            }]
        });
        expect(JSON.stringify(history)).not.toContain('private-');
    });

    it('uses exact durable and volatile lane ownership while excluding foreign workers agents subjects and non-null claim types', () => {
        const history = toNotificationHistory([
            toSignalingRow(admittedSignal, 'admission'),
            toSignalingRow({ ...dispatchedSignal, lane: 'volatile', workerId: 'worker/volatile' }, 'volatile'),
            toSignalingRow({ ...dispatchedSignal, workerId: 'worker/volatile' }, 'wrong-durable'),
            toSignalingRow({ ...dispatchedSignal, lane: 'volatile', workerId: 'worker/volatile-extra' }, 'wrong-volatile'),
            toSignalingRow({ ...dispatchedSignal, subjectMsgId: 'other' }, 'wrong-subject'),
            toSignalingRow({ ...dispatchedSignal, typeId: 'rtc-signaling' }, 'wrong-type'),
            toSignalingRow({ ...dispatchedSignal, typeId: undefined }, 'missing-type'),
            toSignalingRow(dispatchedSignal, 'wrong-agent', 'agent-b')
        ].join('\n'));
        expect(history).toMatchObject({
            observed: { filteredRows: 6, retainedRows: 2 },
            events: [
                { eventId: 'admission', dispatchLink: { sourceObserved: 'matched', retained: 'matched' } },
                { eventId: 'volatile', workerId: 'worker/volatile', lane: 'volatile', admissionLink: { sourceObserved: 'matched', retained: 'matched' } }
            ]
        });
    });

    it('retains RTC identity with ambiguous conflicting type observations and excludes an unqualified claim', () => {
        const history = toNotificationHistory([
            toSignalingRow(admittedSignal, 'rtc'),
            toSignalingRow({ ...admittedSignal, typeId: 'app-message' }, 'app-conflict'),
            toSignalingRow(dispatchedSignal, 'dispatch'),
            toSignalingRow({ ...dispatchedSignal, msgId: 'missing', subjectMsgId: 'missing' }, 'unqualified')
        ].join('\n'));
        expect(history).toMatchObject({
            observed: { retainedRows: 2, filteredRows: 2 },
            events: [
                { eventId: 'rtc', dispatchLink: { sourceObserved: 'ambiguous', retained: 'ambiguous' } },
                { eventId: 'dispatch', typeId: null, identifiedTypeId: null, admissionLink: { sourceObserved: 'ambiguous', retained: 'ambiguous' } }
            ]
        });
    });

    it('normalizes bounded identities finite vocabulary and numeric overflow without leaking sensitive extras', () => {
        const history = toNotificationHistory(
            [
                toSignalingRow({
                    ...admittedSignal,
                    workerId: 'w'.repeat(257),
                    msgId: '',
                    carrier: 'secret-extra',
                    outcome: 'secret-extra',
                    reason: 'secret-extra',
                    payload: { sdp: 'secret-extra' }
                }, 'invalid'),
                toSignalingRow({ ...admittedSignal, workerId: 'w'.repeat(256), msgId: 'm'.repeat(256), carrier: 'rtc', outcome: 'pending' }, 'boundary'),
                toSignalingRow({
                    ...dispatchedSignal,
                    attempts: -1,
                    durationMs: '0',
                    queueWaitMs: null,
                    startedAtMs: false,
                    dueAtMs: -1,
                    batchStartedAtMs: 0,
                    effectId: 'e'.repeat(257),
                    outcome: 'secret-extra',
                    error: 'secret-extra'
                }, 'claim'),
                toSignalingRow(admittedSignal, 'valid')
            ].join('\n').replace('"queueWaitMs":null', '"queueWaitMs":1e400')
        );
        expect(history).toMatchObject({
            events: [
                {
                    eventId: 'invalid',
                    workerId: null,
                    msgId: null,
                    carrier: null,
                    outcome: null,
                    dispatchLink: { sourceObserved: 'unknown', retained: 'unknown' }
                },
                { eventId: 'boundary', workerId: 'w'.repeat(256), msgId: 'm'.repeat(256), carrier: 'rtc', outcome: 'pending' },
                {
                    eventId: 'claim',
                    effectId: null,
                    attempts: null,
                    durationMs: null,
                    queueWaitMs: null,
                    startedAtMs: null,
                    dueAtMs: null,
                    batchStartedAtMs: 0,
                    intraBatchWaitMs: null,
                    outcome: null
                },
                { eventId: 'valid' }
            ]
        });
        expect(JSON.stringify(history)).not.toContain('secret-extra');
    });

    it('shares latest-event row eviction with lifecycle facts and distinguishes evicted admission from source-observed linkage', () => {
        const lifecycle =
            '{"name":"lifecycle","agentId":"agent-a","atEpochMs":120,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-created"}}}}';
        const history = toNotificationHistory([
            toSignalingRow(admittedSignal, 'evicted-admission'),
            ...Array(599).fill(lifecycle),
            toSignalingRow(dispatchedSignal, 'dispatch')
        ].join('\n'));
        expect(history).toMatchObject({
            coverage: 'incomplete',
            observed: { retainedRows: 600, outputDroppedRows: 1 },
            events: expect.arrayContaining([
                {
                    streamRow: 601,
                    eventId: 'dispatch',
                    agentId: 'agent-a',
                    kind: 'claim-settled',
                    controlAtEpochMs: 120,
                    runtimeAtEpochMs: 119,
                    workerId: 'worker',
                    effectId: 'dispatch',
                    msgId: 'signal',
                    subjectMsgId: 'signal',
                    typeId: null,
                    identifiedTypeId: 'rtc-signaling',
                    payloadKind: 'dispatch-local',
                    lane: 'durable',
                    outcome: 'completed',
                    attempts: 1,
                    queueWaitMs: 0,
                    durationMs: 0,
                    dueAtMs: 5,
                    batchStartedAtMs: 5,
                    startedAtMs: 5,
                    intraBatchWaitMs: 0,
                    observation: 'owned-work-settlement-not-selected-consumer-invocation',
                    admissionLink: { sourceObserved: 'matched', retained: 'unknown' }
                }
            ])
        });
        expect(JSON.stringify(history)).not.toContain('evicted-admission');
    });
});

describe('shared RTC signaling output and loss limits', () => {
    it('charges UTF8 bytes once across agent partitions and evicts oldest mixed facts under the shared serialized budget', () => {
        const workerId = '界'.repeat(247);
        const msgId = 'ø'.repeat(256);
        const lifecycle = JSON.stringify({
            name: 'last-lifecycle',
            agentId: 'agent-a',
            atEpochMs: 120,
            value: { topic: 'rallar.browser.rtc.lifecycle', payload: { atEpochMs: 119, data: { kind: 'peer-timeout' } } }
        });
        const rows = [lifecycle];
        for (let index = 0; index < 300; index += 1) {
            const agentId = index % 2 === 0 ? 'agent-a' : 'agent-b';
            rows.push(toSignalingRow({ ...admittedSignal, workerId, msgId }, `admission-${index}`, agentId));
            rows.push(toSignalingRow({ ...dispatchedSignal, workerId, msgId, subjectMsgId: msgId, effectId: 'é'.repeat(256) }, `claim-${index}`, agentId));
        }
        rows.push(lifecycle);
        const jsonl = rows.join('\n');
        const histories = toLiveRtcLifecycleHistory({
            jsonl,
            bytesRead: Buffer.byteLength(jsonl),
            retainedBytes: Buffer.byteLength(jsonl),
            retainedPrefixDropped: false,
            transportTruncated: false,
            failureInterval: { caseId: 'retention-100', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'current-cycle-before-close' },
            cycle: 8,
            agentIds: ['agent-a', 'agent-b']
        });
        const first = requiredJsonRecord(histories['agent-a'], 'agent-a');
        const second = requiredJsonRecord(histories['agent-b'], 'agent-b');
        const events = [...requiredJsonArray(first.events, 'events'), ...requiredJsonArray(second.events, 'events')];
        const eventBytes = events.reduce<number>((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0);
        expect(first).toMatchObject({
            observed: { scannedRows: 602, retainedRows: events.length, outputDroppedRows: 602 - events.length, outputBytes: eventBytes }
        });
        expect(second).toMatchObject({ observed: { retainedRows: events.length, outputBytes: eventBytes } });
        expect(events.length).toBeGreaterThan(0);
        expect(Buffer.byteLength(JSON.stringify(histories))).toBeLessThanOrEqual(262144);
        expect(JSON.stringify(histories)).not.toContain('admission-240');
        expect(first).toMatchObject({ events: expect.arrayContaining([expect.objectContaining({ eventId: 'last-lifecycle', streamRow: 602 })]) });
    });

    it('reports a source-observed dispatch as unknown in retained history when that settlement was evicted', () => {
        const lifecycle =
            '{"name":"lifecycle","agentId":"agent-a","atEpochMs":120,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-created"}}}}';
        const history = toNotificationHistory(
            [toSignalingRow(dispatchedSignal, 'evicted-dispatch'), ...Array(599).fill(lifecycle), toSignalingRow(admittedSignal, 'admission')].join('\n')
        );
        expect(history).toMatchObject({
            observed: { retainedRows: 600, outputDroppedRows: 1 },
            events: expect.arrayContaining([
                expect.objectContaining({ eventId: 'admission', dispatchLink: { sourceObserved: 'matched', retained: 'unknown' } })
            ])
        });
        expect(JSON.stringify(history)).not.toContain('evicted-dispatch');
    });

    it.each(['prefix', 'transport', 'row-cap', 'oversized', 'interval'])('cannot widen %s loss to recover a signaling counterpart', (loss) => {
        const admission = toSignalingRow(admittedSignal, 'admission');
        const dispatch = toSignalingRow(dispatchedSignal, 'dispatch');
        const unrelated = '{"atEpochMs":120,"agentId":"agent-a","value":{"topic":"unrelated","payload":{"data":{}}}}\n';
        const jsonl = loss === 'prefix'
            ? admission + '\n' + dispatch + '\n'
            : loss === 'transport'
            ? admission + '\n' + dispatch
            : loss === 'row-cap'
            ? admission + '\n' + unrelated.repeat(19999) + dispatch
            : loss === 'oversized'
            ? toSignalingRow({ ...admittedSignal, payload: 'private'.repeat(3000) }, 'oversized') + '\n' + dispatch
            : admission.replace('"atEpochMs":120', '"atEpochMs":99') + '\n' + dispatch;
        const history = toLiveRtcLifecycleHistory({
            jsonl,
            bytesRead: Buffer.byteLength(jsonl),
            retainedBytes: Buffer.byteLength(jsonl),
            retainedPrefixDropped: loss === 'prefix',
            transportTruncated: loss === 'transport',
            failureInterval: { caseId: 'retention-100', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'current-cycle-before-close' },
            cycle: 8,
            agentIds: ['agent-a']
        })['agent-a'];
        expect(history).toMatchObject({
            coverage: 'incomplete',
            events: loss === 'transport'
                ? [expect.objectContaining({ eventId: 'admission', dispatchLink: { sourceObserved: 'unknown', retained: 'unknown' } })]
                : []
        });
        expect(JSON.stringify(history)).not.toContain('private');
    });
});

describe('actual RTC consumer evidence', () => {
    const consumer = {
        kind: 'consumer-invocation',
        msgId: 'signal',
        typeId: 'rtc-signaling',
        carrier: 'ws',
        selection: 'exact-type',
        outcome: 'returned',
        beganAtMs: 0,
        settledAtMs: 5
    };
    const decision = {
        kind: 'dispatch-decision',
        msgId: 'signal',
        typeId: 'rtc-signaling',
        workerId: 'worker/volatile',
        effectId: 'dispatch',
        lane: 'volatile',
        carrier: 'ws',
        attempts: 1,
        atEpochMs: 4,
        disposition: 'port-returned'
    };

    it('keeps source-owned consumer settlement distinct from AL port completion without inventing a claim join', () => {
        const jsonl = [toSignalingRow(admittedSignal), toSignalingRow(decision), toSignalingRow(consumer)].join('\n');
        const history = requiredJsonRecord(toNotificationHistory(jsonl), 'history');
        expect(history).toMatchObject({ consumerClaimAssociation: 'unknown-message-level-observation-only', nativeApplication: 'unknown' });
        expect(requiredJsonArray(history.events, 'events')).toMatchObject([
            { kind: 'admission-outcome', dispatchLink: { sourceObserved: 'unknown', retained: 'unknown' } },
            {
                kind: 'dispatch-decision',
                workerId: 'worker/volatile',
                effectId: 'dispatch',
                lane: 'volatile',
                attempts: 1,
                producerAtEpochMs: 4,
                disposition: 'port-returned',
                observation: 'owned-dispatch-decision-not-selected-consumer-invocation'
            },
            {
                kind: 'consumer-invocation',
                msgId: 'signal',
                typeId: 'rtc-signaling',
                workerId: null,
                lane: null,
                effectId: null,
                attempts: null,
                selection: 'exact-type',
                outcome: 'returned',
                beganAtMs: 0,
                settledAtMs: 5,
                observation: 'exact-type-consumer-settlement-not-native-application'
            }
        ]);
    });

    it.each(['returned', 'retry', 'threw', 'not-invoked'])('retains literal %s with no arbitrary content', (outcome) => {
        const selection = outcome === 'not-invoked' ? 'absent' : 'exact-type';
        const history = toNotificationHistory(
            toSignalingRow({
                ...consumer,
                selection,
                outcome,
                error: 'private-sentinel',
                route: { credential: 'private-sentinel' },
                signal: { sdp: 'private-sentinel' }
            })
        );
        expect(history).toMatchObject({ events: [{ selection, outcome }] });
        expect(JSON.stringify(history)).not.toContain('private-sentinel');
    });

    it('does not fabricate unknown identity or timing from null, false, numeric overflow, or oversized values', () => {
        const jsonl = toSignalingRow({
            ...consumer,
            msgId: 'm'.repeat(257),
            beganAtMs: false,
            settledAtMs: null,
            selection: 'private-sentinel',
            outcome: 'private-sentinel',
            workerId: 'invented',
            attempts: 99
        });
        expect(toNotificationHistory(jsonl)).toMatchObject({
            events: [{ msgId: null, workerId: null, attempts: null, selection: null, outcome: null, beganAtMs: null, settledAtMs: null }]
        });
        expect(toNotificationHistory(toSignalingRow({ ...decision, workerId: null, effectId: false, attempts: 0, atEpochMs: -1 }))).toMatchObject({
            events: [{ workerId: null, effectId: null, attempts: 0, producerAtEpochMs: null }]
        });
        expect(toNotificationHistory(toSignalingRow(consumer).replace('"settledAtMs":5', '"settledAtMs":1e400'))).toMatchObject({
            events: [{ settledAtMs: null }]
        });
    });

    it('does not borrow type or identity from another message, worker, agent or conflicting admission', () => {
        const rows = [
            toSignalingRow({ ...admittedSignal, typeId: 'app-type' }),
            toSignalingRow(admittedSignal),
            toSignalingRow({ ...consumer, typeId: null }),
            toSignalingRow({ ...consumer, typeId: 'app-type' }),
            toSignalingRow({ ...consumer, msgId: 'other' }, 'other-message'),
            toSignalingRow(consumer, 'other-agent', 'agent-z'),
            toSignalingRow({ ...decision, workerId: 'other-worker', typeId: null }),
            toSignalingRow({ ...decision, msgId: 'other', typeId: null }),
            toSignalingRow({ ...decision, typeId: null }, 'ambiguous-decision'),
            toSignalingRow(consumer, 'typed-consumer')
        ];
        expect(toNotificationHistory(rows.join('\n'))).toMatchObject({
            events: [
                { kind: 'admission-outcome' },
                { eventId: 'other-message', msgId: 'other', typeId: 'rtc-signaling' },
                { eventId: 'typed-consumer', msgId: 'signal', typeId: 'rtc-signaling' }
            ]
        });
    });

    it('leaves missing and evicted consumer counterparts unknown under the one mixed event budget', () => {
        const rows = [toSignalingRow(consumer), ...Array.from({ length: 600 }, (_, index) => toSignalingRow({ ...decision, msgId: `signal-${index}` }))];
        const history = requiredJsonRecord(toNotificationHistory(rows.join('\n')), 'history');
        const events = requiredJsonArray(history.events, 'events');
        expect(events.length).toBeGreaterThan(0);
        expect(events.length).toBeLessThanOrEqual(600);
        expect(events.every((event) => requiredJsonRecord(event, 'event').kind === 'dispatch-decision')).toBe(true);
        expect(history).toMatchObject({
            consumerClaimAssociation: 'unknown-message-level-observation-only',
            observed: { outputDroppedRows: 601 - events.length, retainedRows: events.length }
        });
        expect(requiredJsonRecord(history.observed, 'observed').outputBytes).toBe(
            events.reduce<number>((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0)
        );
    });
});

describe('existing-owner command failure evidence', () => {
    const http = {
        kind: 'http-request-failed',
        commandId: 'http',
        phase: 'body',
        scopeAborted: true,
        scopeAbortOrigin: 'timeout'
    };
    const formation = {
        kind: 'formation-readiness-rejected',
        roomTransportState: 'idle',
        summaryAvailable: true,
        roomOpen: false,
        hasDesiredPeers: true,
        desiredPeerCount: 2,
        readyPeerCount: 0,
        waitTerminalCause: 'unknown'
    };
    const row = (topic: string, data: object) =>
        JSON.stringify({
            agentId: 'agent-a',
            atEpochMs: 120,
            name: 'failure',
            value: { topic, payload: { atEpochMs: 119, data } }
        });

    it('retains finite HTTP and captured formation facts in the same history while excluding raw failure data', () => {
        const history = toNotificationHistory([
            row('rallar.bb.http.failure', { ...http, error: 'private-sentinel', url: 'private-sentinel' }),
            row('rallar.browser.formation.not-ready', { ...formation, reason: 'private-sentinel', peers: ['private-sentinel'] })
        ].join('\n'));
        expect(history).toMatchObject({
            events: [
                { ...http, observation: 'http-request-failure-with-owned-scope-state' },
                { ...formation, observation: 'captured-room-wait-result-at-formation-rejection' }
            ]
        });
        expect(JSON.stringify(history)).not.toContain('private-sentinel');
    });

    it('does not infer an abort or terminal wait cause from invalid or arbitrary values', () => {
        const history = toNotificationHistory([
            row('rallar.bb.http.failure', {
                ...http,
                commandId: 'x'.repeat(257),
                phase: 'private-phase',
                scopeAborted: 'false',
                scopeAbortOrigin: 'AbortError'
            }),
            row('rallar.browser.formation.not-ready', {
                ...formation,
                roomTransportState: 'private-state',
                summaryAvailable: 0,
                desiredPeerCount: false,
                readyPeerCount: -1,
                waitTerminalCause: 'timeout'
            }),
            row('unrelated', http)
        ].join('\n'));
        expect(history).toMatchObject({
            observed: { retainedRows: 2, filteredRows: 1 },
            events: [
                { commandId: null, phase: null, scopeAborted: null, scopeAbortOrigin: null },
                { roomTransportState: null, summaryAvailable: null, desiredPeerCount: null, readyPeerCount: null, waitTerminalCause: 'unknown' }
            ]
        });
    });

    it('charges new failure facts to the existing mixed row budget', () => {
        const history = toNotificationHistory([
            toSignalingRow(admittedSignal),
            ...Array.from({ length: 599 }, () => row('rallar.bb.http.failure', http)),
            row('rallar.browser.formation.not-ready', formation)
        ].join('\n'));
        expect(history).toMatchObject({ coverage: 'incomplete', observed: { retainedRows: 600, outputDroppedRows: 1 } });
        const retained = requiredJsonRecord(history, 'history');
        const events = requiredJsonArray(retained.events, 'events');
        expect(events[0]).toMatchObject({ kind: 'http-request-failed' });
        expect(events.at(-1)).toMatchObject({ kind: 'formation-readiness-rejected' });
        expect(requiredJsonRecord(retained.observed, 'observed').outputBytes).toBe(
            events.reduce<number>((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0)
        );
    });

    it('shares the compact UTF-8 byte budget across agents and failure kinds', () => {
        const jsonl = Array.from({ length: 600 }, (_, index) =>
            JSON.stringify({
                agentId: ['agent-a', 'agent-b', 'agent-c'][index % 3],
                atEpochMs: 120,
                name: `failure-${index}`,
                value: {
                    topic: index % 10 === 0 ? 'rallar.browser.formation.not-ready' : 'rallar.bb.http.failure',
                    payload: { atEpochMs: 119, data: index % 10 === 0 ? formation : { ...http, commandId: '界'.repeat(256) } }
                }
            })).join('\n');
        const histories = toLiveRtcLifecycleHistory({
            jsonl,
            bytesRead: Buffer.byteLength(jsonl),
            retainedBytes: Buffer.byteLength(jsonl),
            retainedPrefixDropped: false,
            transportTruncated: false,
            agentIds: ['agent-a', 'agent-b', 'agent-c'],
            cycle: null,
            failureInterval: { caseId: 'all-scenarios', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'attempt-phase-unspecified' }
        });
        const events = Object.values(histories).flatMap((history) => requiredJsonArray(requiredJsonRecord(history, 'history').events, 'events'));
        const bytes = events.reduce<number>((total, event) => total + Buffer.byteLength(JSON.stringify(event)), 0);
        expect(events.length).toBeLessThan(600);
        expect(bytes).toBeLessThanOrEqual(262_144);
        expect(events.some((event) => requiredJsonRecord(event, 'event').kind === 'formation-readiness-rejected')).toBe(true);
        for (const history of Object.values(histories)) {
            expect(history).toMatchObject({ coverage: 'incomplete', observed: { outputDroppedRows: 600 - events.length, outputBytes: bytes } });
        }
    });
});

describe('owned native signaling projection', () => {
    it('keeps three distinct clocks and finite eligibility/release facts without raw data or an AL join', () => {
        const history = toNotificationHistory([
            '{"name":"route","agentId":"agent-a","atEpochMs":120,"value":{"topic":"rallar.browser.rtc.signaling_diagnostics","payload":{"atEpochMs":119,"data":{"kind":"service-signal-route","disposition":"reuse-selected","atEpochMs":118,"localSessionId":"a","peerSessionId":"b","signalType":"Answer","offerId":"offer","msgId":"private-sentinel","reason":"private-sentinel"}}}}',
            '{"name":"native","agentId":"agent-a","atEpochMs":120,"value":{"topic":"rallar.browser.rtc.signaling_diagnostics","payload":{"atEpochMs":119,"data":{"kind":"native-signal-decision","disposition":"answer-ineligible","atEpochMs":0,"localSessionId":"a","peerSessionId":"b","signalType":"Answer","offerId":"offer","capturedPeerConnection":true,"currentPeerConnection":true,"offerMatches":false,"signalingState":"have-local-offer","outstandingOfferId":"private-sentinel","payload":"private-sentinel"}}}}',
            '{"name":"release","agentId":"agent-a","atEpochMs":120,"value":{"topic":"rallar.browser.rtc.signaling_diagnostics","payload":{"atEpochMs":119,"data":{"kind":"signal-caller-release","disposition":"lifetime-retired","atEpochMs":118,"localSessionId":"a","peerSessionId":"b","signalType":"IceCandidate","capturedPeerConnection":true,"currentPeerConnection":false,"error":"private-sentinel","generation":"private-sentinel"}}}}'
        ].join('\n'));
        expect(history).toMatchObject({
            nativeApplication: 'unknown',
            nativeGenerationAndDeletionIssuer: 'unknown',
            consumerClaimAssociation: 'unknown-message-level-observation-only',
            events: [
                { kind: 'service-signal-route', disposition: 'reuse-selected', producerAtEpochMs: 118, runtimeAtEpochMs: 119, controlAtEpochMs: 120 },
                { kind: 'native-signal-decision', currentPeerConnection: true, offerMatches: false, signalingState: 'have-local-offer', producerAtEpochMs: 0 },
                { kind: 'signal-caller-release', disposition: 'lifetime-retired', currentPeerConnection: false, offerId: null }
            ]
        });
        expect(JSON.stringify(history)).not.toContain('private-sentinel');
    });

    it('keeps absent invalid and nonfinite native facts unavailable instead of inventing success', () => {
        const history = toNotificationHistory([
            '{"name":"invalid","agentId":"agent-a","atEpochMs":120,"value":{"topic":"rallar.browser.rtc.signaling_diagnostics","payload":{"data":{"kind":"native-signal-decision","disposition":"answer-ineligible","atEpochMs":1e999,"currentPeerConnection":"false","offerMatches":0,"signalingState":"private-sentinel","signalType":"private-sentinel","offerId":"private-offer-sentinel"}}}}',
            '{"name":"absent-type","agentId":"agent-a","atEpochMs":120,"value":{"topic":"rallar.browser.rtc.signaling_diagnostics","payload":{"data":{"kind":"native-signal-decision","disposition":"application-returned","offerId":"private-offer-sentinel"}}}}',
            '{"name":"unknown","agentId":"agent-a","atEpochMs":120,"value":{"topic":"rallar.browser.rtc.signaling_diagnostics","payload":{"data":{"kind":"native-signal-decision","disposition":"private-sentinel"}}}}'
        ].join('\n'));
        expect(history).toMatchObject({
            events: [{
                disposition: 'answer-ineligible',
                offerId: null,
                producerAtEpochMs: null,
                capturedPeerConnection: null,
                currentPeerConnection: null,
                offerMatches: null,
                signalingState: null,
                signalType: null,
                localSessionId: null,
                peerSessionId: null
            }, { offerId: null, signalType: null }]
        });
        expect(JSON.stringify(history)).not.toContain('private-sentinel');
    });

    it('shares old and new mixed retention rather than adding a second native history', () => {
        const nativeRow =
            '{"name":"release","agentId":"agent-a","atEpochMs":120,"value":{"topic":"rallar.browser.rtc.signaling_diagnostics","payload":{"data":{"kind":"signal-caller-release","disposition":"application-returned","atEpochMs":118,"capturedPeerConnection":true,"currentPeerConnection":true}}}}';
        const oldRow =
            '{"name":"created","agentId":"agent-a","atEpochMs":120,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-created","peerId":"b"}}}}';
        const history = requiredJsonRecord(toNotificationHistory([oldRow, ...Array.from({ length: 600 }, () => nativeRow)].join('\n')), 'history');
        const events = requiredJsonArray(history.events, 'events');
        expect(events.length).toBeGreaterThan(0);
        expect(events.length).toBeLessThanOrEqual(600);
        expect(events.every((event) => requiredJsonRecord(event, 'event').kind === 'signal-caller-release')).toBe(true);
        expect(history).toMatchObject({ coverage: 'incomplete', observed: { outputDroppedRows: 601 - events.length, retainedRows: events.length } });
        expect(requiredJsonRecord(history.observed, 'observed').outputBytes).toBe(
            events.reduce<number>((n, event) => n + Buffer.byteLength(JSON.stringify(event)), 0)
        );
    });
});

describe('captured readiness identity validation', () => {
    function row(data: object): string {
        return JSON.stringify({
            agentId: 'agent-a',
            atEpochMs: 120,
            name: 'capture',
            value: {
                topic: 'rallar.browser.formation.not-ready',
                payload: { atEpochMs: 119, data: { kind: 'formation-readiness-rejected', ...data } }
            }
        });
    }

    it('keeps upstream identity loss and duplicates across repeated projection', () => {
        const first = requiredJsonRecord(
            toNotificationHistory(row({
                returnedRoomReason: 'Room RTC wait ended with timeout.',
                laneId: 'messages.rtc',
                desiredPeerIds: ['c', 'b', 'b'],
                readyPeerIds: ['b'],
                peerIdentitiesTruncated: true,
                error: 'private-sentinel',
                native: { sdp: 'private-sentinel' }
            })),
            'history'
        );
        const event = requiredJsonRecord(requiredJsonArray(first.events, 'events')[0], 'event');
        expect(event).toMatchObject({
            returnedRoomReason: 'Room RTC wait ended with timeout.',
            laneId: 'messages.rtc',
            desiredPeerIds: ['c', 'b', 'b'],
            readyPeerIds: ['b'],
            peerIdentitiesTruncated: true,
            waitTerminalCause: 'unknown'
        });
        const second = toNotificationHistory(row(event));
        expect(requiredJsonRecord(second, 'second history').events).toEqual(first.events);
        expect(JSON.stringify(second)).not.toContain('private-sentinel');
    });

    it.each([
        {},
        { returnedRoomReason: 'private-sentinel', laneId: '', desiredPeerIds: ['b', 3], readyPeerIds: false, peerIdentitiesTruncated: 'false' },
        { returnedRoomReason: false, laneId: 'l'.repeat(257), desiredPeerIds: ['p'.repeat(257)], readyPeerIds: null, peerIdentitiesTruncated: null }
    ])('leaves invalid or absent captured facts unavailable: %o', (facts) => {
        const history = toNotificationHistory(row(facts));
        expect(history).toMatchObject({
            events: [{
                returnedRoomReason: null,
                laneId: null,
                desiredPeerIds: null,
                readyPeerIds: null,
                peerIdentitiesTruncated: null,
                waitTerminalCause: 'unknown'
            }]
        });
        expect(JSON.stringify(history)).not.toContain('private-sentinel');
    });
});

describe('partial captured readiness association', () => {
    it.each([
        { facts: { desiredPeerIds: ['c', 'b', 'b'], peerIdentitiesTruncated: false }, expected: { desiredPeerIds: ['c', 'b', 'b'], readyPeerIds: null } },
        { facts: { desiredPeerIds: [3], readyPeerIds: ['b'], peerIdentitiesTruncated: false }, expected: { desiredPeerIds: null, readyPeerIds: ['b'] } }
    ])('retains the valid list while the unavailable counterpart stays unknown: %o', ({ facts, expected }) => {
        const jsonl = JSON.stringify({
            agentId: 'agent-a',
            atEpochMs: 120,
            name: 'partial',
            value: {
                topic: 'rallar.browser.formation.not-ready',
                payload: { atEpochMs: 119, data: { kind: 'formation-readiness-rejected', ...facts } }
            }
        });
        expect(toNotificationHistory(jsonl)).toMatchObject({ events: [{ ...expected, peerIdentitiesTruncated: null, waitTerminalCause: 'unknown' }] });
    });
});

describe('serialized original native evidence', () => {
    it('retains mandatory native fields and partial capability evidence through browser, runtime and control JSONL', () => {
        const native = nativeSnapshotFixture();
        const capture = native.capture;
        const jsonl = serializeNativeRows([
            { kind: 'native-observation-status', stage: 'initialized', availability: { status: 'observed', value: 'enabled' }, capture },
            { kind: 'native-lifetime', action: 'retiring', retirement: 'channel-error', native }
        ]);
        const history = toNotificationHistory(jsonl);
        expect(history).toMatchObject({
            nativeObservation: {
                status: 'observations-present',
                coverage: 'bounded-partial',
                capability: { status: 'observed', value: 'enabled' },
                malformedRows: false
            },
            events: [expect.anything(), { native }]
        });
    });

    it('serializes maximum-shape native variants within unchanged source and control bounds', () => {
        const native = nativeSnapshotFixture();
        const identity = { peerConnectionId: { status: 'observed', value: 'p'.repeat(128) }, channelId: { status: 'observed', value: 'c'.repeat(128) } };
        const capture = { ...native.capture, scopeId: { status: 'observed', value: 's'.repeat(64) } };
        const error = {
            identity,
            nativeSequence: Number.MAX_SAFE_INTEGER,
            source: 'channel-error',
            errorDetail: { status: 'observed', value: 'hardware-encoder-not-available' },
            sctpCauseCode: { status: 'observed', value: 65535 },
            receivedAlert: { status: 'observed', value: 255 },
            sentAlert: { status: 'observed', value: 255 },
            iceErrorCode: { status: 'observed', value: 701 },
            exceptionName: { status: 'observed', value: 'InvalidStateError' }
        };
        const observed = { status: 'observed', value: error, coverage: native.firstError.coverage };
        const complete = { ...native, identity, capture, firstError: observed, firstTypedError: observed };
        const service = {
            peerId: 'p'.repeat(256),
            setupId: identity.peerConnectionId,
            setup: { peerId: 'p'.repeat(256), phase: 'established', startedAtEpochMs: 1, establishedAtEpochMs: 2 },
            native: complete,
            channels: Array.from({ length: 4 }, () => ({ identity, channelState: { status: 'observed', value: 'closed' } })),
            channelCount: 4,
            channelsTruncated: false,
            capture
        };
        const candidate = {
            operationOrdinal: 1,
            applicationOrdinal: 0,
            source: 'direct',
            currentPeerConnection: false,
            identity,
            fragmentPresence: 'present',
            dataIceFragmentComparison: 'different',
            comparisonReadout: { status: 'observed', value: 'available' },
            targetTransportAssociation: 'unknown',
            iceGenerationAssociation: 'unknown',
            capture
        };
        const rows = [
            { kind: 'native-lifetime', action: 'created', native: complete },
            { kind: 'native-lifetime', action: 'retiring', retirement: 'channel-error', native: complete },
            { kind: 'native-state', trigger: 'transport-attached', native: complete },
            { kind: 'native-first-error', first: 'both', native: complete, error },
            {
                kind: 'native-candidate-application',
                signalType: 'IceCandidate',
                candidate: {
                    ...candidate,
                    stage: 'submitted',
                    error: { status: 'unavailable', reason: 'not-applicable', coverage: { kind: 'native-operation', stage: 'pending' } }
                }
            },
            {
                kind: 'native-candidate-application',
                signalType: 'IceCandidate',
                candidate: { ...candidate, stage: 'returned', error: { status: 'none-observed', coverage: { kind: 'native-operation', stage: 'settled' } } }
            },
            {
                kind: 'native-candidate-application',
                signalType: 'IceCandidate',
                candidate: {
                    ...candidate,
                    stage: 'rejected',
                    error: { status: 'observed', value: { ...error, source: 'candidate-rejection' }, coverage: { kind: 'native-operation', stage: 'settled' } }
                }
            },
            {
                kind: 'service-peer-observation',
                service: {
                    ...service,
                    stage: 'setup-established',
                    issuer: { status: 'unavailable', reason: 'not-applicable' },
                    timeout: { status: 'unavailable', reason: 'not-applicable' }
                }
            },
            {
                kind: 'service-peer-observation',
                service: {
                    ...service,
                    stage: 'terminating',
                    issuer: { status: 'observed', value: 'disconnect-peer' },
                    timeout: { status: 'unavailable', reason: 'not-applicable' }
                }
            },
            {
                kind: 'service-peer-observation',
                service: {
                    ...service,
                    stage: 'establishment-timeout',
                    issuer: { status: 'observed', value: 'establishment-timeout' },
                    timeout: {
                        status: 'observed',
                        value: { peerId: 'p'.repeat(256), reason: 'peer-establishment-timeout', startedAtEpochMs: 1, timedOutAtEpochMs: 3, timeoutMs: 2 }
                    },
                    watchStartedAtEpochMs: 1,
                    watchTimedOutAtEpochMs: 3,
                    removalDisposition: 'original-removed'
                }
            },
            { kind: 'native-observation-status', stage: 'initialized', availability: { status: 'observed', value: 'enabled' }, capture },
            { kind: 'native-observation-limit', limit: 'admission', identity, capture },
            {
                kind: 'native-observation-unavailable',
                originalKind: 'native-lifetime',
                reason: 'payload-bytes',
                identity,
                setupId: identity.peerConnectionId,
                capture
            }
        ];
        const bounded = rows.map((row) => ({ localSessionId: 'l'.repeat(256), peerSessionId: 'r'.repeat(256), atEpochMs: 118, ...row }));
        expect(Math.max(...bounded.map((row) => Buffer.byteLength(JSON.stringify(row))))).toBeLessThanOrEqual(8192);
        const jsonl = serializeNativeRows(bounded);
        expect(Math.max(...jsonl.split('\n').map((line) => Buffer.byteLength(line)))).toBeLessThanOrEqual(16384);
        const history = requiredJsonRecord(toNotificationHistory(jsonl), '$');
        expect(requiredJsonArray(history.events, '$.events')).toHaveLength(rows.length);
        expect(history.nativeObservation).toMatchObject({ malformedRows: false, sourceAdmissionLimited: true, sourcePayloadLimited: true });
        for (const row of rows) {
            for (const poisoned of poisonNativeWireObjects(normalizeJson(row))) {
                const rejected = toNotificationHistory(serializeNativeRows([requiredJsonRecord(normalizeJson(poisoned), '$')]));
                expect(rejected).toMatchObject({ events: [], nativeObservation: { malformedRows: true } });
                expect(JSON.stringify(rejected)).not.toContain('private-');
            }
        }
    });

    it('reports the shared suffix as partial and never borrows enabled capability across scopes', () => {
        const native = nativeSnapshotFixture();
        const rows = Array.from({ length: 650 }, () => ({ kind: 'native-lifetime', action: 'retiring', retirement: 'reset', native }));
        const history = requiredJsonRecord(toNotificationHistory(serializeNativeRows(rows)), '$');
        expect(history.nativeObservation).toMatchObject({
            coverage: 'bounded-partial',
            artifactTruncated: true,
            capability: { status: 'unavailable', reason: 'absent' }
        });
        expect(requiredJsonArray(history.events, '$.events').length).toBeLessThanOrEqual(600);
        expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThanOrEqual(262144);
        const mixed = toNotificationHistory(serializeNativeRows([
            { kind: 'native-observation-status', stage: 'initialized', availability: { status: 'observed', value: 'enabled' }, capture: native.capture },
            {
                kind: 'native-lifetime',
                action: 'created',
                native: { ...native, capture: { ...native.capture, scopeId: { status: 'observed', value: 'other' } } }
            }
        ]));
        expect(mixed).toMatchObject({ nativeObservation: { capability: { status: 'unavailable', reason: 'absent' } } });
    });

    it.each([undefined, null, { kind: 'listener-window', window: 'invalid', attachment: 'attached', attachmentGap: false }])(
        'rejects malformed nested error coverage: %s',
        (coverage) => {
            const native = nativeSnapshotFixture();
            const jsonl = serializeNativeRows([{
                kind: 'native-lifetime',
                action: 'retiring',
                retirement: 'reset',
                native: { ...native, firstError: { status: 'none-observed', coverage } }
            }]);
            expect(toNotificationHistory(jsonl)).toMatchObject({ events: [], nativeObservation: { status: 'unavailable', malformedRows: true } });
        }
    );

    it.each(['snapshot', 'state', 'error', 'coverage', 'identity', 'capture'] as const)('rejects raw private keys at the nested %s boundary', (boundary) => {
        const native = nativeSnapshotFixture();
        const poison = {
            sdp: 'private-sdp',
            usernameFragment: 'private-fragment',
            address: 'private-address',
            password: 'private-password',
            message: 'private-error'
        };
        const poisoned = boundary === 'snapshot'
            ? { ...native, ...poison }
            : boundary === 'coverage'
            ? { ...native, firstError: { ...native.firstError, coverage: { ...native.firstError.coverage, ...poison } } }
            : boundary === 'error'
            ? { ...native, firstError: { ...native.firstError, ...poison } }
            : { ...native, [boundary]: { ...native[boundary], ...poison } };
        const history = toNotificationHistory(serializeNativeRows([{ kind: 'native-lifetime', action: 'retiring', retirement: 'reset', native: poisoned }]));
        expect(history).toMatchObject({ events: [], nativeObservation: { malformedRows: true } });
        expect(JSON.stringify(history)).not.toContain('private-');
    });
});

function nativeSnapshotFixture() {
    const unavailable = { status: 'unavailable', reason: 'absent' };
    const coverage = { kind: 'listener-window', window: 'ended-at-retirement', attachment: 'partial', attachmentGap: true };
    return {
        identity: { peerConnectionId: { status: 'observed', value: 'scope-pc-1' }, channelId: { status: 'observed', value: 'scope-channel-2' } },
        nativeSequence: 1,
        capture: {
            scopeId: { status: 'observed', value: 'scope' },
            scope: 'active',
            ordinaryRowsSuppressed: false,
            admissionLimited: false,
            payloadLimited: false
        },
        state: {
            connectionState: unavailable,
            iceConnectionState: unavailable,
            iceGatheringState: unavailable,
            signalingState: unavailable,
            iceTransportState: unavailable,
            dtlsState: unavailable,
            sctpState: unavailable,
            channelState: { status: 'observed', value: 'closed' },
            transportObjectOrdinal: unavailable,
            transportBinding: 'unavailable',
            listenerCoverage: 'partial',
            attachmentGap: true
        },
        firstError: { status: 'none-observed', coverage },
        firstTypedError: { status: 'unavailable', reason: 'unsupported', coverage }
    };
}

function serializeNativeRows(rows: readonly object[]): string {
    const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({ now: () => 120 });
    const diagnostics = new BlackBoxRallarRuntimeDiagnostics({
        now: () => 119,
        publish: (event) =>
            runtime.recordEvent(
                toRallarBrowserEventInput({
                    ...event,
                    roomRef: event.roomRef ? { ...event.roomRef } : undefined,
                    scope: event.scope ? { ...event.scope } : undefined
                })
            ),
        onPublishError: (error) => {
            throw error;
        },
        transportOf: () => 'realtime',
        laneIdOf: () => 'realtime',
        scopeDiagnostics: () => ({})
    });
    for (const row of rows) {
        diagnostics.emit({
            kind: 'diagnostic',
            topic: 'rallar.browser.rtc.signaling_diagnostics',
            data: { localSessionId: 'self', peerSessionId: 'peer', atEpochMs: 118, ...row }
        });
    }
    return runtime.state().events.map((event) => controlEventArtifactJsonl(toControlEventEnvelope(event, 'run', 'agent-a'))).join('');
}

function poisonNativeWireObjects(value: ApiJsonValue): ApiJsonValue[] {
    if (Array.isArray(value)) {
        return value.flatMap((child, index) =>
            poisonNativeWireObjects(child).map((poisoned) => value.map((original, childIndex) => childIndex === index ? poisoned : original))
        );
    }
    if (value === null || typeof value !== 'object') {
        return [];
    }
    const poison = {
        sdp: 'private-sdp',
        usernameFragment: 'private-fragment',
        address: 'private-address',
        password: 'private-password',
        message: 'private-error'
    };
    return [
        { ...value, ...poison },
        ...Object.entries(value).flatMap(([key, child]) => poisonNativeWireObjects(child).map((poisoned) => ({ ...value, [key]: poisoned })))
    ];
}
