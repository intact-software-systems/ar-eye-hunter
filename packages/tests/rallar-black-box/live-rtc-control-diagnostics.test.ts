import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultLiveRtcControlHttpFixture, LiveRtcControlHttpFixture } from './live-rtc-control-http-fixture.ts';

describe('live RTC control client', () => {
    let httpFixture: LiveRtcControlHttpFixture;
    beforeEach(async () => {
        httpFixture = await createDefaultLiveRtcControlHttpFixture();
    });
    afterEach(async () => {
        await httpFixture.close();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });
    it('retains one sanitized recorder sequence partitioned by actual failure agents before output', async () => {
        httpFixture.state.recorderJsonl = [
            '{"name":"outside","agentId":"agent-a","atEpochMs":90,"value":{"topic":"rallar.browser.rtc.lifecycle","atEpochMs":90,"payload":{"data":{"kind":"peer-created","atEpochMs":90,"peerId":"old"},"atEpochMs":90}}}',
            '{"name":"created","agentId":"agent-a","atEpochMs":110,"value":{"topic":"rallar.browser.rtc.lifecycle","atEpochMs":110,"payload":{"data":{"kind":"peer-created","atEpochMs":108,"peerId":"session-c","status":{"credential":"secret-history-sentinel"},"sdp":"secret-history-sentinel"},"atEpochMs":109}}}',
            '{"name":"timeout","agentId":"agent-a","atEpochMs":120,"value":{"topic":"rallar.browser.rtc.lifecycle","atEpochMs":120,"payload":{"data":{"kind":"peer-timeout","atEpochMs":107,"peerId":"session-c","reason":"secret-history-sentinel"},"atEpochMs":119}}}',
            '{"name":"deleted","agentId":"agent-c","atEpochMs":130,"value":{"topic":"rallar.browser.rtc.lifecycle","atEpochMs":130,"payload":{"data":{"kind":"peer-deleted","atEpochMs":128,"peerId":"session-a"},"atEpochMs":129}}}',
            '{"name":"lane","agentId":"agent-b","atEpochMs":140,"value":{"topic":"rallar.browser.rtc.lifecycle","atEpochMs":140,"payload":{"data":{"kind":"lane-open","atEpochMs":138,"peerId":"session-a","laneId":"realtime","candidate":"secret-history-sentinel"},"atEpochMs":139}}}',
            '{"name":"unrelated","agentId":"agent-a","atEpochMs":145,"value":{"topic":"console","payload":{"data":{"kind":"peer-created","atEpochMs":145}},"atEpochMs":145}}',
            '{"name":"other-agent","agentId":"agent-z","atEpochMs":146,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-created","atEpochMs":146}},"atEpochMs":146}}',
            '{"name":"after","agentId":"agent-a","atEpochMs":160,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-deleted","atEpochMs":160}},"atEpochMs":160}}'
        ].join('\n') + '\n';
        const captured = await httpFixture.control.captureDiagnostics({
            testInfo: {
                attach: async () => {
                    httpFixture.state.captureEffects.push('output');
                    httpFixture.state.recorderJsonl = '';
                }
            },
            runId: 'failure-run',
            agents: [{ prefix: 'A', agentId: 'agent-a' }, { prefix: 'B', agentId: 'agent-b' }, { prefix: 'C', agentId: 'agent-c' }],
            label: 'attempt-failure-later-health',
            cycle: 12,
            failureInterval: { caseId: 'retention-100', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'current-cycle-before-close' }
        });
        expect(captured.checkpoint.agents[0].details).toMatchObject({
            lifecycleHistory: {
                coverage: 'unknown',
                recorderOrigin: 'unknown',
                requestedInterval: { caseId: 'retention-100', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'current-cycle-before-close' },
                observed: { firstControlAtEpochMs: 90, lastControlAtEpochMs: 160, scannedRows: 8, retainedRows: 4, filteredRows: 4 },
                events: [
                    {
                        streamRow: 2,
                        eventId: 'created',
                        agentId: 'agent-a',
                        kind: 'peer-created',
                        controlAtEpochMs: 110,
                        runtimeAtEpochMs: 109,
                        browserAtEpochMs: 108,
                        peerId: 'session-c',
                        laneId: null
                    },
                    {
                        streamRow: 3,
                        eventId: 'timeout',
                        agentId: 'agent-a',
                        kind: 'peer-timeout',
                        controlAtEpochMs: 120,
                        runtimeAtEpochMs: 119,
                        browserAtEpochMs: 107,
                        peerId: 'session-c',
                        laneId: null
                    }
                ]
            }
        });
        expect(captured.checkpoint.agents[1].details).toMatchObject({ lifecycleHistory: { events: [{ eventId: 'lane', laneId: 'realtime' }] } });
        expect(captured.checkpoint.agents[2].details).toMatchObject({ lifecycleHistory: { events: [{ eventId: 'deleted' }] } });
        expect(JSON.stringify(captured)).not.toContain('secret-history-sentinel');
        expect(httpFixture.state.recorderReads).toBe(1);
        expect(httpFixture.state.captureEffects).toEqual(['health:agent-a', 'health:agent-b', 'health:agent-c', 'history', 'output']);
    });

    it('captures owned native decisions once after health without claiming application receipts', async () => {
        httpFixture.state.recorderJsonl =
            '{"name":"native","agentId":"agent-a","atEpochMs":120,"value":{"topic":"rallar.browser.rtc.signaling_diagnostics","payload":{"atEpochMs":119,"data":{"kind":"native-signal-decision","disposition":"answer-ineligible","atEpochMs":118,"localSessionId":"a","peerSessionId":"b","signalType":"Answer","offerId":"offer","capturedPeerConnection":true,"currentPeerConnection":true,"offerMatches":false,"signalingState":"have-local-offer","error":"private-native-sentinel","payload":"private-native-sentinel"}}}}';
        const captured = await httpFixture.control.captureDiagnostics({
            testInfo: {
                attach: async () => {
                    httpFixture.state.captureEffects.push('output');
                }
            },
            runId: 'failure-run',
            agents: [{ prefix: 'A', agentId: 'agent-a' }, { prefix: 'B', agentId: 'agent-b' }, { prefix: 'C', agentId: 'agent-c' }],
            label: 'attempt-failure-later-health',
            cycle: 1,
            failureInterval: { caseId: 'retention-100', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'current-cycle-before-close' }
        });
        expect(httpFixture.state.recorderReads).toBe(1);
        expect(httpFixture.state.captureEffects).toEqual(['health:agent-a', 'health:agent-b', 'health:agent-c', 'history', 'output']);
        expect(captured.checkpoint.agents[0].details).toMatchObject({
            lifecycleHistory: {
                nativeApplication: 'unknown',
                nativeGenerationAndDeletionIssuer: 'unknown',
                events: [{
                    kind: 'native-signal-decision',
                    disposition: 'answer-ineligible',
                    producerAtEpochMs: 118,
                    runtimeAtEpochMs: 119,
                    controlAtEpochMs: 120,
                    currentPeerConnection: true,
                    offerMatches: false,
                    signalingState: 'have-local-offer'
                }]
            }
        });
        expect(JSON.stringify(captured)).not.toContain('private-native-sentinel');
    });

    it('captures literal selected-consumer and pre-dispatch facts once without inventing a claim receipt', async () => {
        httpFixture.state.recorderJsonl = [
            '{"name":"bypass","agentId":"agent-a","atEpochMs":110,"value":{"topic":"rallar.browser.alm.inbound_diagnostics","payload":{"atEpochMs":109,"data":{"kind":"dispatch-decision","workerId":"worker","effectId":"effect","msgId":"signal","typeId":"rtc-signaling","carrier":"ws","lane":"durable","attempts":1,"atEpochMs":10,"disposition":"local-disabled","reason":"private-consumer-sentinel"}}}}',
            '{"name":"consumer","agentId":"agent-b","atEpochMs":120,"value":{"topic":"rallar.browser.alm.inbound_diagnostics","payload":{"atEpochMs":119,"data":{"kind":"consumer-invocation","msgId":"signal","typeId":"rtc-signaling","carrier":"ws","selection":"exact-type","outcome":"returned","beganAtMs":0,"settledAtMs":5,"error":"private-consumer-sentinel","workerId":"not-an-owned-claim"}}}}',
            '{"name":"wildcard","agentId":"agent-c","atEpochMs":130,"value":{"topic":"rallar.browser.alm.inbound_diagnostics","payload":{"data":{"kind":"consumer-invocation","msgId":"signal","typeId":"rtc-signaling","carrier":"ws","selection":"absent","outcome":"not-invoked","beganAtMs":0,"settledAtMs":0}}}}',
            '{"name":"wrong-type","agentId":"agent-b","atEpochMs":121,"value":{"topic":"rallar.browser.alm.inbound_diagnostics","payload":{"data":{"kind":"consumer-invocation","msgId":"signal","typeId":null,"selection":"exact-type","outcome":"returned"}}}}'
        ].join('\n');
        const captured = await httpFixture.control.captureDiagnostics({
            testInfo: {
                attach: async () => {
                    httpFixture.state.captureEffects.push('output');
                }
            },
            runId: 'consumer-evidence',
            agents: [{ prefix: 'A', agentId: 'agent-a' }, { prefix: 'B', agentId: 'agent-b' }, { prefix: 'C', agentId: 'agent-c' }],
            label: 'attempt-failure',
            cycle: 8,
            failureInterval: { caseId: 'retention-100', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'current-cycle-before-close' }
        });
        expect(captured.checkpoint.agents[0].details).toMatchObject({
            lifecycleHistory: {
                events: [{ kind: 'dispatch-decision', disposition: 'local-disabled', workerId: 'worker', effectId: 'effect', producerAtEpochMs: 10 }]
            }
        });
        expect(captured.checkpoint.agents[1].details).toMatchObject({
            lifecycleHistory: {
                nativeApplication: 'unknown',
                consumerClaimAssociation: 'unknown-message-level-observation-only',
                events: [{
                    eventId: 'consumer',
                    controlAtEpochMs: 120,
                    runtimeAtEpochMs: 119,
                    kind: 'consumer-invocation',
                    msgId: 'signal',
                    typeId: 'rtc-signaling',
                    selection: 'exact-type',
                    outcome: 'returned',
                    beganAtMs: 0,
                    settledAtMs: 5,
                    workerId: null,
                    effectId: null,
                    lane: null,
                    attempts: null
                }]
            }
        });
        expect(captured.checkpoint.agents[2].details).toMatchObject({ lifecycleHistory: { events: [{ selection: 'absent', outcome: 'not-invoked' }] } });
        expect(JSON.stringify(captured)).not.toContain('private-consumer-sentinel');
        expect(JSON.stringify(captured)).not.toContain('not-an-owned-claim');
        expect(httpFixture.state.recorderReads).toBe(1);
        expect(httpFixture.state.captureEffects).toEqual(['health:agent-a', 'health:agent-b', 'health:agent-c', 'history', 'output']);
    });

    it('preserves existing RTC commit admission and owned dispatch facts at capture HTTP without implying native application', async () => {
        httpFixture.state.rtcDiagnosticPeers = [{ peerId: 'session-b', connection: { state: 'Closed', reconnecting: false }, lanes: [] }];
        httpFixture.state.recorderJsonl = [
            '{"name":"commit","agentId":"agent-a","atEpochMs":100,"value":{"topic":"rallar.browser.alm.outbound_diagnostics","payload":{"atEpochMs":99,"data":{"kind":"commit-phases","senderId":"session-a","msgId":"signal-1","typeId":"rtc-signaling","lane":"durable","origin":"send","readDurationMs":2,"readOperationCount":3,"commitDurationMs":4,"commitOutcome":"committed","payload":{"sdp":"secret-signal-sentinel"}}}}}',
            '{"name":"admission","agentId":"agent-b","atEpochMs":110,"value":{"topic":"rallar.browser.alm.inbound_diagnostics","payload":{"atEpochMs":109,"data":{"kind":"admission-outcome","workerId":"worker-b","msgId":"signal-1","typeId":"rtc-signaling","carrier":"ws","outcome":"committed","reason":"secret-signal-sentinel"}}}}',
            '{"name":"dispatch","agentId":"agent-b","atEpochMs":120,"value":{"topic":"rallar.browser.alm.inbound_diagnostics","payload":{"atEpochMs":119,"data":{"kind":"claim-settled","workerId":"worker-b","effectId":"dispatch-1","msgId":"signal-1","subjectMsgId":"signal-1","typeId":null,"payloadKind":"dispatch-local","lane":"durable","outcome":"completed","attempts":1,"queueWaitMs":7,"durationMs":5,"dueAtMs":1000,"batchStartedAtMs":1007,"startedAtMs":1010,"error":"secret-signal-sentinel"}}}}',
            '{"name":"app","agentId":"agent-b","atEpochMs":121,"value":{"topic":"rallar.browser.alm.inbound_diagnostics","payload":{"data":{"kind":"admission-outcome","workerId":"worker-b","msgId":"app-1","typeId":"app-message","carrier":"ws","outcome":"committed"}}}}',
            '{"name":"unqualified","agentId":"agent-b","atEpochMs":122,"value":{"topic":"rallar.browser.alm.inbound_diagnostics","payload":{"data":{"kind":"claim-settled","workerId":"worker-b","msgId":"missing","subjectMsgId":"missing","typeId":null,"payloadKind":"dispatch-local","lane":"durable"}}}}',
            '{"name":"wrong-worker","agentId":"agent-b","atEpochMs":123,"value":{"topic":"rallar.browser.alm.inbound_diagnostics","payload":{"data":{"kind":"claim-settled","workerId":"worker-other","msgId":"signal-1","subjectMsgId":"signal-1","typeId":null,"payloadKind":"dispatch-local","lane":"durable"}}}}',
            '{"name":"wrong-agent","agentId":"agent-c","atEpochMs":124,"value":{"topic":"rallar.browser.alm.inbound_diagnostics","payload":{"data":{"kind":"claim-settled","workerId":"worker-b","msgId":"signal-1","subjectMsgId":"signal-1","typeId":null,"payloadKind":"dispatch-local","lane":"durable"}}}}',
            '{"name":"native-kind","agentId":"agent-a","atEpochMs":125,"value":{"topic":"rallar.browser.alm.outbound_diagnostics","payload":{"data":{"kind":"commit-phases","msgId":"offer-1","typeId":"Offer"}}}}',
            '{"name":"without-dispatch","agentId":"agent-c","atEpochMs":130,"value":{"topic":"rallar.browser.alm.inbound_diagnostics","payload":{"data":{"kind":"admission-outcome","workerId":"worker-c","msgId":"signal-2","typeId":"rtc-signaling","carrier":"ws","outcome":"committed"}}}}',
            '{"name":"conflicting-rtc","agentId":"agent-c","atEpochMs":131,"value":{"topic":"rallar.browser.alm.inbound_diagnostics","payload":{"data":{"kind":"admission-outcome","workerId":"worker-c","msgId":"collision","typeId":"rtc-signaling","carrier":"ws","outcome":"committed"}}}}',
            '{"name":"conflicting-app","agentId":"agent-c","atEpochMs":132,"value":{"topic":"rallar.browser.alm.inbound_diagnostics","payload":{"data":{"kind":"admission-outcome","workerId":"worker-c","msgId":"collision","typeId":"app-message","carrier":"ws","outcome":"committed"}}}}',
            '{"name":"ambiguous-dispatch","agentId":"agent-c","atEpochMs":133,"value":{"topic":"rallar.browser.alm.inbound_diagnostics","payload":{"atEpochMs":132,"data":{"kind":"claim-settled","workerId":"worker-c","effectId":"dispatch-collision","msgId":"collision","subjectMsgId":"collision","typeId":null,"payloadKind":"dispatch-local","lane":"durable","outcome":"completed","attempts":1,"queueWaitMs":3,"durationMs":2,"dueAtMs":2000,"batchStartedAtMs":2003,"startedAtMs":2003}}}}',
            '{"name":"timeout","agentId":"agent-b","atEpochMs":150,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"atEpochMs":149,"data":{"kind":"peer-timeout","atEpochMs":148,"peerId":"session-a","peer":{"peerId":"session-a","connection":{"state":"Connecting","hasRemoteDescription":false},"lanes":[]}}}}}'
        ].join('\n');
        const captured = await httpFixture.control.captureDiagnostics({
            testInfo: { attach: async () => {} },
            runId: 'signal-evidence',
            agents: [{ prefix: 'A', agentId: 'agent-a' }, { prefix: 'B', agentId: 'agent-b' }, { prefix: 'C', agentId: 'agent-c' }],
            label: 'attempt-failure',
            cycle: 8,
            failureInterval: { caseId: 'retention-100', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'current-cycle-before-close' }
        });
        expect(captured.checkpoint.agents[0].details).toMatchObject({
            lifecycleHistory: {
                events: [{
                    eventId: 'commit',
                    kind: 'commit-phases',
                    controlAtEpochMs: 100,
                    runtimeAtEpochMs: 99,
                    senderId: 'session-a',
                    msgId: 'signal-1',
                    typeId: 'rtc-signaling',
                    lane: 'durable',
                    origin: 'send',
                    readDurationMs: 2,
                    readOperationCount: 3,
                    commitDurationMs: 4,
                    commitOutcome: 'committed',
                    observation: 'local-admission-store-commit-not-network-delivery'
                }]
            }
        });
        expect(captured.checkpoint.agents[1].details).toMatchObject({
            diagnostics: { peers: [{ connection: { state: 'Closed' } }] },
            lifecycleHistory: {
                nativeApplication: 'unknown',
                nativeGenerationAndDeletionIssuer: 'unknown',
                events: [
                    {
                        eventId: 'admission',
                        kind: 'admission-outcome',
                        workerId: 'worker-b',
                        carrier: 'ws',
                        outcome: 'committed',
                        dispatchLink: { sourceObserved: 'matched', retained: 'matched' }
                    },
                    {
                        eventId: 'dispatch',
                        kind: 'claim-settled',
                        typeId: null,
                        identifiedTypeId: 'rtc-signaling',
                        workerId: 'worker-b',
                        effectId: 'dispatch-1',
                        msgId: 'signal-1',
                        subjectMsgId: 'signal-1',
                        controlAtEpochMs: 120,
                        runtimeAtEpochMs: 119,
                        queueWaitMs: 7,
                        durationMs: 5,
                        dueAtMs: 1000,
                        batchStartedAtMs: 1007,
                        startedAtMs: 1010,
                        intraBatchWaitMs: 3,
                        observation: 'owned-work-settlement-not-selected-consumer-invocation',
                        admissionLink: { sourceObserved: 'matched', retained: 'matched' }
                    },
                    { eventId: 'timeout', peerObservation: { connection: { state: 'Connecting', hasRemoteDescription: false } } }
                ]
            }
        });
        expect(captured.checkpoint.agents[2].details).toMatchObject({
            lifecycleHistory: {
                events: [
                    { eventId: 'without-dispatch', dispatchLink: { sourceObserved: 'unknown', retained: 'unknown' } },
                    { eventId: 'conflicting-rtc', dispatchLink: { sourceObserved: 'ambiguous', retained: 'ambiguous' } },
                    {
                        eventId: 'ambiguous-dispatch',
                        typeId: null,
                        identifiedTypeId: null,
                        admissionLink: { sourceObserved: 'ambiguous', retained: 'ambiguous' }
                    }
                ]
            }
        });
        expect(JSON.stringify(captured)).not.toContain('secret-signal-sentinel');
        expect(httpFixture.state.recorderReads).toBe(1);
        expect(httpFixture.state.captureEffects).toEqual(['health:agent-a', 'health:agent-b', 'health:agent-c', 'history']);
    });

    it('preserves facade-current-at-notification peer and lane observations through real capture HTTP', async () => {
        httpFixture.state.rtcDiagnosticPeers = [{ peerId: 'session-b', connection: { state: 'Closed', reconnecting: false }, lanes: [] }];
        httpFixture.state.recorderJsonl = [
            '{"name":"established","agentId":"agent-b","atEpochMs":110,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"atEpochMs":109,"data":{"kind":"peer-established","atEpochMs":108,"peerId":"session-c","peer":{"peerId":"session-c","connection":{"state":"Open","connectionState":"connected","iceConnectionState":"completed","iceGatheringState":"complete","signalingState":"stable","hasLocalDescription":true,"hasRemoteDescription":true,"makingOffer":false,"iceCandidateQueueSize":0,"signaling":{"outboundOfferCount":1,"outboundAnswerCount":0,"outboundIceCandidateCount":3,"inboundOfferCount":0,"inboundAnswerCount":1,"inboundIceCandidateCount":2,"outboundSignalingErrorCount":0,"inboundSignalingErrorCount":0}},"lanes":[{"peerId":"session-c","laneId":"realtime","isOpen":true,"isReconnectable":false,"channel":{"readyState":"open","state":"Open","candidate":"secret-event-sentinel"}}]}}}}}',
            '{"name":"open","agentId":"agent-b","atEpochMs":115,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"atEpochMs":114,"data":{"kind":"lane-open","atEpochMs":113,"peerId":"session-c","laneId":"realtime","lane":{"peerId":"session-c","laneId":"realtime","isOpen":true,"isReconnectable":false,"channel":{"readyState":"open","state":"Open","streamId":"secret-event-sentinel"}}}}}}',
            '{"name":"timeout","agentId":"agent-c","atEpochMs":120,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"atEpochMs":119,"data":{"kind":"peer-timeout","atEpochMs":117,"peerId":"session-b","peer":{"peerId":"session-b","connection":{"state":"Connecting","connectionState":"connecting","iceConnectionState":"checking","iceGatheringState":"gathering","signalingState":"have-remote-offer","hasLocalDescription":false,"hasRemoteDescription":true,"makingOffer":true,"iceCandidateQueueSize":4,"signaling":{"outboundOfferCount":0,"outboundAnswerCount":1,"outboundIceCandidateCount":2,"inboundOfferCount":3,"inboundAnswerCount":0,"inboundIceCandidateCount":5,"outboundSignalingErrorCount":1,"inboundSignalingErrorCount":2},"localStreamId":"secret-event-sentinel","sdp":"secret-event-sentinel","connectCallCount":99},"lanes":[{"peerId":"session-b","laneId":"realtime","isOpen":false,"isReconnectable":false,"channel":{"readyState":"connecting","state":"Connecting","candidate":"secret-event-sentinel"}}],"credential":"secret-event-sentinel"},"status":{"peers":[{"peerId":"session-b","connection":{"state":"Open"}}],"credential":"secret-event-sentinel"},"reason":"secret-event-sentinel","signaling":{"reason":"secret-event-sentinel"}}}}}',
            '{"name":"deleted","agentId":"agent-c","atEpochMs":130,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"atEpochMs":129,"data":{"kind":"peer-deleted","atEpochMs":128,"peerId":"session-b","peer":{"peerId":"session-b","connection":{"state":"Idle","connectionState":"new","iceConnectionState":"new","iceGatheringState":"new","signalingState":"stable","hasLocalDescription":false,"hasRemoteDescription":false,"makingOffer":false,"iceCandidateQueueSize":0,"signaling":{"outboundOfferCount":0,"outboundAnswerCount":0,"outboundIceCandidateCount":0,"inboundOfferCount":0,"inboundAnswerCount":0,"inboundIceCandidateCount":0,"outboundSignalingErrorCount":0,"inboundSignalingErrorCount":0}},"lanes":[{"peerId":"session-b","laneId":"realtime","isOpen":false,"isReconnectable":true,"channel":{"state":"Idle"}}]}}}}}'
        ].join('\n');
        const captured = await httpFixture.control.captureDiagnostics({
            testInfo: { attach: async () => {} },
            runId: 'notification-state',
            agents: [{ prefix: 'A', agentId: 'agent-a' }, { prefix: 'B', agentId: 'agent-b' }, { prefix: 'C', agentId: 'agent-c' }],
            label: 'attempt-failure-later-health',
            cycle: 8,
            failureInterval: { caseId: 'retention-100', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'current-cycle-before-close' }
        });
        expect(captured.checkpoint.agents[1].details).toMatchObject({
            lifecycleHistory: {
                events: [
                    {
                        eventId: 'established',
                        streamRow: 1,
                        peerObservation: {
                            connection: {
                                state: 'Open',
                                connectionState: 'connected',
                                iceConnectionState: 'completed',
                                iceGatheringState: 'complete',
                                signalingState: 'stable',
                                hasLocalDescription: true,
                                hasRemoteDescription: true,
                                makingOffer: false,
                                iceCandidateQueueSize: 0,
                                signaling: {
                                    outboundOfferCount: 1,
                                    outboundAnswerCount: 0,
                                    outboundIceCandidateCount: 3,
                                    inboundOfferCount: 0,
                                    inboundAnswerCount: 1,
                                    inboundIceCandidateCount: 2,
                                    outboundSignalingErrorCount: 0,
                                    inboundSignalingErrorCount: 0
                                }
                            },
                            lanes: [{ peerId: 'session-c', laneId: 'realtime', isOpen: true, isReconnectable: false, readyState: 'open' }]
                        }
                    },
                    {
                        eventId: 'open',
                        streamRow: 2,
                        peerObservation: null,
                        laneObservation: { peerId: 'session-c', laneId: 'realtime', isOpen: true, isReconnectable: false, readyState: 'open' }
                    }
                ]
            }
        });
        expect(captured.checkpoint.agents[2].details).toMatchObject({
            diagnostics: { peers: [{ connection: { state: 'Closed' } }] },
            lifecycleHistory: {
                nativeGenerationAndDeletionIssuer: 'unknown',
                events: [
                    {
                        eventId: 'timeout',
                        streamRow: 3,
                        observation: 'facade-current-at-notification',
                        controlAtEpochMs: 120,
                        runtimeAtEpochMs: 119,
                        browserAtEpochMs: 117,
                        peerObservation: {
                            peerId: 'session-b',
                            connection: {
                                state: 'Connecting',
                                connectionState: 'connecting',
                                iceConnectionState: 'checking',
                                iceGatheringState: 'gathering',
                                signalingState: 'have-remote-offer',
                                hasLocalDescription: false,
                                hasRemoteDescription: true,
                                makingOffer: true,
                                iceCandidateQueueSize: 4,
                                signaling: {
                                    outboundOfferCount: 0,
                                    outboundAnswerCount: 1,
                                    outboundIceCandidateCount: 2,
                                    inboundOfferCount: 3,
                                    inboundAnswerCount: 0,
                                    inboundIceCandidateCount: 5,
                                    outboundSignalingErrorCount: 1,
                                    inboundSignalingErrorCount: 2
                                }
                            },
                            lanes: [{ peerId: 'session-b', laneId: 'realtime', isOpen: false, isReconnectable: false, readyState: 'connecting' }]
                        },
                        laneObservation: null
                    },
                    {
                        eventId: 'deleted',
                        streamRow: 4,
                        observation: 'facade-current-at-notification',
                        peerObservation: {
                            peerId: 'session-b',
                            connection: {
                                state: 'Idle',
                                connectionState: 'new',
                                iceConnectionState: 'new',
                                iceGatheringState: 'new',
                                signalingState: 'stable',
                                hasLocalDescription: false,
                                hasRemoteDescription: false,
                                makingOffer: false,
                                iceCandidateQueueSize: 0,
                                signaling: {
                                    outboundOfferCount: 0,
                                    outboundAnswerCount: 0,
                                    outboundIceCandidateCount: 0,
                                    inboundOfferCount: 0,
                                    inboundAnswerCount: 0,
                                    inboundIceCandidateCount: 0,
                                    outboundSignalingErrorCount: 0,
                                    inboundSignalingErrorCount: 0
                                }
                            },
                            lanes: [{ peerId: 'session-b', laneId: 'realtime', isOpen: false, isReconnectable: true, readyState: null }]
                        }
                    }
                ]
            }
        });
        expect(JSON.stringify(captured)).not.toContain('secret-event-sentinel');
        expect(JSON.stringify(captured)).not.toContain('connectCallCount');
    });

    it.each([401, 403, 500])('retains completed health with sanitized unavailable history after recorder HTTP %s', async (status) => {
        httpFixture.state.recorderStatus = status;
        httpFixture.state.recorderJsonl = 'secret-recorder-error-sentinel';
        const captured = await httpFixture.control.captureDiagnostics({
            testInfo: { attach: async () => {} },
            runId: 'unavailable-recorder',
            agents: [{ prefix: 'A', agentId: 'agent-a' }, { prefix: 'B', agentId: 'agent-b' }, { prefix: 'C', agentId: 'agent-c' }],
            label: 'attempt-failure-later-health',
            cycle: 2,
            failureInterval: { caseId: 'retention-100', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'current-cycle-before-close' }
        });
        expect(captured.checkpoint.agents).toHaveLength(3);
        for (const diagnostic of captured.checkpoint.agents) {
            expect(diagnostic.readyPeerIds).toEqual(['session-b', 'session-c']);
            expect(diagnostic.details).toMatchObject({
                lifecycleHistory: { coverage: 'unavailable', events: [], failure: 'RTC lifecycle recorder history unavailable.' }
            });
        }
        expect(JSON.stringify(captured)).not.toContain('secret-recorder-error-sentinel');
        expect(httpFixture.state.recorderReads).toBe(1);
    });

    it('performs no supplemental recorder read for ordinary checkpoints', async () => {
        httpFixture.state.recorderJsonl =
            '{"name":"ordinary-commit","agentId":"agent-a","atEpochMs":100,"value":{"topic":"rallar.browser.alm.outbound_diagnostics","payload":{"data":{"kind":"commit-phases","msgId":"ordinary-signal","typeId":"rtc-signaling"}}}}';
        const captured = await httpFixture.control.captureDiagnostics({
            testInfo: { attach: async () => {} },
            runId: 'ordinary-capture',
            agents: [{ prefix: 'A', agentId: 'agent-a' }, { prefix: 'B', agentId: 'agent-b' }, { prefix: 'C', agentId: 'agent-c' }],
            label: 'retention-10',
            cycle: 10
        });
        expect(httpFixture.state.recorderReads).toBe(0);
        expect(JSON.stringify(captured)).not.toContain('lifecycleHistory');
    });

    it('observes a canonical control message receipt and its runtime topic through HTTP', async () => {
        httpFixture.state.events.push({
            kind: 'event',
            agentId: 'agent-b',
            payload: {
                kind: 'message',
                topic: 'rallar.browser.messages.rtc.message',
                transport: 'messages.rtc',
                payload: { data: { matrixId: 'canonical-receipt', deliveryMode: 'direct' } }
            }
        });
        await expect(httpFixture.control.waitForMessage({
            runId: 'canonical-receipt',
            senderAgentId: 'agent-a',
            agentId: 'agent-b',
            transport: 'messages.rtc',
            matrixId: 'canonical-receipt',
            deliveryMode: 'direct',
            startedAtMs: 100
        })).resolves.toBe(0);
        expect(httpFixture.control.runtimeTopics(await httpFixture.control.fetchRun('canonical-receipt'))).toEqual(['rallar.browser.messages.rtc.message']);
        expect(httpFixture.state.recorderReads).toBe(0);
    });

    it('keeps useful rows after malformed and oversized rows with finite bounded identities', async () => {
        httpFixture.state.recorderJsonl = [
            'invalid-json secret-history-sentinel',
            JSON.stringify({ name: 'oversized', contamination: 'x'.repeat(16_384) }),
            JSON.stringify({
                name: 'z'.repeat(257),
                agentId: 'agent-a',
                atEpochMs: 110,
                value: {
                    topic: 'rallar.browser.rtc.lifecycle',
                    payload: { data: { kind: 'lane-error', atEpochMs: 'secret-history-sentinel', peerId: 'p'.repeat(257), laneId: 'l'.repeat(256) } }
                }
            }),
            '{"name":"valid","agentId":"agent-c","atEpochMs":120,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-created","atEpochMs":119,"peerId":"session-b"}},"atEpochMs":120}}'
        ].join('\n');
        const captured = await httpFixture.control.captureDiagnostics({
            testInfo: { attach: async () => {} },
            runId: 'malformed-recorder',
            agents: [{ prefix: 'A', agentId: 'agent-a' }, { prefix: 'B', agentId: 'agent-b' }, { prefix: 'C', agentId: 'agent-c' }],
            label: 'attempt-failure-later-health',
            cycle: 1,
            failureInterval: { caseId: 'retention-100', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'current-cycle-before-close' }
        });
        expect(captured.checkpoint.agents[0].details).toMatchObject({
            lifecycleHistory: {
                coverage: 'incomplete',
                observed: { scannedRows: 4, malformedRows: 1, oversizedRows: 1, retainedRows: 2 },
                events: [{ streamRow: 3, eventId: null, peerId: null, laneId: 'l'.repeat(256), browserAtEpochMs: null }]
            }
        });
        expect(captured.checkpoint.agents[2].details).toMatchObject({ lifecycleHistory: { events: [{ eventId: 'valid', peerId: 'session-b' }] } });
        expect(JSON.stringify(captured)).not.toContain('secret-history-sentinel');
    });

    it('reports observed preview-tail span without claiming recorder completeness', async () => {
        httpFixture.state.recorderJsonl =
            '{"name":"tail","agentId":"agent-a","atEpochMs":140,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-deleted","atEpochMs":139}},"atEpochMs":140}}\n';
        const captured = await httpFixture.control.captureDiagnostics({
            testInfo: { attach: async () => {} },
            runId: 'preview-recorder',
            agents: [{ prefix: 'A', agentId: 'agent-a' }, { prefix: 'B', agentId: 'agent-b' }, { prefix: 'C', agentId: 'agent-c' }],
            label: 'attempt-failure-later-health',
            cycle: null,
            failureInterval: { caseId: 'all-scenarios', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'attempt-phase-unspecified' }
        });
        expect(captured.checkpoint.agents[0].details).toMatchObject({
            lifecycleHistory: {
                coverage: 'unknown',
                recorderOrigin: 'unknown',
                observed: { firstControlAtEpochMs: 140, lastControlAtEpochMs: 140 }
            }
        });
        expect(JSON.stringify(captured)).not.toContain('"complete":true');
    });

    it('marks an unobserved requested failure window incomplete despite a successful recorder read', async () => {
        httpFixture.state.recorderJsonl =
            '{"name":"earlier","agentId":"agent-a","atEpochMs":50,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-created","atEpochMs":49}}}}\n';
        const captured = await httpFixture.control.captureDiagnostics({
            testInfo: { attach: async () => {} },
            runId: 'unobserved-window',
            agents: [{ prefix: 'A', agentId: 'agent-a' }, { prefix: 'B', agentId: 'agent-b' }, { prefix: 'C', agentId: 'agent-c' }],
            label: 'attempt-failure-later-health',
            cycle: null,
            failureInterval: { caseId: 'all-scenarios', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'attempt-phase-unspecified' }
        });
        expect(captured.checkpoint.agents).toHaveLength(3);
        expect(captured.checkpoint.agents[0].details).toMatchObject({
            lifecycleHistory: {
                coverage: 'incomplete',
                recorderOrigin: 'unknown',
                failure: null,
                observed: { filteredRows: 1, retainedRows: 0, transportTruncated: false },
                events: []
            }
        });
    });

    it('retains the late failure window after a long earlier all-scenarios phase', async () => {
        const earlier =
            '{"name":"earlier","agentId":"retired-agent","atEpochMs":50,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-created","atEpochMs":49}}},"unused":"' +
            'x'.repeat(3000) + '"}\n';
        httpFixture.state.recorderJsonl = earlier.repeat(4000) +
            '{"name":"late","agentId":"agent-c","atEpochMs":140,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-timeout","atEpochMs":139,"peerId":"session-a"}},"atEpochMs":140}}\n';
        const captured = await httpFixture.control.captureDiagnostics({
            testInfo: { attach: async () => {} },
            runId: 'oversized-recorder',
            agents: [{ prefix: 'A', agentId: 'agent-a' }, { prefix: 'B', agentId: 'agent-b' }, { prefix: 'C', agentId: 'agent-c' }],
            label: 'attempt-failure-later-health',
            cycle: 12,
            failureInterval: { caseId: 'all-scenarios', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'attempt-phase-unspecified' }
        });
        expect(captured.checkpoint.agents[2].details).toMatchObject({
            lifecycleHistory: {
                coverage: 'incomplete',
                observed: {
                    bytesRead: Buffer.byteLength(httpFixture.state.recorderJsonl),
                    retainedBytes: 8_388_608,
                    retainedPrefixDropped: true,
                    transportTruncated: false,
                    retainedRows: 1
                },
                events: [{ eventId: 'late', kind: 'peer-timeout', controlAtEpochMs: 140, browserAtEpochMs: 139, peerId: 'session-a' }]
            }
        });
        expect(httpFixture.state.recorderReads).toBe(1);
    });

    it('selects late rows in stream order when earlier phases exceed the row scan limit', async () => {
        const earlier =
            '{"name":"earlier","agentId":"retired-agent","atEpochMs":50,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-created","atEpochMs":49}}}}\n';
        httpFixture.state.recorderJsonl = earlier.repeat(20_001) +
            '{"name":"late","agentId":"agent-c","atEpochMs":140,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-timeout","atEpochMs":139}}}}\n';
        const captured = await httpFixture.control.captureDiagnostics({
            testInfo: { attach: async () => {} },
            runId: 'late-row-window',
            agents: [{ prefix: 'A', agentId: 'agent-a' }, { prefix: 'B', agentId: 'agent-b' }, { prefix: 'C', agentId: 'agent-c' }],
            label: 'attempt-failure-later-health',
            cycle: null,
            failureInterval: { caseId: 'all-scenarios', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'attempt-phase-unspecified' }
        });
        expect(captured.checkpoint.agents[2].details).toMatchObject({
            lifecycleHistory: {
                coverage: 'incomplete',
                observed: { scannedRows: 20_000, filteredRows: 19_999, retainedRows: 1, rowLimitReached: true },
                events: [{ streamRow: 20_002, eventId: 'late', controlAtEpochMs: 140 }]
            }
        });
    });

    it('keeps the latest failure event when permitted current-window events exceed output limits', async () => {
        httpFixture.state.recorderJsonl =
            '{"name":"earlier","agentId":"agent-a","atEpochMs":110,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-created","atEpochMs":109}}}}\n'
                .repeat(601) +
            '{"name":"late","agentId":"agent-c","atEpochMs":140,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-timeout","atEpochMs":139}}}}\n';
        const captured = await httpFixture.control.captureDiagnostics({
            testInfo: { attach: async () => {} },
            runId: 'late-output-window',
            agents: [{ prefix: 'A', agentId: 'agent-a' }, { prefix: 'B', agentId: 'agent-b' }, { prefix: 'C', agentId: 'agent-c' }],
            label: 'attempt-failure-later-health',
            cycle: null,
            failureInterval: { caseId: 'all-scenarios', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'attempt-phase-unspecified' }
        });
        expect(captured.checkpoint.agents[2].details).toMatchObject({
            lifecycleHistory: {
                coverage: 'incomplete',
                observed: { retainedRows: 600, outputDroppedRows: 2 },
                events: [{ streamRow: 602, eventId: 'late', controlAtEpochMs: 140 }]
            }
        });
    });

    it('reports transport truncation without inventing a failure window beyond the byte ceiling', async () => {
        const earlier =
            '{"name":"earlier","agentId":"retired-agent","atEpochMs":50,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-created","atEpochMs":49}}},"unused":"' +
            'x'.repeat(3000) + '"}\n';
        httpFixture.state.recorderJsonl = earlier.repeat(22_000) +
            '{"name":"unread-late","agentId":"agent-c","atEpochMs":140,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-timeout","atEpochMs":139}}}}\n';
        const captured = await httpFixture.control.captureDiagnostics({
            testInfo: { attach: async () => {} },
            runId: 'beyond-transport-window',
            agents: [{ prefix: 'A', agentId: 'agent-a' }, { prefix: 'B', agentId: 'agent-b' }, { prefix: 'C', agentId: 'agent-c' }],
            label: 'attempt-failure-later-health',
            cycle: null,
            failureInterval: { caseId: 'all-scenarios', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'attempt-phase-unspecified' }
        });
        expect(captured.checkpoint.agents[2].details).toMatchObject({
            lifecycleHistory: {
                coverage: 'incomplete',
                limits: { inputBytes: 8_388_608, transportBytes: 67_108_864, transportTimeoutMs: 30_000 },
                observed: { bytesRead: 67_108_864, retainedBytes: 8_388_608, retainedPrefixDropped: true, transportTruncated: true, retainedRows: 0 },
                events: []
            }
        });
        expect(JSON.stringify(captured)).not.toContain('unread-late');
        expect(httpFixture.state.recorderReads).toBe(1);
    });

    it.each(['retained-rows', 'event-output-bytes', 'scan-rows'])('caps %s and reports omitted recorder rows', async (limit) => {
        const longIdentities = limit === 'event-output-bytes';
        const eventCount = limit === 'scan-rows' ? 20_001 : 601;
        const row = JSON.stringify({
            name: longIdentities ? 'e'.repeat(256) : 'event',
            agentId: 'agent-a',
            atEpochMs: 110,
            value: {
                topic: limit === 'scan-rows' ? 'unrelated-topic' : 'rallar.browser.rtc.lifecycle',
                payload: {
                    data: {
                        kind: 'lane-open',
                        atEpochMs: 109,
                        peerId: longIdentities ? 'p'.repeat(256) : 'peer',
                        laneId: longIdentities ? 'l'.repeat(256) : 'lane',
                        ...(longIdentities
                            ? {
                                peer: {
                                    peerId: 'p'.repeat(256),
                                    connection: {
                                        state: 'Connecting',
                                        connectionState: 'connecting',
                                        iceConnectionState: 'checking',
                                        iceGatheringState: 'gathering',
                                        signalingState: 'have-local-offer',
                                        hasLocalDescription: true,
                                        hasRemoteDescription: false,
                                        makingOffer: true,
                                        iceCandidateQueueSize: 4,
                                        signaling: {
                                            outboundOfferCount: 1,
                                            outboundAnswerCount: 0,
                                            outboundIceCandidateCount: 2,
                                            inboundOfferCount: 0,
                                            inboundAnswerCount: 0,
                                            inboundIceCandidateCount: 0,
                                            outboundSignalingErrorCount: 0,
                                            inboundSignalingErrorCount: 0
                                        }
                                    },
                                    lanes: [{
                                        peerId: 'p'.repeat(256),
                                        laneId: 'l'.repeat(256),
                                        isOpen: false,
                                        isReconnectable: false,
                                        channel: { readyState: 'connecting' }
                                    }]
                                }
                            }
                            : {})
                    }
                }
            }
        });
        httpFixture.state.recorderJsonl = (row + '\n').repeat(eventCount);
        const captured = await httpFixture.control.captureDiagnostics({
            testInfo: { attach: async () => {} },
            runId: 'bounded-recorder',
            agents: [{ prefix: 'A', agentId: 'agent-a' }, { prefix: 'B', agentId: 'agent-b' }, { prefix: 'C', agentId: 'agent-c' }],
            label: 'attempt-failure-later-health',
            cycle: 12,
            failureInterval: { caseId: 'retention-100', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'current-cycle-before-close' }
        });
        const history = JSON.parse(JSON.stringify(captured.checkpoint.agents[0].details)).lifecycleHistory;
        expect(history.coverage).toBe('incomplete');
        if (limit === 'retained-rows') {
            expect(history.events).toHaveLength(600);
            expect(history.observed.outputDroppedRows).toBe(1);
        }
        else if (limit === 'event-output-bytes') {
            expect(history.observed.outputBytes).toBeLessThanOrEqual(262_144);
            expect(history.events.length).toBeGreaterThan(0);
            expect(history.events.length).toBeLessThan(600);
            expect(history.observed.outputDroppedRows).toBeGreaterThan(0);
            expect(history.events[0].streamRow).toBeGreaterThan(1);
            expect(history.events.at(-1).streamRow).toBe(601);
            expect(history.events.at(-1).peerObservation.connection).toMatchObject({ state: 'Connecting', iceCandidateQueueSize: 4 });
            expect(history.observed.outputBytes).toBe(
                history.events.reduce((bytes: number, event: object) => bytes + Buffer.byteLength(JSON.stringify(event)), 0)
            );
            expect(history.observed.outputDroppedRows + history.events.length).toBe(601);
        }
        else {
            expect(history.observed).toMatchObject({ scannedRows: 20_000, filteredRows: 20_000, rowLimitReached: true });
        }
    });

    it('preserves collected connecting room and open lane facts when live state closes during output', async () => {
        httpFixture.state.formation = {
            roomRef: { applicationId: 'app', workspaceId: 'space', groupId: 'room' },
            stage: 'connecting',
            room: {
                state: 'connecting',
                desiredPeerIds: ['session-b', 'session-c'],
                readyPeerIds: ['session-b'],
                activePeerIds: ['session-b'],
                failedPeerIds: []
            }
        };
        httpFixture.state.rtcDiagnosticPeers = [{
            peerId: 'session-b',
            connection: { reconnecting: false },
            lanes: [{ laneId: 'messages.rtc', isOpen: true, isReconnectable: true }]
        }];
        const captured = await httpFixture.control.captureDiagnostics({
            testInfo: {
                attach: async () => {
                    httpFixture.state.readyPeerIds = [];
                    httpFixture.state.formation = { stage: 'dormant', room: { state: 'closed' } };
                    httpFixture.state.rtcDiagnosticPeers = [];
                    throw new Error('sensitive-output-sentinel');
                }
            },
            runId: 'run-state-change',
            agents: [{ prefix: 'A', agentId: 'agent-a' }, { prefix: 'B', agentId: 'agent-b' }, { prefix: 'C', agentId: 'agent-c' }],
            label: 'attempt-failure-later-health',
            cycle: 8
        });
        const serialized = JSON.stringify(captured.checkpoint);
        for (const diagnostic of captured.checkpoint.agents) {
            expect(diagnostic.laneStates).toEqual([{ peerId: 'session-b', laneId: 'messages.rtc', isOpen: true, isReconnectable: true }]);
            expect(diagnostic.details).toMatchObject({ healthCapturedAtEpochMs: 0, formation: { stage: 'connecting', roomTransportState: 'connecting' } });
        }
        expect(serialized).not.toContain('closed');
        expect(serialized).not.toContain('sensitive-output-sentinel');
        const laterHealth = await httpFixture.control.executeOk({
            runId: 'run-state-change',
            agentId: 'agent-a',
            commandId: 'later-health',
            command: { kind: 'health' }
        });
        expect(httpFixture.control.readyPeerIds(laterHealth)).toEqual([]);
    });

    it.each(['attachment', 'sidecar', 'both'])('returns complete health despite optional %s output failure', async (failedOutput) => {
        if (failedOutput !== 'attachment') {
            rmSync(httpFixture.diagnosticsRoot, { recursive: true });
            writeFileSync(httpFixture.diagnosticsRoot, 'blocked-output');
        }
        const outputFailure = new Error('sensitive-output-sentinel');
        const captured = await httpFixture.control.captureDiagnostics({
            testInfo: {
                attach: async () => {
                    if (failedOutput !== 'sidecar') {
                        throw outputFailure;
                    }
                }
            },
            runId: 'run-output-failure',
            failureInterval: { caseId: 'retention-100', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'current-cycle-before-close' },
            agents: [{ prefix: 'A', agentId: 'agent-a' }, { prefix: 'B', agentId: 'agent-b' }, { prefix: 'C', agentId: 'agent-c' }],
            label: 'attempt-failure-later-health',
            cycle: 8
        });
        expect(captured.checkpoint).toMatchObject({
            label: 'attempt-failure-later-health',
            cycle: 8,
            agents: [{ agentId: 'agent-a' }, { agentId: 'agent-b' }, { agentId: 'agent-c' }]
        });
        if (failedOutput === 'attachment') {
            expect(readFileSync(path.join(httpFixture.diagnosticsRoot, 'live-rtc-diagnostics-attempt-failure-later-health.json'), 'utf8')).not.toContain(
                'sensitive-output-sentinel'
            );
        }
    });

    it('rejects an incomplete participant set instead of publishing a valid-looking checkpoint', async () => {
        const attachments: string[] = [];
        await expect(httpFixture.control.captureDiagnostics({
            testInfo: {
                attach: async (_name, options) => {
                    attachments.push(String(options?.body));
                }
            },
            runId: 'run-incomplete-health',
            agents: [{ prefix: 'A', agentId: 'agent-a' }],
            label: 'attempt-failure-later-health',
            cycle: 8
        })).rejects.toThrow('three distinct');
        expect(attachments).toEqual([]);
    });

    it('publishes no partial health when one participating agent cannot be read', async () => {
        httpFixture.state.healthCommandFailure = { agentId: 'agent-b', body: 'secret-health-failure-sentinel' };
        const attachments: string[] = [];
        await expect(httpFixture.control.captureDiagnostics({
            testInfo: {
                attach: async (_name, options) => {
                    attachments.push(String(options?.body));
                }
            },
            runId: 'run-partial-health',
            agents: [{ prefix: 'A', agentId: 'agent-a' }, { prefix: 'B', agentId: 'agent-b' }, { prefix: 'C', agentId: 'agent-c' }],
            label: 'attempt-failure-later-health',
            cycle: 8
        })).rejects.toThrow();
        expect(attachments).toEqual([]);
    });
});
