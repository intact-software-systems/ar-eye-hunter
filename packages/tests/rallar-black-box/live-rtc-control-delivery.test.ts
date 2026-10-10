import {
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import path from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import { createDefaultLiveRtcControlHttpFixture, LiveRtcControlHttpFixture } from './live-rtc-control-http-fixture.ts';
import { toDeliveryObservationFixture } from './to-delivery-observation-fixture.ts';

describe('live RTC control client', () => {
    let httpFixture: LiveRtcControlHttpFixture;
    const refreshRoom = vi.fn<LiveRtcControlClient.FormationAgent['refreshRoom']>();
    const agent = { agentId: 'agent-a', prefix: 'A' as const, refreshRoom };
    beforeEach(async () => {
        httpFixture = await createDefaultLiveRtcControlHttpFixture();
        refreshRoom.mockResolvedValue(undefined);
    });
    afterEach(async () => {
        await httpFixture.close();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        refreshRoom.mockReset();
    });
    it.each(['health', 'sidecar'])('preserves the original readiness rejection when %s diagnostics fail', async (failedDiagnostic) => {
        const original = new Error('original readiness failure');
        refreshRoom.mockRejectedValue(original);
        if (failedDiagnostic === 'health') {
            httpFixture.state.healthCommandFailure = { agentId: 'agent-a', body: 'secret-health-failure-sentinel' };
        }
        else {
            rmSync(httpFixture.diagnosticsRoot, { recursive: true });
            writeFileSync(httpFixture.diagnosticsRoot, 'blocked-output');
        }
        await expect(httpFixture.control.waitForPeerReadiness({
            runId: 'run-readiness-failure',
            agent,
            expectedPeerIds: ['session-b'],
            suffix: 'failure',
            startedAtMs: 100
        })).rejects.toBe(original);
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
            httpFixture.state.nowMs = 350;
        });

        const readiness = httpFixture.control
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
            httpFixture.state.nowMs += 100;
            httpFixture.state.readyPeerIds = refreshCount === 1 ? ['session-b'] : ['session-b', 'session-c'];
        });

        await expect(
            httpFixture.control.waitForPeerReadiness({
                runId: 'run-refresh-retry',
                agent,
                expectedPeerIds: ['session-b', 'session-c'],
                suffix: 'delayed-topology',
                startedAtMs: 100
            })
        ).resolves.toBe(200);
    });

    it('captures bounded failed command facts without retaining payloads or credentials', async () => {
        httpFixture.state.results.push({
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
                            attemptRefusalReasons: [],
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
            await httpFixture.control.captureAttemptFailure({ runId: 'run-failed-send' })
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
            httpFixture.control.waitForPeerReadiness({
                runId: 'run-readiness',
                agent,
                expectedPeerIds: ['session-b'],
                suffix: 'delivery',
                startedAtMs: 100
            })
        ).rejects.toThrow('room refresh unavailable');
    });

    it('does not report readiness after room refresh exhausts the shared deadline', async () => {
        httpFixture.state.readyPeerIds = [];
        refreshRoom.mockImplementation(async () => {
            httpFixture.state.nowMs = 60_101;
        });

        await expect(
            httpFixture.control.waitForPeerReadiness({
                runId: 'run-readiness',
                agent,
                expectedPeerIds: ['session-b'],
                suffix: 'delivery',
                startedAtMs: 100
            })
        ).rejects.toThrow('readiness deadline');
        const artifactBody = readFileSync(path.join(httpFixture.diagnosticsRoot, 'live-rtc-readiness-failure-agent-a-delivery.json'), 'utf8');
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
        httpFixture.state.results.push({
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
                            attemptRefusalReasons: [],
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
            httpFixture.control.waitForMessage({
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
                httpFixture.diagnosticsRoot,
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
        httpFixture.state.results.push({
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
                        attemptRefusalReasons: [],
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
        httpFixture.state.results.push({
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

        const attemptFailure = await httpFixture.control.captureAttemptFailure({ runId: 'run-reason-passthrough' });

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
        httpFixture.state.results.push({
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
                            attemptRefusalReasons: [],
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
            request: httpFixture.request,
            baseUrl: httpFixture.baseUrl,
            monotonicNow: () => httpFixture.state.nowMs,
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
        httpFixture.state.healthCommandFailure = {
            agentId: 'agent-b',
            body: `credential=must-not-be-retained ${'x'.repeat(10_000)}`
        };
        const controlWithoutDiagnosticsDirectory = new LiveRtcControlClient({
            request: httpFixture.request,
            baseUrl: httpFixture.baseUrl,
            monotonicNow: () => httpFixture.state.nowMs,
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
        httpFixture.state.holdHealthCommand = async (agentId) => {
            if (agentId === 'agent-c') {
                delayedHealthStarted.resolve();
                await releaseDelayedHealth.promise;
            }
        };
        const controlWithoutDiagnosticsDirectory = new LiveRtcControlClient({
            request: httpFixture.request,
            baseUrl: httpFixture.baseUrl,
            monotonicNow: () => httpFixture.state.nowMs,
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
});
