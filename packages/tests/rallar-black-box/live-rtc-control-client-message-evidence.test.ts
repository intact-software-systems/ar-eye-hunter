import type { BlackBoxRallarDeliveryObservation } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import { normalizeJson, type LiveRtcJsonRecord } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';
import {
    createLiveRtcControlClientTestFixture,
    type LiveRtcControlClientTestState
} from './live-rtc-control-client-test-fixture.ts';

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

describe('live RTC control client message and NACK evidence', () => {
    let fixture: Awaited<ReturnType<typeof createLiveRtcControlClientTestFixture>>;
    let state: LiveRtcControlClientTestState;
    let control: LiveRtcControlClient;
    let diagnosticsRoot: string;
    let api: typeof fixture.api;
    let baseUrl: string;

    beforeEach(async () => {
        fixture = await createLiveRtcControlClientTestFixture();
        ({ state, control, diagnosticsRoot, api, baseUrl } = fixture);
    });

    afterEach(async () => await fixture.close());

    it('captures bounded failed command facts without retaining payloads or credentials', async () => {
        state.results.push({
            agentId: 'agent-a',
            commandId: 'send-broadcast',
            ok: false,
            error: {
                details: {
                    credential: 'must-not-be-retained',
                    message: toDeliveryObservationFixture(
                        {
                            handleId: 'message-broadcast',
                            state: 'failed',
                            reason: 'other',
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
                            backpressured: false,
                            enqueued: false
                        },
                        { payload: { resource: 'must-not-be-retained' } }
                    )
                }
            }
        });

        const diagnostic = await control.captureAttemptFailure({
            runId: 'run-failed-send'
        });
        expect(JSON.stringify(diagnostic)).not.toContain('must-not-be-retained');
        expect(diagnostic).toEqual({
            kind: 'control-result-failures',
            runCaptureSucceeded: true,
            messageFailures: [],
            failedResults: [
                {
                    agentId: 'agent-a',
                    commandId: 'send-broadcast',
                    ok: false,
                    state: 'failed',
                    reason: 'other',
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

    it('retains sender and receiver health when message delivery times out', async () => {
        state.results.push({
            agentId: 'agent-a',
            commandId: 'send-direct-timeout',
            ok: true,
            result: {
                value: {
                    message: toDeliveryObservationFixture(
                        {
                            handleId: 'message-direct-timeout',
                            state: 'submitted',
                            reason: 'other',
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
                            backpressured: false,
                            enqueued: true
                        },
                        { payload: { resource: 'must-not-be-retained' } }
                    ),
                    credential: 'must-not-be-retained'
                }
            }
        });
        state.events.push({
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
            reason: 'other',
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

    it('bounds the settlement reason, and reports null when absent', async () => {
        state.results.push({
            agentId: 'agent-a',
            commandId: 'send-broadcast-with-reason',
            ok: false,
            error: {
                details: {
                    message: toDeliveryObservationFixture({
                        handleId: 'message-with-reason',
                        state: 'failed',
                        reason: 'other',
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
                        backpressured: false,
                        enqueued: false
                    })
                }
            }
        });
        state.results.push({
            agentId: 'agent-a',
            commandId: 'send-broadcast-without-reason',
            ok: false,
            error: {
                // No `reason` field, matching the wire shape when the producer recorded none.
                details: {
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
                reason: 'other'
            }),
            expect.objectContaining({
                commandId: 'send-broadcast-without-reason',
                reason: null
            })
        ]);
    });

    it('retains a sanitized message delivery failure without a diagnostics directory', async () => {
        state.results.push({
            agentId: 'agent-a',
            commandId: 'send-direct-timeout',
            ok: false,
            error: {
                details: {
                    message: toDeliveryObservationFixture(
                        {
                            handleId: 'message-direct-timeout',
                            state: 'submitted',
                            reason: 'other',
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
            baseUrl,
            monotonicNow: () => state.nowMs,
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
                        reason: 'other',
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
        state.healthCommandFailure = {
            agentId: 'agent-b',
            body: `credential=must-not-be-retained ${'x'.repeat(10_000)}`
        };
        const controlWithoutDiagnosticsDirectory = new LiveRtcControlClient({
            request: api,
            baseUrl,
            monotonicNow: () => state.nowMs,
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

    it('uses collision-free bounded command identities for concurrent message-failure health', async () => {
        state.healthValues['agent:a'] = rtcHealthValue('session-colon', 1);
        state.healthValues['agent-a'] = rtcHealthValue('session-hyphen', 2);
        const controlWithoutDiagnosticsDirectory = new LiveRtcControlClient({
            request: api,
            baseUrl,
            monotonicNow: () => state.nowMs,
            epochNow: () => 0
        });

        await expect(
            controlWithoutDiagnosticsDirectory.waitForMessage({
                runId: 'run-message-command-collision',
                senderAgentId: 'agent:a',
                agentId: 'agent-a',
                transport: 'messages.rtc',
                matrixId: 'message-command-collision',
                deliveryMode: 'direct',
                possibleReceiverAgentIds: ['agent-a'],
                startedAtMs: 100,
                timeoutMs: 10
            })
        ).rejects.toThrow('message-command-collision');

        const attemptFailure = await controlWithoutDiagnosticsDirectory
            .captureAttemptFailure({ runId: 'run-message-command-collision' });
        expect(attemptFailure.messageFailures[0]?.healthByAgentId).toMatchObject({
            'agent:a': { peerCount: 1 },
            'agent-a': { peerCount: 2 }
        });
        expect(state.failureHealthCommandIds).toHaveLength(2);
        expect(new Set(state.failureHealthCommandIds).size).toBe(2);
        expect(state.failureHealthCommandIds.join('\n')).not.toMatch(/agent:a|agent-a/u);
    });

    it('separates colliding receiver identities across retained message-failure captures', async () => {
        state.healthValues['sender'] = rtcHealthValue('session-sender', 1);
        state.healthValues['agent:a'] = rtcHealthValue('session-colon', 2);
        state.healthValues['agent-a'] = rtcHealthValue('session-hyphen', 3);
        const controlWithoutDiagnosticsDirectory = new LiveRtcControlClient({
            request: api,
            baseUrl,
            monotonicNow: () => state.nowMs,
            epochNow: () => 0
        });
        const possibleReceiverAgentIds = ['agent:a', 'agent-a'];

        for (const receiverAgentId of possibleReceiverAgentIds) {
            await expect(
                controlWithoutDiagnosticsDirectory.waitForMessage({
                    runId: 'run-receiver-command-collision',
                    senderAgentId: 'sender',
                    agentId: receiverAgentId,
                    transport: 'messages.rtc',
                    matrixId: 'receiver-command-collision',
                    deliveryMode: 'multicast',
                    possibleReceiverAgentIds,
                    startedAtMs: 100,
                    timeoutMs: 10
                })
            ).rejects.toThrow('receiver-command-collision');
        }

        const attemptFailure = await controlWithoutDiagnosticsDirectory
            .captureAttemptFailure({ runId: 'run-receiver-command-collision' });
        expect(attemptFailure.messageFailures).toMatchObject([
            {
                receiverAgentId: 'agent:a',
                healthByAgentId: {
                    sender: { peerCount: 1 },
                    'agent:a': { peerCount: 2 }
                }
            },
            {
                receiverAgentId: 'agent-a',
                healthByAgentId: {
                    sender: { peerCount: 1 },
                    'agent-a': { peerCount: 3 }
                }
            }
        ]);
        expect(state.failureHealthCommandIds).toHaveLength(4);
        expect(new Set(state.failureHealthCommandIds).size).toBe(4);
    });

    it('waits for both first-case receiver captures before returning attempt failure evidence', async () => {
        const releaseDelayedHealth = Promise.withResolvers<void>();
        const delayedHealthStarted = Promise.withResolvers<void>();
        state.holdHealthCommand = async (agentId) => {
            if (agentId === 'agent-c') {
                delayedHealthStarted.resolve();
                await releaseDelayedHealth.promise;
            }
        };
        const controlWithoutDiagnosticsDirectory = new LiveRtcControlClient({
            request: api,
            baseUrl,
            monotonicNow: () => state.nowMs,
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
                                reason: 'other',
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
        state.results.push({
            agentId: 'agent-a',
            commandId: 'nack-not-yet-in-sync-timeout',
            ok: true,
            result: {
                value: {
                    message: toDeliveryObservationFixture(
                        {
                            handleId: 'probe-message',
                            state: 'submitted',
                            reason: 'other',
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
                            backpressured: false,
                            enqueued: true
                        },
                        { payload: { resource: 'must-not-be-retained' } }
                    ),
                    credential: 'must-not-be-retained'
                }
            }
        });
        state.events.push({
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
                reason: 'other',
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

    it('uses collision-free bounded command identities for concurrent NACK health', async () => {
        state.healthValues['agent:a'] = rtcHealthValue('session-colon', 1);
        state.healthValues['agent-a'] = rtcHealthValue('session-hyphen', 2);

        const diagnostic = await control.captureNackFailure({
            runId: 'run-nack-command-collision',
            senderAgentId: 'agent:a',
            targetAgentId: 'agent-a',
            commandId: 'nack-command-collision',
            stage: 'receive',
            messageId: 'message',
            senderSessionId: 'session-colon',
            targetSessionId: 'session-hyphen',
            frames: []
        });

        expect(diagnostic.healthByAgentId).toMatchObject({
            'agent:a': { peerCount: 1 },
            'agent-a': { peerCount: 2 }
        });
        expect(state.failureHealthCommandIds).toHaveLength(2);
        expect(new Set(state.failureHealthCommandIds).size).toBe(2);
        expect(state.failureHealthCommandIds.join('\n')).not.toMatch(/agent:a|agent-a/u);
    });
});

function rtcHealthValue(
    sessionId: string,
    peerCount: number
): LiveRtcJsonRecord {
    return {
        rallar: {
            rtcStatus: {
                activePeerIds: [],
                readyPeerIds: []
            },
            rtcDiagnostics: {
                sessionId,
                generatedAtEpochMs: 0,
                peerCount,
                connectedPeerCount: 0,
                relayPeerCount: 0,
                peers: []
            }
        }
    };
}
