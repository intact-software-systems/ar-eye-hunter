import { request, type APIRequestContext } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
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
import { normalizeJson } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';

describe('live RTC control client', () => {
    let server: Server;
    let api: APIRequestContext;
    let control: LiveRtcControlClient;
    let nowMs: number;
    let readyPeerIds: string[];
    let diagnosticsRoot: string;
    let results: LiveRtcControlClient.Result[];
    let events: LiveRtcControlClient.Event[];
    const refreshRoom = vi.fn<LiveRtcControlClient.FormationAgent['refreshRoom']>();
    const agent = { agentId: 'agent-a', prefix: 'A' as const, refreshRoom };

    beforeEach(async () => {
        nowMs = 100;
        readyPeerIds = ['session-b', 'session-c'];
        diagnosticsRoot = mkdtempSync(path.join(tmpdir(), 'live-rtc-control-client-'));
        results = [];
        events = [];
        server = createServer(async (incoming, response) => {
            if (incoming.method === 'POST') {
                const chunks: Buffer[] = [];
                for await (const chunk of incoming) {
                    chunks.push(Buffer.from(chunk));
                }
                const command = normalizeJson(JSON.parse(Buffer.concat(chunks).toString()));
                if (!command || typeof command !== 'object' || !('commandId' in command) || typeof command.commandId !== 'string') {
                    response.writeHead(400).end();
                    return;
                }
                results.push({
                    commandId: command.commandId,
                    ok: true,
                    result: { value: { rallar: { rtcStatus: { readyPeerIds } } } }
                });
                response.writeHead(202).end('{}');
                return;
            }
            response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results, events }));
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
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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

        const readiness = control.waitForPeerReadiness({
            runId: 'run-readiness',
            agent,
            expectedPeerIds: ['session-b', 'session-c'],
            suffix: 'delivery',
            startedAtMs: 100
        }).then((durationMs) => {
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
            readyPeerIds = refreshCount === 1
                ? ['session-b']
                : ['session-b', 'session-c'];
        });

        await expect(control.waitForPeerReadiness({
            runId: 'run-refresh-retry',
            agent,
            expectedPeerIds: ['session-b', 'session-c'],
            suffix: 'delayed-topology',
            startedAtMs: 100
        })).resolves.toBe(200);
    });

    it('rejects readiness when authoritative room refresh fails', async () => {
        refreshRoom.mockImplementation(async () => {
            throw new Error('room refresh unavailable');
        });

        await expect(control.waitForPeerReadiness({
            runId: 'run-readiness',
            agent,
            expectedPeerIds: ['session-b'],
            suffix: 'delivery',
            startedAtMs: 100
        })).rejects.toThrow('room refresh unavailable');
    });

    it('does not report readiness after room refresh exhausts the shared deadline', async () => {
        readyPeerIds = [];
        refreshRoom.mockImplementation(async () => {
            nowMs = 60_101;
        });

        await expect(control.waitForPeerReadiness({
            runId: 'run-readiness',
            agent,
            expectedPeerIds: ['session-b'],
            suffix: 'delivery',
            startedAtMs: 100
        })).rejects.toThrow('readiness deadline');
        expect(
            JSON.parse(
                readFileSync(
                    path.join(diagnosticsRoot, 'live-rtc-readiness-failure-agent-a-delivery.json'),
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
            result: { value: { credential: 'must-not-be-retained' } }
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
        await expect(control.waitForMessage({
            runId: 'run-message-timeout',
            senderAgentId: 'agent-a',
            agentId: 'agent-b',
            transport: 'messages.rtc',
            matrixId: 'direct-timeout',
            deliveryMode: 'direct',
            startedAtMs: 100,
            timeoutMs: 10
        })).rejects.toThrow('direct-timeout');

        const artifactBody = readFileSync(
            path.join(diagnosticsRoot, 'live-rtc-message-failure-direct-timeout-agent-b.json'),
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
                'agent-a': { ok: true },
                'agent-b': { ok: true }
            }
        });
        expect(artifact.recentResults).toEqual(expect.arrayContaining([{
            agentId: 'agent-a',
            commandId: 'send-direct-timeout',
            ok: true
        }]));
        expect(artifact.recentEvents).toEqual([{
            agentId: 'agent-b',
            kind: 'message',
            transport: 'messages.rtc',
            topic: 'direct-topic',
            matrixId: 'an-earlier-message',
            deliveryMode: 'direct'
        }]);
    });

    it('reads the sent message identity from the RTC send-result envelope, not the command ID', () => {
        expect(control.requireSentMessageId({
            commandId: 'nack-probe-command',
            ok: true,
            result: { value: { message: { transport: 'rtc', status: 'sent', message: { id: { msgId: 'wire-message' } } } } }
        })).toBe('wire-message');
        expect(() => control.requireSentMessageId({ commandId: 'nack-probe-command', ok: true }))
            .toThrow('message ID');
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
});
