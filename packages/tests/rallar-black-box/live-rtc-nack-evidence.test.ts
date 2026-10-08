import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeJson } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';
import { createDefaultLiveRtcControlHttpFixture, LiveRtcControlHttpFixture } from './live-rtc-control-http-fixture.ts';
import { toDeliveryObservationFixture } from './to-delivery-observation-fixture.ts';

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
    it('reads the sent message identity from the delivery observation, not the command ID', () => {
        expect(
            httpFixture.control.requireSentMessageId({
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
            httpFixture.control.requireSentMessageId({
                commandId: 'nack-probe-command',
                ok: true
            })
        ).toThrow('message ID');
    });

    it('attaches received-NACK proof with the message and peer identities', async () => {
        let artifact = '';
        await httpFixture.control.recordReceivedNack({
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
        httpFixture.state.results.push({
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
        httpFixture.state.events.push({
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
        const diagnostic = await httpFixture.control.captureNackFailure({
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
                        typeId: 'al.control.nack.v2',
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
