import { request, type APIRequestContext } from '@playwright/test';
import type { BlackBoxRallarDeliveryObservation } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RtcBaselineJson } from '../../shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';

import { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import { normalizeJson } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';

/** Spreads a real delivery observation, then explicitly named contamination the producer never emits. */
function toSendDiagnosticsFixture(
    observation: BlackBoxRallarDeliveryObservation,
    contamination: Readonly<Record<string, RtcBaselineJson>>
): RtcBaselineJson {
    return normalizeJson({ ...observation, ...contamination });
}

describe('live RTC control client', () => {
    let server: Server;
    let api: APIRequestContext;
    let control: LiveRtcControlClient;
    let nowMs: number;
    let readyPeerIds: string[];
    let diagnosticsRoot: string;
    let results: LiveRtcControlClient.Result[];
    let events: LiveRtcControlClient.Event[];
    let healthCommandFailure: { agentId: string; body: string; } | undefined;
    let holdHealthCommand: ((agentId: string) => Promise<void>) | undefined;
    const refreshRoom = vi.fn<LiveRtcControlClient.FormationAgent['refreshRoom']>();
    const agent = { agentId: 'agent-a', prefix: 'A' as const, refreshRoom };

    beforeEach(async () => {
        nowMs = 100;
        readyPeerIds = ['session-b', 'session-c'];
        diagnosticsRoot = mkdtempSync(
            path.join(tmpdir(), 'live-rtc-control-client-')
        );
        results = [];
        events = [];
        healthCommandFailure = undefined;
        holdHealthCommand = undefined;
        server = createServer(async (incoming, response) => {
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
                if (
                    healthCommandFailure &&
                    agentId === healthCommandFailure.agentId &&
                    command.commandId.startsWith('health-message-failure-')
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
                            rallar: {
                                rtcStatus: {
                                    activePeerIds: readyPeerIds,
                                    readyPeerIds
                                },
                                rtcDiagnostics: {
                                    sessionId: 'health-session',
                                    generatedAtEpochMs: 0,
                                    peerCount: 0,
                                    connectedPeerCount: 0,
                                    relayPeerCount: 0,
                                    peers: []
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
        control = new LiveRtcControlClient({
            request: api,
            baseUrl: `http://127.0.0.1:${address.port}`,
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
                    message: toSendDiagnosticsFixture(
                        {
                            handleId: 'message-broadcast',
                            state: 'failed',
                            reason: 'Skipping RTC outbound message without overlay context',
                            submitted: false,
                            confirmedHopPeerIds: [],
                            unconfirmedHopPeerIds: [],
                            attempts: 1,
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
        expect(
            JSON.parse(
                readFileSync(
                    path.join(
                        diagnosticsRoot,
                        'live-rtc-readiness-failure-agent-a-delivery.json'
                    ),
                    'utf8'
                )
            )
        ).toMatchObject({
            runId: 'run-readiness',
            agentId: 'agent-a',
            expectedPeerIds: ['session-b'],
            health: {
                ok: true,
                result: {
                    value: {
                        rallar: { rtcStatus: { readyPeerIds: [] } }
                    }
                }
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
                    message: toSendDiagnosticsFixture(
                        {
                            handleId: 'message-direct-timeout',
                            state: 'submitted',
                            reason: 'awaiting a durable admission retry',
                            submitted: false,
                            confirmedHopPeerIds: [],
                            unconfirmedHopPeerIds: [],
                            attempts: 1,
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

    it('retains a sanitized message delivery failure without a diagnostics directory', async () => {
        results.push({
            agentId: 'agent-a',
            commandId: 'send-direct-timeout',
            ok: true,
            result: {
                value: {
                    message: toSendDiagnosticsFixture(
                        {
                            handleId: 'message-direct-timeout',
                            state: 'submitted',
                            reason: 'awaiting a durable admission retry',
                            submitted: false,
                            confirmedHopPeerIds: [],
                            unconfirmedHopPeerIds: [],
                            attempts: 1,
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
            baseUrl: `http://127.0.0.1:${(server.address() as { port: number; }).port}`,
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
            baseUrl: `http://127.0.0.1:${(server.address() as { port: number; }).port}`,
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
            baseUrl: `http://127.0.0.1:${(server.address() as { port: number; }).port}`,
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
                        message: toSendDiagnosticsFixture(
                            {
                                handleId: 'wire-message',
                                state: 'submitted',
                                reason: 'awaiting a durable admission retry',
                                submitted: true,
                                confirmedHopPeerIds: [],
                                unconfirmedHopPeerIds: [],
                                attempts: 1,
                                backpressured: false,
                                enqueued: true
                            },
                            {}
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
                    message: toSendDiagnosticsFixture(
                        {
                            handleId: 'probe-message',
                            state: 'submitted',
                            reason: 'awaiting a durable admission retry',
                            submitted: false,
                            confirmedHopPeerIds: [],
                            unconfirmedHopPeerIds: [],
                            attempts: 1,
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
