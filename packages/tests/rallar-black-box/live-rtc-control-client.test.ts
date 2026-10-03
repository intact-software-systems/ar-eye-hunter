import { request, type APIRequestContext } from '@playwright/test';
import type { BlackBoxRallarDeliveryObservation } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import type { LiveRtcJsonRecord } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';
import { normalizeJson } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';

/**
 * Spreads a real delivery observation, then explicitly named contamination the producer never emits.
 * An undefined field is dropped, as the JSON from the page drops it (a send with no receipt has no receiptMode).
 */
function toDeliveryObservationFixture(
    observation: BlackBoxRallarDeliveryObservation,
    contamination: Readonly<LiveRtcJsonRecord> = {}
) {
    const fields = Object.entries({ ...observation, ...contamination }).filter(([, value]) => value !== undefined);
    return normalizeJson(Object.fromEntries(fields));
}

describe('live RTC control client', () => {
    let server: Server;
    let api: APIRequestContext;
    let control: LiveRtcControlClient;
    let controlBaseUrl: string;
    let nowMs: number;
    let readyPeerIds: string[];
    let rtcDiagnosticPeers: LiveRtcJsonRecord[];
    let formation: LiveRtcJsonRecord | undefined;
    let diagnosticsRoot: string;
    let results: LiveRtcControlClient.Result[];
    let events: LiveRtcControlClient.Event[];
    let recorderJsonl: string;
    let recorderStatus: number;
    let recorderReads: number;
    const captureEffects: string[] = [];
    let healthCommandFailure: { agentId: string; body: string; } | undefined;
    let holdHealthCommand: ((agentId: string) => Promise<void>) | undefined;
    const refreshRoom = vi.fn<LiveRtcControlClient.FormationAgent['refreshRoom']>();
    const agent = { agentId: 'agent-a', prefix: 'A' as const, refreshRoom };

    it('retains one sanitized recorder sequence partitioned by actual failure agents before output', async () => {
        recorderJsonl = [
            '{"name":"outside","agentId":"agent-a","atEpochMs":90,"value":{"topic":"rallar.browser.rtc.lifecycle","atEpochMs":90,"payload":{"data":{"kind":"peer-created","atEpochMs":90,"peerId":"old"},"atEpochMs":90}}}',
            '{"name":"created","agentId":"agent-a","atEpochMs":110,"value":{"topic":"rallar.browser.rtc.lifecycle","atEpochMs":110,"payload":{"data":{"kind":"peer-created","atEpochMs":108,"peerId":"session-c","status":{"credential":"secret-history-sentinel"},"sdp":"secret-history-sentinel"},"atEpochMs":109}}}',
            '{"name":"timeout","agentId":"agent-a","atEpochMs":120,"value":{"topic":"rallar.browser.rtc.lifecycle","atEpochMs":120,"payload":{"data":{"kind":"peer-timeout","atEpochMs":107,"peerId":"session-c","reason":"secret-history-sentinel"},"atEpochMs":119}}}',
            '{"name":"deleted","agentId":"agent-c","atEpochMs":130,"value":{"topic":"rallar.browser.rtc.lifecycle","atEpochMs":130,"payload":{"data":{"kind":"peer-deleted","atEpochMs":128,"peerId":"session-a"},"atEpochMs":129}}}',
            '{"name":"lane","agentId":"agent-b","atEpochMs":140,"value":{"topic":"rallar.browser.rtc.lifecycle","atEpochMs":140,"payload":{"data":{"kind":"lane-open","atEpochMs":138,"peerId":"session-a","laneId":"realtime","candidate":"secret-history-sentinel"},"atEpochMs":139}}}',
            '{"name":"unrelated","agentId":"agent-a","atEpochMs":145,"value":{"topic":"console","payload":{"data":{"kind":"peer-created","atEpochMs":145}},"atEpochMs":145}}',
            '{"name":"other-agent","agentId":"agent-z","atEpochMs":146,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-created","atEpochMs":146}},"atEpochMs":146}}',
            '{"name":"after","agentId":"agent-a","atEpochMs":160,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-deleted","atEpochMs":160}},"atEpochMs":160}}'
        ].join('\n') + '\n';
        const captured = await control.captureDiagnostics({
            testInfo: {
                attach: async () => {
                    captureEffects.push('output');
                    recorderJsonl = '';
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
        expect(recorderReads).toBe(1);
        expect(captureEffects).toEqual(['health:agent-a', 'health:agent-b', 'health:agent-c', 'history', 'output']);
    });

    it('preserves facade-current-at-notification peer and lane observations through real capture HTTP', async () => {
        rtcDiagnosticPeers = [{ peerId: 'session-b', connection: { state: 'Closed', reconnecting: false }, lanes: [] }];
        recorderJsonl = [
            '{"name":"established","agentId":"agent-b","atEpochMs":110,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"atEpochMs":109,"data":{"kind":"peer-established","atEpochMs":108,"peerId":"session-c","peer":{"peerId":"session-c","connection":{"state":"Open","connectionState":"connected","iceConnectionState":"completed","iceGatheringState":"complete","signalingState":"stable","hasLocalDescription":true,"hasRemoteDescription":true,"makingOffer":false,"iceCandidateQueueSize":0,"signaling":{"outboundOfferCount":1,"outboundAnswerCount":0,"outboundIceCandidateCount":3,"inboundOfferCount":0,"inboundAnswerCount":1,"inboundIceCandidateCount":2,"outboundSignalingErrorCount":0,"inboundSignalingErrorCount":0}},"lanes":[{"peerId":"session-c","laneId":"realtime","isOpen":true,"isReconnectable":false,"channel":{"readyState":"open","state":"Open","candidate":"secret-event-sentinel"}}]}}}}}',
            '{"name":"open","agentId":"agent-b","atEpochMs":115,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"atEpochMs":114,"data":{"kind":"lane-open","atEpochMs":113,"peerId":"session-c","laneId":"realtime","lane":{"peerId":"session-c","laneId":"realtime","isOpen":true,"isReconnectable":false,"channel":{"readyState":"open","state":"Open","streamId":"secret-event-sentinel"}}}}}}',
            '{"name":"timeout","agentId":"agent-c","atEpochMs":120,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"atEpochMs":119,"data":{"kind":"peer-timeout","atEpochMs":117,"peerId":"session-b","peer":{"peerId":"session-b","connection":{"state":"Connecting","connectionState":"connecting","iceConnectionState":"checking","iceGatheringState":"gathering","signalingState":"have-remote-offer","hasLocalDescription":false,"hasRemoteDescription":true,"makingOffer":true,"iceCandidateQueueSize":4,"signaling":{"outboundOfferCount":0,"outboundAnswerCount":1,"outboundIceCandidateCount":2,"inboundOfferCount":3,"inboundAnswerCount":0,"inboundIceCandidateCount":5,"outboundSignalingErrorCount":1,"inboundSignalingErrorCount":2},"localStreamId":"secret-event-sentinel","sdp":"secret-event-sentinel","connectCallCount":99},"lanes":[{"peerId":"session-b","laneId":"realtime","isOpen":false,"isReconnectable":false,"channel":{"readyState":"connecting","state":"Connecting","candidate":"secret-event-sentinel"}}],"credential":"secret-event-sentinel"},"status":{"peers":[{"peerId":"session-b","connection":{"state":"Open"}}],"credential":"secret-event-sentinel"},"reason":"secret-event-sentinel","signaling":{"reason":"secret-event-sentinel"}}}}}',
            '{"name":"deleted","agentId":"agent-c","atEpochMs":130,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"atEpochMs":129,"data":{"kind":"peer-deleted","atEpochMs":128,"peerId":"session-b","peer":{"peerId":"session-b","connection":{"state":"Idle","connectionState":"new","iceConnectionState":"new","iceGatheringState":"new","signalingState":"stable","hasLocalDescription":false,"hasRemoteDescription":false,"makingOffer":false,"iceCandidateQueueSize":0,"signaling":{"outboundOfferCount":0,"outboundAnswerCount":0,"outboundIceCandidateCount":0,"inboundOfferCount":0,"inboundAnswerCount":0,"inboundIceCandidateCount":0,"outboundSignalingErrorCount":0,"inboundSignalingErrorCount":0}},"lanes":[{"peerId":"session-b","laneId":"realtime","isOpen":false,"isReconnectable":true,"channel":{"state":"Idle"}}]}}}}}'
        ].join('\n');
        const captured = await control.captureDiagnostics({
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
        recorderStatus = status;
        recorderJsonl = 'secret-recorder-error-sentinel';
        const captured = await control.captureDiagnostics({
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
        expect(recorderReads).toBe(1);
    });

    it('performs no supplemental recorder read for ordinary checkpoints', async () => {
        const captured = await control.captureDiagnostics({
            testInfo: { attach: async () => {} },
            runId: 'ordinary-capture',
            agents: [{ prefix: 'A', agentId: 'agent-a' }, { prefix: 'B', agentId: 'agent-b' }, { prefix: 'C', agentId: 'agent-c' }],
            label: 'retention-10',
            cycle: 10
        });
        expect(recorderReads).toBe(0);
        expect(JSON.stringify(captured)).not.toContain('lifecycleHistory');
    });

    it('observes a canonical control message receipt and its runtime topic through HTTP', async () => {
        events.push({
            kind: 'event',
            agentId: 'agent-b',
            payload: {
                kind: 'message',
                topic: 'rallar.browser.messages.rtc.message',
                transport: 'messages.rtc',
                payload: { data: { matrixId: 'canonical-receipt', deliveryMode: 'direct' } }
            }
        });
        await expect(control.waitForMessage({
            runId: 'canonical-receipt',
            senderAgentId: 'agent-a',
            agentId: 'agent-b',
            transport: 'messages.rtc',
            matrixId: 'canonical-receipt',
            deliveryMode: 'direct',
            startedAtMs: 100
        })).resolves.toBe(0);
        expect(control.runtimeTopics(await control.fetchRun('canonical-receipt'))).toEqual(['rallar.browser.messages.rtc.message']);
        expect(recorderReads).toBe(0);
    });

    it('keeps useful rows after malformed and oversized rows with finite bounded identities', async () => {
        recorderJsonl = [
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
        const captured = await control.captureDiagnostics({
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
        recorderJsonl =
            '{"name":"tail","agentId":"agent-a","atEpochMs":140,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-deleted","atEpochMs":139}},"atEpochMs":140}}\n';
        const captured = await control.captureDiagnostics({
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
        recorderJsonl =
            '{"name":"earlier","agentId":"agent-a","atEpochMs":50,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-created","atEpochMs":49}}}}\n';
        const captured = await control.captureDiagnostics({
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
        recorderJsonl = earlier.repeat(4000) +
            '{"name":"late","agentId":"agent-c","atEpochMs":140,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-timeout","atEpochMs":139,"peerId":"session-a"}},"atEpochMs":140}}\n';
        const captured = await control.captureDiagnostics({
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
                    bytesRead: Buffer.byteLength(recorderJsonl),
                    retainedBytes: 8_388_608,
                    retainedPrefixDropped: true,
                    transportTruncated: false,
                    retainedRows: 1
                },
                events: [{ eventId: 'late', kind: 'peer-timeout', controlAtEpochMs: 140, browserAtEpochMs: 139, peerId: 'session-a' }]
            }
        });
        expect(recorderReads).toBe(1);
    });

    it('selects late rows in stream order when earlier phases exceed the row scan limit', async () => {
        const earlier =
            '{"name":"earlier","agentId":"retired-agent","atEpochMs":50,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-created","atEpochMs":49}}}}\n';
        recorderJsonl = earlier.repeat(20_001) +
            '{"name":"late","agentId":"agent-c","atEpochMs":140,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-timeout","atEpochMs":139}}}}\n';
        const captured = await control.captureDiagnostics({
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
        recorderJsonl =
            '{"name":"earlier","agentId":"agent-a","atEpochMs":110,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-created","atEpochMs":109}}}}\n'
                .repeat(601) +
            '{"name":"late","agentId":"agent-c","atEpochMs":140,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-timeout","atEpochMs":139}}}}\n';
        const captured = await control.captureDiagnostics({
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
        recorderJsonl = earlier.repeat(22_000) +
            '{"name":"unread-late","agentId":"agent-c","atEpochMs":140,"value":{"topic":"rallar.browser.rtc.lifecycle","payload":{"data":{"kind":"peer-timeout","atEpochMs":139}}}}\n';
        const captured = await control.captureDiagnostics({
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
        expect(recorderReads).toBe(1);
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
        recorderJsonl = (row + '\n').repeat(eventCount);
        const captured = await control.captureDiagnostics({
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
        formation = {
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
        rtcDiagnosticPeers = [{
            peerId: 'session-b',
            connection: { reconnecting: false },
            lanes: [{ laneId: 'messages.rtc', isOpen: true, isReconnectable: true }]
        }];
        const captured = await control.captureDiagnostics({
            testInfo: {
                attach: async () => {
                    readyPeerIds = [];
                    formation = { stage: 'dormant', room: { state: 'closed' } };
                    rtcDiagnosticPeers = [];
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
        const laterHealth = await control.executeOk({ runId: 'run-state-change', agentId: 'agent-a', commandId: 'later-health', command: { kind: 'health' } });
        expect(control.readyPeerIds(laterHealth)).toEqual([]);
    });

    it.each(['attachment', 'sidecar', 'both'])('returns complete health despite optional %s output failure', async (failedOutput) => {
        if (failedOutput !== 'attachment') {
            rmSync(diagnosticsRoot, { recursive: true });
            writeFileSync(diagnosticsRoot, 'blocked-output');
        }
        const outputFailure = new Error('sensitive-output-sentinel');
        const captured = await control.captureDiagnostics({
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
            expect(readFileSync(path.join(diagnosticsRoot, 'live-rtc-diagnostics-attempt-failure-later-health.json'), 'utf8')).not.toContain(
                'sensitive-output-sentinel'
            );
        }
    });

    it('rejects an incomplete participant set instead of publishing a valid-looking checkpoint', async () => {
        const attachments: string[] = [];
        await expect(control.captureDiagnostics({
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
        healthCommandFailure = { agentId: 'agent-b', body: 'secret-health-failure-sentinel' };
        const attachments: string[] = [];
        await expect(control.captureDiagnostics({
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

    it.each(['health', 'sidecar'])('preserves the original readiness rejection when %s diagnostics fail', async (failedDiagnostic) => {
        const original = new Error('original readiness failure');
        refreshRoom.mockRejectedValue(original);
        if (failedDiagnostic === 'health') {
            healthCommandFailure = { agentId: 'agent-a', body: 'secret-health-failure-sentinel' };
        }
        else {
            rmSync(diagnosticsRoot, { recursive: true });
            writeFileSync(diagnosticsRoot, 'blocked-output');
        }
        await expect(control.waitForPeerReadiness({
            runId: 'run-readiness-failure',
            agent,
            expectedPeerIds: ['session-b'],
            suffix: 'failure',
            startedAtMs: 100
        })).rejects.toBe(original);
    });

    beforeEach(async () => {
        nowMs = 100;
        readyPeerIds = ['session-b', 'session-c'];
        rtcDiagnosticPeers = [];
        formation = undefined;
        diagnosticsRoot = mkdtempSync(
            path.join(tmpdir(), 'live-rtc-control-client-')
        );
        results = [];
        events = [];
        recorderJsonl = '';
        recorderStatus = 200;
        recorderReads = 0;
        captureEffects.length = 0;
        healthCommandFailure = undefined;
        holdHealthCommand = undefined;
        server = createServer(async (incoming, response) => {
            if (incoming.url?.endsWith('/events.jsonl')) {
                recorderReads += 1;
                captureEffects.push('history');
                response.writeHead(recorderStatus, { 'content-type': 'application/x-ndjson' }).end(recorderJsonl);
                return;
            }
            if (incoming.method === 'POST') {
                const chunks: Buffer[] = [];
                for await (const chunk of incoming) {
                    chunks.push(Buffer.from(chunk));
                }
                const command = normalizeJson(
                    JSON.parse(Buffer.concat(chunks).toString())
                );
                if (
                    !command ||
                    typeof command !== 'object' ||
                    !('commandId' in command) ||
                    typeof command.commandId !== 'string'
                ) {
                    response.writeHead(400).end();
                    return;
                }
                const agentId = incoming.url?.split('/')[4];
                captureEffects.push(`health:${agentId}`);
                if (
                    healthCommandFailure &&
                    agentId === healthCommandFailure.agentId &&
                    (command.commandId.startsWith('health-') || command.commandId.startsWith('rtc-diagnostics-'))
                ) {
                    response.writeHead(500).end(healthCommandFailure.body);
                    return;
                }
                if (holdHealthCommand && command.commandId.startsWith('health-message-failure-')) {
                    await holdHealthCommand(agentId ?? 'missing-agent');
                }
                results.push({
                    agentId,
                    commandId: command.commandId,
                    ok: true,
                    result: {
                        value: {
                            credential: 'secret-health-root-sentinel',
                            rallar: {
                                session: { accessToken: 'secret-health-session-sentinel' },
                                ...(formation ? { formation } : {}),
                                rtcStatus: {
                                    activePeerIds: readyPeerIds,
                                    readyPeerIds
                                },
                                rtcDiagnostics: {
                                    sessionId: 'health-session',
                                    generatedAtEpochMs: 0,
                                    peerCount: rtcDiagnosticPeers.length,
                                    connectedPeerCount: rtcDiagnosticPeers.length,
                                    relayPeerCount: 0,
                                    peers: rtcDiagnosticPeers
                                }
                            }
                        }
                    }
                });
                response.writeHead(202).end('{}');
                return;
            }
            response
                .writeHead(200, { 'content-type': 'application/json' })
                .end(JSON.stringify({ results, events }));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('Expected a local control HTTP port.');
        }
        api = await request.newContext();
        controlBaseUrl = `http://127.0.0.1:${address.port}`;
        control = new LiveRtcControlClient({
            request: api,
            baseUrl: controlBaseUrl,
            diagnosticsOutDir: diagnosticsRoot,
            monotonicNow: () => nowMs,
            epochNow: () => 0
        });
        refreshRoom.mockResolvedValue(undefined);
    });

    afterEach(async () => {
        await api.dispose();
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        refreshRoom.mockReset();
        rmSync(diagnosticsRoot, { recursive: true, force: true });
    });

    it('waits for refreshed room membership and includes refresh time in readiness', async () => {
        const refresh = Promise.withResolvers<void>();
        let roomMembers = ['session-a'];
        let refreshStarted = false;
        let completed = false;
        refreshRoom.mockImplementation(async () => {
            refreshStarted = true;
            await refresh.promise;
            roomMembers = ['session-a', 'session-b', 'session-c'];
            nowMs = 350;
        });

        const readiness = control
            .waitForPeerReadiness({
                runId: 'run-readiness',
                agent,
                expectedPeerIds: ['session-b', 'session-c'],
                suffix: 'delivery',
                startedAtMs: 100
            })
            .then((durationMs) => {
                completed = true;
                return durationMs;
            });
        try {
            await vi.waitFor(() => expect(refreshStarted).toBe(true));
            expect(completed).toBe(false);
            expect(roomMembers).toEqual(['session-a']);
        }
        finally {
            refresh.resolve();
        }
        expect(await readiness).toBe(250);
        expect(roomMembers).toEqual(['session-a', 'session-b', 'session-c']);
    });

    it('rechecks readiness after every room refresh while expected peers are missing', async () => {
        let refreshCount = 0;
        refreshRoom.mockImplementation(async () => {
            refreshCount += 1;
            nowMs += 100;
            readyPeerIds = refreshCount === 1 ? ['session-b'] : ['session-b', 'session-c'];
        });

        await expect(
            control.waitForPeerReadiness({
                runId: 'run-refresh-retry',
                agent,
                expectedPeerIds: ['session-b', 'session-c'],
                suffix: 'delayed-topology',
                startedAtMs: 100
            })
        ).resolves.toBe(200);
    });

    it('captures bounded failed command facts without retaining payloads or credentials', async () => {
        results.push({
            agentId: 'agent-a',
            commandId: 'send-broadcast',
            ok: false,
            result: {
                value: {
                    credential: 'must-not-be-retained',
                    message: toDeliveryObservationFixture(
                        {
                            handleId: 'message-broadcast',
                            state: 'failed',
                            reason: 'Skipping RTC outbound message without overlay context',
                            submitted: false,
                            confirmedHopPeerIds: [],
                            unconfirmedHopPeerIds: [],
                            receiptMode: undefined,
                            expectedRecipientPeerIds: [],
                            confirmedRecipientPeerIds: [],
                            unconfirmedRecipientPeerIds: [],
                            attempts: 1,
                            attemptOutcomes: [],
                            attemptCarriers: [],
                            relayRejection: undefined,
                            carrierFallback: undefined,
                            durabilityDowngrade: undefined,
                            failure: undefined,
                            backpressured: false,
                            enqueued: false
                        },
                        { payload: { resource: 'must-not-be-retained' } }
                    )
                }
            }
        });

        expect(
            await control.captureAttemptFailure({ runId: 'run-failed-send' })
        ).toEqual({
            kind: 'control-result-failures',
            runCaptureSucceeded: true,
            messageFailures: [],
            failedResults: [
                {
                    agentId: 'agent-a',
                    commandId: 'send-broadcast',
                    ok: false,
                    state: 'failed',
                    reason: 'Skipping RTC outbound message without overlay context',
                    submitted: false,
                    enqueued: false,
                    backpressured: false,
                    attempts: 1,
                    confirmedHopCount: 0,
                    unconfirmedHopCount: 0
                }
            ]
        });
    });

    it('rejects readiness when authoritative room refresh fails', async () => {
        refreshRoom.mockImplementation(async () => {
            throw new Error('room refresh unavailable');
        });

        await expect(
            control.waitForPeerReadiness({
                runId: 'run-readiness',
                agent,
                expectedPeerIds: ['session-b'],
                suffix: 'delivery',
                startedAtMs: 100
            })
        ).rejects.toThrow('room refresh unavailable');
    });

    it('does not report readiness after room refresh exhausts the shared deadline', async () => {
        readyPeerIds = [];
        refreshRoom.mockImplementation(async () => {
            nowMs = 60_101;
        });

        await expect(
            control.waitForPeerReadiness({
                runId: 'run-readiness',
                agent,
                expectedPeerIds: ['session-b'],
                suffix: 'delivery',
                startedAtMs: 100
            })
        ).rejects.toThrow('readiness deadline');
        const artifactBody = readFileSync(path.join(diagnosticsRoot, 'live-rtc-readiness-failure-agent-a-delivery.json'), 'utf8');
        expect(artifactBody).not.toContain('secret-health-');
        expect(JSON.parse(artifactBody)).toMatchObject({
            runId: 'run-readiness',
            agentId: 'agent-a',
            expectedPeerIds: ['session-b'],
            health: {
                agentId: 'agent-a',
                readyPeerIds: []
            }
        });
    });

    it('retains sender and receiver health when message delivery times out', async () => {
        results.push({
            agentId: 'agent-a',
            commandId: 'send-direct-timeout',
            ok: true,
            result: {
                value: {
                    message: toDeliveryObservationFixture(
                        {
                            handleId: 'message-direct-timeout',
                            state: 'submitted',
                            reason: 'awaiting a durable admission retry',
                            submitted: false,
                            confirmedHopPeerIds: [],
                            unconfirmedHopPeerIds: [],
                            receiptMode: undefined,
                            expectedRecipientPeerIds: [],
                            confirmedRecipientPeerIds: [],
                            unconfirmedRecipientPeerIds: [],
                            attempts: 1,
                            attemptOutcomes: [],
                            attemptCarriers: [],
                            relayRejection: undefined,
                            carrierFallback: undefined,
                            durabilityDowngrade: undefined,
                            failure: undefined,
                            backpressured: false,
                            enqueued: true
                        },
                        { payload: { resource: 'must-not-be-retained' } }
                    ),
                    credential: 'must-not-be-retained'
                }
            }
        });
        events.push({
            agentId: 'agent-b',
            payload: {
                kind: 'message',
                transport: 'messages.rtc',
                topic: 'direct-topic',
                payload: {
                    data: {
                        matrixId: 'an-earlier-message',
                        deliveryMode: 'direct',
                        credential: 'must-not-be-retained'
                    }
                }
            }
        });
        await expect(
            control.waitForMessage({
                runId: 'run-message-timeout',
                senderAgentId: 'agent-a',
                agentId: 'agent-b',
                transport: 'messages.rtc',
                matrixId: 'direct-timeout',
                deliveryMode: 'direct',
                startedAtMs: 100,
                timeoutMs: 10
            })
        ).rejects.toThrow('direct-timeout');

        const artifactBody = readFileSync(
            path.join(
                diagnosticsRoot,
                'live-rtc-message-failure-direct-timeout-agent-b.json'
            ),
            'utf8'
        );
        expect(artifactBody).not.toContain('must-not-be-retained');
        const artifact = JSON.parse(artifactBody);
        expect(artifact).toMatchObject({
            runId: 'run-message-timeout',
            senderAgentId: 'agent-a',
            receiverAgentId: 'agent-b',
            matrixId: 'direct-timeout',
            healthByAgentId: {
                'agent-a': { captureSucceeded: true, commandSucceeded: true },
                'agent-b': { captureSucceeded: true, commandSucceeded: true }
            }
        });
        expect(artifact.recentResults).toEqual(
            expect.arrayContaining([
                {
                    agentId: 'agent-a',
                    commandId: 'send-direct-timeout',
                    ok: true
                }
            ])
        );
        expect(artifact.sendResult).toEqual({
            ok: true,
            state: 'submitted',
            reason: 'awaiting a durable admission retry',
            messageIdPresent: true,
            submitted: false,
            enqueued: true,
            backpressured: false,
            attempts: 1,
            confirmedHopCount: 0,
            unconfirmedHopCount: 0
        });
        expect(artifact.recentEvents).toEqual([
            {
                agentId: 'agent-b',
                kind: 'message',
                transport: 'messages.rtc',
                topic: 'direct-topic',
                matrixId: 'an-earlier-message',
                deliveryMode: 'direct'
            }
        ]);
    });

    it('passes the settlement reason through verbatim, and reports null when absent', async () => {
        results.push({
            agentId: 'agent-a',
            commandId: 'send-broadcast-with-reason',
            ok: false,
            result: {
                value: {
                    message: toDeliveryObservationFixture({
                        handleId: 'message-with-reason',
                        state: 'failed',
                        reason: 'awaiting a durable admission retry',
                        submitted: false,
                        confirmedHopPeerIds: [],
                        unconfirmedHopPeerIds: [],
                        receiptMode: undefined,
                        expectedRecipientPeerIds: [],
                        confirmedRecipientPeerIds: [],
                        unconfirmedRecipientPeerIds: [],
                        attempts: 1,
                        attemptOutcomes: [],
                        attemptCarriers: [],
                        relayRejection: undefined,
                        carrierFallback: undefined,
                        durabilityDowngrade: undefined,
                        failure: undefined,
                        backpressured: false,
                        enqueued: false
                    })
                }
            }
        });
        results.push({
            agentId: 'agent-a',
            commandId: 'send-broadcast-without-reason',
            ok: false,
            result: {
                // No `reason` field, matching the wire shape when the producer recorded none.
                value: {
                    message: {
                        handleId: 'message-without-reason',
                        state: 'failed',
                        submitted: false,
                        confirmedHopPeerIds: [],
                        unconfirmedHopPeerIds: [],
                        expectedRecipientPeerIds: [],
                        confirmedRecipientPeerIds: [],
                        unconfirmedRecipientPeerIds: [],
                        attempts: 1,
                        backpressured: false,
                        enqueued: false
                    }
                }
            }
        });

        const attemptFailure = await control.captureAttemptFailure({ runId: 'run-reason-passthrough' });

        expect(attemptFailure.failedResults).toEqual([
            expect.objectContaining({
                commandId: 'send-broadcast-with-reason',
                reason: 'awaiting a durable admission retry'
            }),
            expect.objectContaining({
                commandId: 'send-broadcast-without-reason',
                reason: null
            })
        ]);
    });

    it('retains a sanitized message delivery failure without a diagnostics directory', async () => {
        results.push({
            agentId: 'agent-a',
            commandId: 'send-direct-timeout',
            ok: true,
            result: {
                value: {
                    message: toDeliveryObservationFixture(
                        {
                            handleId: 'message-direct-timeout',
                            state: 'submitted',
                            reason: 'awaiting a durable admission retry',
                            submitted: false,
                            confirmedHopPeerIds: [],
                            unconfirmedHopPeerIds: [],
                            receiptMode: undefined,
                            expectedRecipientPeerIds: [],
                            confirmedRecipientPeerIds: [],
                            unconfirmedRecipientPeerIds: [],
                            attempts: 1,
                            attemptOutcomes: [],
                            attemptCarriers: [],
                            relayRejection: undefined,
                            carrierFallback: undefined,
                            durabilityDowngrade: undefined,
                            failure: undefined,
                            backpressured: false,
                            enqueued: true
                        },
                        { payload: { resource: 'must-not-be-retained' } }
                    ),
                    credential: 'must-not-be-retained'
                }
            }
        });
        const controlWithoutDiagnosticsDirectory = new LiveRtcControlClient({
            request: api,
            baseUrl: controlBaseUrl,
            monotonicNow: () => nowMs,
            epochNow: () => 0
        });

        await expect(
            controlWithoutDiagnosticsDirectory.waitForMessage({
                runId: 'run-message-timeout',
                senderAgentId: 'agent-a',
                agentId: 'agent-b',
                transport: 'messages.rtc',
                matrixId: 'direct-timeout',
                deliveryMode: 'direct',
                startedAtMs: 100,
                timeoutMs: 10
            })
        ).rejects.toThrow('direct-timeout');
        await expect(
            controlWithoutDiagnosticsDirectory.waitForMessage({
                runId: 'run-message-timeout',
                senderAgentId: 'agent-b',
                agentId: 'agent-c',
                transport: 'messages.rtc',
                matrixId: 'cleanup-timeout',
                deliveryMode: 'direct',
                startedAtMs: 100,
                timeoutMs: 10
            })
        ).rejects.toThrow('cleanup-timeout');

        const attemptFailure = await controlWithoutDiagnosticsDirectory
            .captureAttemptFailure({ runId: 'run-message-timeout' });
        expect(JSON.stringify(attemptFailure)).not.toContain('must-not-be-retained');
        expect(attemptFailure).toMatchObject({
            kind: 'control-result-failures',
            runCaptureSucceeded: true,
            messageFailures: [
                {
                    kind: 'message-delivery-failure',
                    senderAgentId: 'agent-a',
                    receiverAgentId: 'agent-b',
                    transport: 'messages.rtc',
                    matrixId: 'direct-timeout',
                    deliveryMode: 'direct',
                    healthByAgentId: {
                        'agent-a': { captureSucceeded: true, commandSucceeded: true },
                        'agent-b': { captureSucceeded: true, commandSucceeded: true }
                    },
                    sendResult: {
                        state: 'submitted',
                        reason: 'awaiting a durable admission retry',
                        messageIdPresent: true,
                        submitted: false,
                        enqueued: true,
                        backpressured: false,
                        attempts: 1,
                        confirmedHopCount: 0,
                        unconfirmedHopCount: 0
                    }
                }
            ]
        });
    });

    it('does not retain a failed health-command response body in message failure evidence', async () => {
        healthCommandFailure = {
            agentId: 'agent-b',
            body: `credential=must-not-be-retained ${'x'.repeat(10_000)}`
        };
        const controlWithoutDiagnosticsDirectory = new LiveRtcControlClient({
            request: api,
            baseUrl: controlBaseUrl,
            monotonicNow: () => nowMs,
            epochNow: () => 0
        });

        await expect(
            controlWithoutDiagnosticsDirectory.waitForMessage({
                runId: 'run-health-failure',
                senderAgentId: 'agent-a',
                agentId: 'agent-b',
                transport: 'messages.rtc',
                matrixId: 'health-failure',
                deliveryMode: 'direct',
                startedAtMs: 100,
                timeoutMs: 10
            })
        ).rejects.toThrow('health-failure');

        const attemptFailure = await controlWithoutDiagnosticsDirectory
            .captureAttemptFailure({ runId: 'run-health-failure' });
        expect(JSON.stringify(attemptFailure)).not.toContain('must-not-be-retained');
        expect(attemptFailure.messageFailures[0]).toMatchObject({
            failure: {
                name: 'message-delivery-failed',
                message: 'RTC message delivery observation failed.'
            },
            healthByAgentId: {
                'agent-b': {
                    captureSucceeded: false,
                    commandSucceeded: null,
                    captureFailure: {
                        name: 'health-capture-failed',
                        message: 'RTC health diagnostic capture failed.'
                    }
                }
            }
        });
    });

    it('waits for both first-case receiver captures before returning attempt failure evidence', async () => {
        const releaseDelayedHealth = Promise.withResolvers<void>();
        const delayedHealthStarted = Promise.withResolvers<void>();
        holdHealthCommand = async (agentId) => {
            if (agentId === 'agent-c') {
                delayedHealthStarted.resolve();
                await releaseDelayedHealth.promise;
            }
        };
        const controlWithoutDiagnosticsDirectory = new LiveRtcControlClient({
            request: api,
            baseUrl: controlBaseUrl,
            monotonicNow: () => nowMs,
            epochNow: () => 0
        });
        const waitForAgentB = controlWithoutDiagnosticsDirectory.waitForMessage({
            runId: 'run-two-receiver-timeout',
            senderAgentId: 'agent-a',
            agentId: 'agent-b',
            transport: 'messages.rtc',
            matrixId: 'two-receiver-timeout',
            deliveryMode: 'multicast',
            possibleReceiverAgentIds: ['agent-b', 'agent-c'],
            startedAtMs: 100,
            timeoutMs: 10
        }).catch(() => undefined);
        const waitForAgentC = controlWithoutDiagnosticsDirectory.waitForMessage({
            runId: 'run-two-receiver-timeout',
            senderAgentId: 'agent-a',
            agentId: 'agent-c',
            transport: 'messages.rtc',
            matrixId: 'two-receiver-timeout',
            deliveryMode: 'multicast',
            possibleReceiverAgentIds: ['agent-b', 'agent-c'],
            startedAtMs: 100,
            timeoutMs: 10
        }).catch(() => undefined);

        await delayedHealthStarted.promise;
        const attemptFailure = controlWithoutDiagnosticsDirectory
            .captureAttemptFailure({ runId: 'run-two-receiver-timeout' });
        releaseDelayedHealth.resolve();

        await expect(attemptFailure).resolves.toMatchObject({
            messageFailures: [
                { receiverAgentId: 'agent-b' },
                { receiverAgentId: 'agent-c' }
            ]
        });
        await Promise.all([waitForAgentB, waitForAgentC]);
    });

    it('reads the sent message identity from the delivery observation, not the command ID', () => {
        expect(
            control.requireSentMessageId({
                commandId: 'nack-probe-command',
                ok: true,
                result: {
                    value: {
                        message: toDeliveryObservationFixture(
                            {
                                handleId: 'wire-message',
                                state: 'submitted',
                                reason: 'awaiting a durable admission retry',
                                submitted: true,
                                confirmedHopPeerIds: [],
                                unconfirmedHopPeerIds: [],
                                receiptMode: undefined,
                                expectedRecipientPeerIds: [],
                                confirmedRecipientPeerIds: [],
                                unconfirmedRecipientPeerIds: [],
                                attempts: 1,
                                attemptOutcomes: [],
                                attemptCarriers: [],
                                relayRejection: undefined,
                                carrierFallback: undefined,
                                durabilityDowngrade: undefined,
                                failure: undefined,
                                backpressured: false,
                                enqueued: true
                            }
                        )
                    }
                }
            })
        ).toBe('wire-message');
        expect(() =>
            control.requireSentMessageId({
                commandId: 'nack-probe-command',
                ok: true
            })
        ).toThrow('message ID');
    });

    it('attaches received-NACK proof with the message and peer identities', async () => {
        let artifact = '';
        await control.recordReceivedNack({
            testInfo: {
                attach: async (_name, options) => {
                    artifact = String(options?.body);
                }
            },
            runId: 'run-nack',
            agentId: 'agent-a',
            messageId: 'wire-message',
            senderSessionId: 'session-a',
            targetSessionId: 'session-b',
            frames: ['received-wire-frame']
        });
        expect(normalizeJson(JSON.parse(artifact))).toEqual({
            observation: 'received-protocol-nack',
            runId: 'run-nack',
            agentId: 'agent-a',
            messageId: 'wire-message',
            senderSessionId: 'session-a',
            targetSessionId: 'session-b',
            frames: ['received-wire-frame']
        });
    });

    it('captures bounded NACK failure evidence without raw frames or credentials', async () => {
        results.push({
            agentId: 'agent-a',
            commandId: 'nack-not-yet-in-sync-timeout',
            ok: true,
            result: {
                value: {
                    message: toDeliveryObservationFixture(
                        {
                            handleId: 'probe-message',
                            state: 'submitted',
                            reason: 'awaiting a durable admission retry',
                            submitted: false,
                            confirmedHopPeerIds: [],
                            unconfirmedHopPeerIds: [],
                            receiptMode: undefined,
                            expectedRecipientPeerIds: [],
                            confirmedRecipientPeerIds: [],
                            unconfirmedRecipientPeerIds: [],
                            attempts: 1,
                            attemptOutcomes: [],
                            attemptCarriers: [],
                            relayRejection: undefined,
                            carrierFallback: undefined,
                            durabilityDowngrade: undefined,
                            failure: undefined,
                            backpressured: false,
                            enqueued: true
                        },
                        { payload: { resource: 'must-not-be-retained' } }
                    ),
                    credential: 'must-not-be-retained'
                }
            }
        });
        events.push({
            agentId: 'agent-b',
            payload: {
                kind: 'message',
                transport: 'messages.rtc',
                topic: 'credential=must-not-be-retained',
                payload: {
                    data: {
                        matrixId: 'credential=must-not-be-retained',
                        credential: 'must-not-be-retained'
                    }
                }
            }
        });
        const diagnostic = await control.captureNackFailure({
            runId: 'run-nack-timeout',
            senderAgentId: 'agent-a',
            targetAgentId: 'agent-b',
            commandId: 'nack-not-yet-in-sync-timeout',
            stage: 'receive',
            messageId: 'probe-message',
            senderSessionId: 'session-a',
            targetSessionId: 'session-b',
            frames: [
                'credential=must-not-be-retained',
                JSON.stringify({
                    payload: {
                        typeId: 'al.control.nack.v1',
                        resource: JSON.stringify({
                            msgId: 'different-message',
                            reason: 'not-yet-in-sync',
                            fromPeerId: 'session-b',
                            toPeerId: 'session-a',
                            credential: 'must-not-be-retained'
                        })
                    }
                })
            ]
        });

        const artifactBody = JSON.stringify(diagnostic);
        expect(artifactBody).not.toContain('must-not-be-retained');
        expect(diagnostic).toMatchObject({
            kind: 'nack-probe-failure',
            runId: 'run-nack-timeout',
            senderAgentId: 'agent-a',
            targetAgentId: 'agent-b',
            commandId: 'nack-not-yet-in-sync-timeout',
            stage: 'receive',
            failureMessage: 'RTC NACK probe did not observe the expected response.',
            healthByAgentId: {
                'agent-a': { captureSucceeded: true, commandSucceeded: true },
                'agent-b': { captureSucceeded: true, commandSucceeded: true }
            },
            runCaptureSucceeded: true,
            sendResult: {
                ok: true,
                state: 'submitted',
                reason: 'awaiting a durable admission retry',
                messageIdPresent: true,
                submitted: false,
                enqueued: true,
                backpressured: false,
                attempts: 1,
                confirmedHopCount: 0,
                unconfirmedHopCount: 0,
                messageIdMatchesProbe: true
            },
            wireObservation: {
                frameCount: 2,
                malformedFrameCount: 1,
                typedFrameCount: 1,
                nackFrameCount: 1,
                malformedNackFrameCount: 0,
                nackFrames: [
                    {
                        hasMessageId: true,
                        messageIdMatchesProbe: false,
                        reason: 'not-yet-in-sync',
                        hasFromPeerId: true,
                        fromPeerIdMatchesTarget: true,
                        hasToPeerId: true,
                        toPeerIdMatchesSender: true,
                        matchesProbe: false
                    }
                ]
            },
            recentEvents: [
                {
                    agentRole: 'target',
                    kind: 'message',
                    transport: 'messages.rtc',
                    topicPresent: true,
                    matrixIdPresent: true,
                    deliveryMode: 'missing'
                }
            ]
        });
        expect(diagnostic.recentResults).toContainEqual({
            agentRole: 'sender',
            commandRole: 'probe',
            ok: true
        });
    });
});
