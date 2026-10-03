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
    let nowMs: number;
    let readyPeerIds: string[];
    let rtcDiagnosticPeers: LiveRtcJsonRecord[];
    let formation: LiveRtcJsonRecord | undefined;
    let diagnosticsRoot: string;
    let results: LiveRtcControlClient.Result[];
    let events: LiveRtcControlClient.Event[];
    let healthCommandFailure: { agentId: string; body: string; } | undefined;
    let holdHealthCommand: ((agentId: string) => Promise<void>) | undefined;
    const refreshRoom = vi.fn<LiveRtcControlClient.FormationAgent['refreshRoom']>();
    const agent = { agentId: 'agent-a', prefix: 'A' as const, refreshRoom };

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
