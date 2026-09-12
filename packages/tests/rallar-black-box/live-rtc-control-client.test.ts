import { request, type APIRequestContext } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import { normalizeJson, type LiveRtcJsonRecord } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';

describe('live RTC control client', () => {
    let server: Server;
    let api: APIRequestContext;
    let baseUrl: string;
    let control: LiveRtcControlClient;
    let nowMs: number;
    let readyPeerIds: string[];
    let diagnosticsRoot: string;
    let results: LiveRtcControlClient.Result[];
    let events: LiveRtcControlClient.Event[];
    let healthCommandFailure: { agentId: string; body: string; } | undefined;
    let holdHealthCommand: ((agentId: string) => Promise<void>) | undefined;
    let healthValues: Record<string, LiveRtcJsonRecord>;
    let runAgentIds: string[];
    let readinessHealthAgents: string[];
    let failureHealthCommandIds: string[];
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
        healthValues = {};
        runAgentIds = ['agent-a'];
        readinessHealthAgents = [];
        failureHealthCommandIds = [];
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
                const encodedAgentId = incoming.url?.split('/')[4];
                const agentId = encodedAgentId === undefined ? undefined : decodeURIComponent(encodedAgentId);
                if (command.commandId.startsWith('health-readiness-failure-')) {
                    readinessHealthAgents.push(agentId ?? 'missing-agent');
                }
                if (/^health-(message|readiness|nack)-failure-/u.test(command.commandId)) {
                    failureHealthCommandIds.push(command.commandId);
                }
                if (
                    healthCommandFailure &&
                    agentId === healthCommandFailure.agentId &&
                    /health-(message|readiness)-failure-/.test(command.commandId)
                ) {
                    response.writeHead(500).end(healthCommandFailure.body);
                    return;
                }
                if (holdHealthCommand && /health-(message|readiness)-failure-/.test(command.commandId)) {
                    await holdHealthCommand(agentId ?? 'missing-agent');
                }
                if (!results.some((result) => result.commandId === command.commandId)) {
                    results.push({
                        agentId,
                        commandId: command.commandId,
                        ok: true,
                        result: {
                            value: healthValues[agentId ?? ''] ?? {
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
                }
                response.writeHead(202).end('{}');
                return;
            }
            response
                .writeHead(200, { 'content-type': 'application/json' })
                .end(JSON.stringify({ agents: runAgentIds.map((agentId) => ({ agentId })), results, events }));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('Expected a local control HTTP port.');
        }
        api = await request.newContext();
        baseUrl = `http://127.0.0.1:${address.port}`;
        control = new LiveRtcControlClient({
            request: api,
            baseUrl,
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
                participantAgents: [agent],
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
                participantAgents: [agent],
                expectedPeerIds: ['session-b', 'session-c'],
                suffix: 'delayed-topology',
                startedAtMs: 100
            })
        ).resolves.toBe(200);
        expect(readdirSync(diagnosticsRoot)).toEqual([]);
    });

    it('does no failure capture when the readiness sidecar is disabled', async () => {
        const withoutSidecar = new LiveRtcControlClient({ request: api, baseUrl, monotonicNow: () => nowMs, epochNow: () => 0 });
        const failure = new Error('refresh failed without diagnostics');
        refreshRoom.mockRejectedValue(failure);
        await expect(
            withoutSidecar.waitForPeerReadiness({
                runId: 'run-disabled',
                agent,
                participantAgents: [agent],
                expectedPeerIds: ['session-b'],
                suffix: 'disabled',
                startedAtMs: 100
            })
        ).rejects.toBe(failure);
        expect(results).toEqual([]);
        expect(readdirSync(diagnosticsRoot)).toEqual([]);
    });

    it('captures only bounded error-details facts from real failed command envelopes', async () => {
        results.push(
            {
                agentId: 'agent-a',
                commandId: 'send-broadcast',
                ok: false,
                error: {
                    code: 'RALLAR_BB_RTC_NO_ROUTE',
                    message: 'producer failure includes must-not-be-retained',
                    details: {
                        credential: 'must-not-be-retained',
                        status: 'sent',
                        message: {
                            status: 'no-route',
                            reason: 'Skipping RTC outbound message without overlay context',
                            message: {
                                id: { msgId: 'message-must-not-be-retained' },
                                payload: { resource: 'must-not-be-retained' }
                            },
                            entries: []
                        }
                    }
                }
            },
            {
                agentId: 'agent-a',
                commandId: 'send-malformed-details',
                ok: false,
                error: { details: 'must-not-be-retained' }
            },
            {
                agentId: 'agent-a',
                commandId: 'send-absent-details',
                ok: false,
                error: { code: 'RALLAR_BB_RTC_SEND_FAILED' }
            },
            {
                agentId: 'agent-a',
                commandId: 'send-contradictory',
                ok: false,
                result: {
                    value: {
                        status: 'sent',
                        message: {
                            status: 'accepted',
                            reason: 'must-not-be-retained',
                            entries: [{ status: 'COMPLETED' }]
                        }
                    }
                },
                error: {
                    details: {
                        status: 'unexpected-runtime-status',
                        message: {
                            status: 'pending-admission',
                            reason: 'not-yet-in-sync',
                            entries: Array.from(
                                { length: 25 },
                                (_, index) => ({
                                    status: index === 0 ? 'RETRY' : 'sensitive-status'
                                })
                            )
                        }
                    }
                }
            }
        );

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
                    runtimeStatus: 'sent',
                    admissionStatus: 'no-route',
                    reason: 'other',
                    entryCount: 0,
                    entryStatuses: []
                },
                {
                    agentId: 'agent-a',
                    commandId: 'send-malformed-details',
                    ok: false,
                    runtimeStatus: null,
                    admissionStatus: null,
                    reason: null,
                    entryCount: 0,
                    entryStatuses: []
                },
                {
                    agentId: 'agent-a',
                    commandId: 'send-absent-details',
                    ok: false,
                    runtimeStatus: null,
                    admissionStatus: null,
                    reason: null,
                    entryCount: 0,
                    entryStatuses: []
                },
                {
                    agentId: 'agent-a',
                    commandId: 'send-contradictory',
                    ok: false,
                    runtimeStatus: 'other',
                    admissionStatus: 'pending-admission',
                    reason: 'not-yet-in-sync',
                    entryCount: 25,
                    entryStatuses: [
                        'RETRY',
                        ...Array.from({ length: 19 }, () => 'other')
                    ]
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
                participantAgents: [agent],
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
                participantAgents: [agent],
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
                captureSucceeded: true,
                commandOk: true,
                readyPeerIds: []
            }
        });
    });

    it('joins a bounded readiness causal tail to concurrent current health without retaining secrets', async () => {
        runAgentIds = [
            'retired-agent-a',
            'retired-agent-b',
            'agent-a',
            'agent-b',
            'agent-c',
            'agent-outside'
        ];
        const sentinel = 'SENTINEL-secret-payload';
        const entries: Array<{ agentId: string; topic: string; data: LiveRtcJsonRecord; }> = [];
        for (let index = 0; index < 210; index += 1) {
            entries.push({ agentId: 'agent-c', topic: 'rallar.browser.rtc.lifecycle', data: { kind: 'peer-created', peerId: 'session-b' } });
        }
        entries.push(
            { agentId: 'agent-a', topic: 'rallar.browser.ws.lifecycle', data: { kind: 'open' } },
            { agentId: 'agent-b', topic: 'rallar.browser.ws.lifecycle', data: { kind: 'open' } },
            { agentId: 'agent-a', topic: 'rallar.browser.rtc.lifecycle', data: { kind: 'peer-created', peerId: 'session-b' } },
            {
                agentId: 'agent-a',
                topic: 'rallar.browser.alm.outbound_diagnostics',
                data: { kind: 'commit-phases', typeId: 'rtc-signaling', msgId: 'signal-1', senderId: 'session-a', commitOutcome: 'committed' }
            },
            {
                agentId: 'agent-b',
                topic: 'rallar.browser.alm.inbound_diagnostics',
                data: { kind: 'admission-outcome', typeId: 'rtc-signaling', msgId: 'signal-1', outcome: 'committed', reason: sentinel }
            },
            { agentId: 'agent-a', topic: 'rallar.browser.ws.lifecycle', data: { kind: 'close', reason: sentinel } },
            { agentId: 'agent-a', topic: 'rallar.browser.rtc.lifecycle', data: { kind: 'peer-timeout', peerId: 'session-b' } },
            { agentId: 'agent-a', topic: 'rallar.browser.rtc.lifecycle', data: { kind: 'peer-deleted', peerId: 'session-b' } },
            { agentId: 'agent-a', topic: 'rallar.browser.ws.lifecycle', data: { kind: 'open' } },
            { agentId: 'agent-a', topic: 'rallar.browser.rtc.lifecycle', data: { kind: 'peer-created', peerId: 'session-b' } },
            { agentId: 'agent-a', topic: 'rallar.browser.rtc.lifecycle', data: { kind: 'peer-established', peerId: 'session-b' } },
            { agentId: 'agent-b', topic: 'rallar.browser.rtc.lifecycle', data: { kind: 'peer-created', peerId: 'session-a' } }
        );
        for (let index = 0; index < 230; index += 1) {
            entries.push({
                agentId: 'agent-a',
                topic: 'unrelated',
                data: { kind: 'open', payload: sentinel }
            });
        }
        entries.push(
            {
                agentId: 'agent-a',
                topic: 'rallar.browser.alm.outbound_diagnostics',
                data: { kind: 'commit-phases', typeId: 'application-message', msgId: 'app-1' }
            },
            {
                agentId: 'agent-b',
                topic: 'rallar.browser.alm.inbound_diagnostics',
                data: { kind: 'admission-outcome', typeId: 'application-message', msgId: 'app-1' }
            },
            { agentId: 'agent-outside', topic: 'rallar.browser.ws.lifecycle', data: { kind: 'open' } }
        );
        events = entries.map((entry, index) => ({
            kind: 'diagnostic',
            protocolVersion: 1,
            runId: 'run-causal',
            agentId: entry.agentId,
            atEpochMs: index,
            eventId: `event-${index}`,
            payload: {
                eventId: `event-${index}`,
                kind: 'diagnostic',
                topic: entry.topic,
                atEpochMs: index,
                severity: 'info',
                payload: {
                    diagnosticSchemaVersion: 1,
                    diagnosticTypeId: entry.topic,
                    topic: entry.topic,
                    severity: 'info',
                    message: entry.topic,
                    atEpochMs: index,
                    data: {
                        ...entry.data,
                        payload: sentinel,
                        credentials: sentinel,
                        url: 'https://secret.example.test'
                    }
                }
            }
        }));
        healthValues['agent-a'] = {
            rallar: {
                session: { sessionId: 'session-a', accessToken: sentinel },
                rtcStatus: { readyPeerIds: [], knownPeerIds: ['session-b'] },
                rtcCausalState: {
                    localSessionId: 'session-a',
                    desiredPeerIds: ['session-c', 'session-b', 'session-b'],
                    onlinePeerIds: ['session-c'],
                    connectablePeerIds: ['session-b'],
                    knownPeerIds: ['session-b'],
                    managerDiagnostics: { reconcileRunCount: 7, payload: sentinel },
                    attempts: [{ peerId: 'session-b', diagnostics: { peerId: 'session-b', attempts: 2, maxAttempts: 3, payload: sentinel } }, {
                        peerId: 'session-c',
                        diagnostics: null
                    }],
                    arbitrary: sentinel
                },
                rtcDiagnostics: {
                    sessionId: 'session-a',
                    generatedAtEpochMs: 10,
                    peers: []
                },
                error: sentinel,
                url: 'https://secret.example.test'
            }
        };
        healthValues['agent-b'] = {
            rallar: {
                rtcDiagnostics: {
                    sessionId: 'session-b',
                    generatedAtEpochMs: 11,
                    peers: [{ peerId: 'session-a', connection: { state: 'Connecting' }, lanes: [] }]
                }
            }
        };
        healthValues['agent-c'] = {
            rallar: {
                rtcDiagnostics: {
                    sessionId: 'session-c',
                    generatedAtEpochMs: 12,
                    peers: [{ peerId: 'session-a', connection: { state: 'Connecting' }, lanes: [] }]
                }
            }
        };
        healthValues['retired-agent-a'] = { rallar: { session: { sessionId: 'retired-session-a' } } };
        healthValues['retired-agent-b'] = { rallar: { session: { sessionId: 'retired-session-b' } } };
        const allHealthStarted = Promise.withResolvers<void>();
        const releaseHealth = Promise.withResolvers<void>();
        const healthAgents: string[] = [];
        holdHealthCommand = async (agentId) => {
            healthAgents.push(agentId);
            if (healthAgents.length === 3) {
                allHealthStarted.resolve();
            }
            await releaseHealth.promise;
        };
        const failure = new Error(sentinel);
        refreshRoom.mockRejectedValue(failure);
        const readiness = control.waitForPeerReadiness({
            runId: 'run-causal',
            agent,
            participantAgents: [
                agent,
                { agentId: 'agent-b' },
                { agentId: 'agent-c' }
            ],
            expectedPeerIds: ['session-c', 'session-b'],
            suffix: 'causal',
            startedAtMs: 100
        });
        const rejection = expect(readiness).rejects.toThrow(sentinel);
        try {
            await Promise.race([allHealthStarted.promise, new Promise<void>((resolve) => setTimeout(resolve, 200))]);
            expect(healthAgents.sort()).toEqual(['agent-a', 'agent-b', 'agent-c']);
        }
        finally {
            releaseHealth.resolve();
            await rejection;
        }
        const serialized = readFileSync(path.join(diagnosticsRoot, 'live-rtc-readiness-failure-agent-a-causal.json'), 'utf8');
        const sidecar = JSON.parse(serialized);
        expect(readinessHealthAgents.sort()).toEqual(['agent-a', 'agent-b', 'agent-c']);
        expect(serialized).not.toMatch(
            /SENTINEL|secret\.example|accessToken|credentials|payload|application-message|app-1|agent-outside|retired/u
        );
        expect(sidecar.failure).toEqual({ name: 'readiness-failed', message: 'RTC peer readiness observation failed.' });
        expect(sidecar.causalEvents).toHaveLength(200);
        expect(sidecar.causalEvents[0]).toMatchObject({ atEpochMs: 22 });
        expect(
            sidecar.causalEvents.slice(-12).map((
                event: { agentId: string; kind: string; wsGeneration: number | null; peerLifetime?: number; }
            ) => [event.agentId, event.kind, event.wsGeneration, event.peerLifetime ?? null])
        ).toEqual([
            ['agent-a', 'open', 1, null],
            ['agent-b', 'open', 1, null],
            ['agent-a', 'peer-created', 1, 1],
            ['agent-a', 'commit-phases', 1, null],
            ['agent-b', 'admission-outcome', 1, null],
            ['agent-a', 'close', 1, null],
            ['agent-a', 'peer-timeout', 1, 1],
            ['agent-a', 'peer-deleted', 1, 1],
            ['agent-a', 'open', 2, null],
            ['agent-a', 'peer-created', 2, 2],
            ['agent-a', 'peer-established', 2, 2],
            ['agent-b', 'peer-created', 1, 1]
        ]);
        expect(sidecar.healthByAgentId['agent-b'].rtcDiagnostics.peers).toMatchObject([
            { peerId: 'session-a' }
        ]);
        expect(sidecar.healthByAgentId['agent-c'].rtcDiagnostics.peers).toMatchObject([
            { peerId: 'session-a' }
        ]);
        expect(sidecar.causalEvents.filter((event: { msgId?: string; }) => event.msgId === 'signal-1')).toMatchObject([
            { agentId: 'agent-a', commitOutcome: 'committed' },
            { agentId: 'agent-b', outcome: 'committed' }
        ]);
        expect(sidecar.healthByAgentId['agent-a']).toMatchObject({
            localSessionId: 'session-a',
            rtcCausalState: {
                desiredPeerIds: ['session-b', 'session-c'],
                managerDiagnostics: { reconcileRunCount: 7 },
                attempts: [{ peerId: 'session-b', diagnostics: { attempts: 2 } }, { peerId: 'session-c', diagnostics: null }]
            }
        });
    });

    it.each([
        {
            failedAgentId: `credential=SENTINEL-failed-${'x'.repeat(10_000)}`,
            discoveredAgentIds: [`credential=SENTINEL-discovered-${'y'.repeat(10_000)}`, 'causal-agent-1'],
            references: ['@causal-agent-1', '@causal-agent-2', 'causal-agent-1']
        },
        {
            failedAgentId: 'causal-agent-1',
            discoveredAgentIds: ['@causal-agent-1', 'credential=SENTINEL-discovered'],
            references: ['causal-agent-1', '@causal-agent-2', '@causal-agent-3']
        }
    ])('retains distinct bounded agent references for hostile metadata, case %#', async ({ failedAgentId, discoveredAgentIds, references }) => {
        const selectedAgentIds = [failedAgentId, ...discoveredAgentIds];
        runAgentIds = [...discoveredAgentIds, 'agent-outside'];
        events = [...selectedAgentIds, 'agent-outside'].map((agentId, index) => ({
            kind: 'diagnostic',
            protocolVersion: 1,
            runId: 'run-hostile-agents',
            agentId,
            atEpochMs: index,
            eventId: `event-${index}`,
            payload: {
                eventId: `event-${index}`,
                kind: 'diagnostic',
                topic: 'rallar.browser.ws.lifecycle',
                atEpochMs: index,
                severity: 'info',
                payload: {
                    diagnosticSchemaVersion: 1,
                    diagnosticTypeId: 'rallar.browser.ws.lifecycle',
                    topic: 'rallar.browser.ws.lifecycle',
                    severity: 'info',
                    message: 'rallar.browser.ws.lifecycle',
                    atEpochMs: index,
                    data: { kind: 'open' }
                }
            }
        }));
        selectedAgentIds.forEach((agentId, index) => {
            healthValues[agentId] = { rallar: { session: { sessionId: `session-${index}` } } };
        });
        const allHealthStarted = Promise.withResolvers<void>();
        const releaseHealth = Promise.withResolvers<void>();
        holdHealthCommand = async () => {
            if (readinessHealthAgents.length === 3) {
                allHealthStarted.resolve();
            }
            await releaseHealth.promise;
        };
        const failure = new Error('SENTINEL-readiness-error');
        refreshRoom.mockRejectedValue(failure);
        const readiness = control.waitForPeerReadiness({
            runId: 'run-hostile-agents',
            agent: { ...agent, agentId: failedAgentId },
            participantAgents: selectedAgentIds.map((agentId) => ({ agentId })),
            expectedPeerIds: ['session-b'],
            suffix: 'hostile',
            startedAtMs: 100
        });
        const rejection = expect(readiness).rejects.toBe(failure);
        try {
            await Promise.race([allHealthStarted.promise, new Promise<void>((resolve) => setTimeout(resolve, 200))]);
            expect(readinessHealthAgents).toHaveLength(3);
            expect(new Set(readinessHealthAgents)).toEqual(new Set(selectedAgentIds));
        }
        finally {
            releaseHealth.resolve();
            await rejection;
        }
        const artifactFiles = readdirSync(diagnosticsRoot);
        expect(artifactFiles).toHaveLength(1);
        expect(artifactFiles[0]?.length).toBeLessThan(200);
        expect(artifactFiles.join()).not.toMatch(/SENTINEL|credential/);
        const serialized = readFileSync(path.join(diagnosticsRoot, artifactFiles[0]!), 'utf8');
        const sidecar = JSON.parse(serialized);
        expect(serialized.length).toBeLessThan(10_000);
        expect(serialized).not.toMatch(/SENTINEL|credential|agent-outside/);
        expect(sidecar.agentId).toBe(references[0]);
        expect(Object.keys(sidecar.healthByAgentId)).toEqual(references);
        expect(Object.values(sidecar.healthByAgentId)).toMatchObject([
            { captureSucceeded: true, localSessionId: 'session-0' },
            { captureSucceeded: true, localSessionId: 'session-1' },
            { captureSucceeded: true, localSessionId: 'session-2' }
        ]);
        expect(sidecar.health).toEqual(sidecar.healthByAgentId[references[0]!]);
        expect(sidecar.causalEvents.map((event: { agentId: string; }) => event.agentId)).toEqual(references);
        expect(readinessHealthAgents).toHaveLength(3);
    });

    it('names the sidecar by harness slot for a maximum-length punctuation identity', async () => {
        const punctuationAgentId = ':'.repeat(128);
        runAgentIds = [];
        healthValues[punctuationAgentId] = { rallar: { session: { sessionId: 'session-c' } } };
        const failure = new Error('SENTINEL-readiness-error');
        refreshRoom.mockRejectedValue(failure);
        await expect(control.waitForPeerReadiness({
            runId: 'run-punctuation',
            agent: { ...agent, prefix: 'C', agentId: punctuationAgentId },
            participantAgents: [{ agentId: punctuationAgentId }],
            expectedPeerIds: ['session-b'],
            suffix: 'punctuation',
            startedAtMs: 100
        })).rejects.toBe(failure);

        const fileName = 'live-rtc-readiness-failure-agent-c-punctuation.json';
        expect(readdirSync(diagnosticsRoot)).toEqual([fileName]);
        const serialized = readFileSync(path.join(diagnosticsRoot, fileName), 'utf8');
        expect(serialized).not.toContain('SENTINEL');
        expect(JSON.parse(serialized)).toMatchObject({
            agentId: punctuationAgentId,
            health: { captureSucceeded: true, localSessionId: 'session-c' }
        });
    });

    it('keeps separate same-suffix sidecars for hostile identities in different harness slots', async () => {
        runAgentIds = [];
        const captures = [
            { prefix: 'A' as const, agentId: 'credential=SENTINEL-first', sessionId: 'session-a' },
            { prefix: 'B' as const, agentId: 'credential=SENTINEL-second', sessionId: 'session-b' }
        ];
        const failure = new Error('SENTINEL-readiness-error');
        refreshRoom.mockRejectedValue(failure);
        for (const capture of captures) {
            healthValues[capture.agentId] = { rallar: { session: { sessionId: capture.sessionId } } };
            await expect(control.waitForPeerReadiness({
                runId: 'run-shared-suffix',
                agent: { ...agent, prefix: capture.prefix, agentId: capture.agentId },
                participantAgents: [{ agentId: capture.agentId }],
                expectedPeerIds: ['session-c'],
                suffix: 'shared',
                startedAtMs: 100
            })).rejects.toBe(failure);
        }

        const fileNames = readdirSync(diagnosticsRoot).sort();
        expect(fileNames).toEqual([
            'live-rtc-readiness-failure-agent-a-shared.json',
            'live-rtc-readiness-failure-agent-b-shared.json'
        ]);
        const sidecars = fileNames.map((fileName) => {
            expect(fileName.length).toBeLessThan(100);
            expect(fileName).not.toMatch(/SENTINEL|credential/);
            const serialized = readFileSync(path.join(diagnosticsRoot, fileName), 'utf8');
            expect(serialized).not.toMatch(/SENTINEL|credential/);
            return JSON.parse(serialized);
        });
        expect(sidecars).toMatchObject([
            { agentId: '@causal-agent-1', health: { captureSucceeded: true, localSessionId: 'session-a' } },
            { agentId: '@causal-agent-1', health: { captureSucceeded: true, localSessionId: 'session-b' } }
        ]);
    });

    it('retains only a fixed category when readiness health capture fails', async () => {
        healthCommandFailure = { agentId: 'agent-a', body: 'SENTINEL-health-response' };
        refreshRoom.mockRejectedValue(new Error('SENTINEL-readiness-error'));
        await expect(control.waitForPeerReadiness({
            runId: 'run-health',
            agent,
            participantAgents: [agent],
            expectedPeerIds: ['session-b'],
            suffix: 'health',
            startedAtMs: 100
        })).rejects
            .toThrow('SENTINEL-readiness-error');
        const serialized = readFileSync(path.join(diagnosticsRoot, 'live-rtc-readiness-failure-agent-a-health.json'), 'utf8');
        expect(serialized).not.toContain('SENTINEL');
        expect(JSON.parse(serialized).health).toMatchObject({ captureSucceeded: false, failure: 'health-capture-failed' });
        expect(readinessHealthAgents).toEqual(['agent-a']);
    });

    it('uses collision-free bounded command identities for concurrent readiness health', async () => {
        runAgentIds = ['agent-a'];
        healthValues['agent:a'] = {
            rallar: { session: { sessionId: 'session-colon' } }
        };
        healthValues['agent-a'] = {
            rallar: { session: { sessionId: 'session-hyphen' } }
        };
        const failure = new Error('readiness failed');
        refreshRoom.mockRejectedValue(failure);

        await expect(
            control.waitForPeerReadiness({
                runId: 'run-readiness-command-collision',
                agent: { ...agent, agentId: 'agent:a' },
                participantAgents: [{ agentId: 'agent:a' }, { agentId: 'agent-a' }],
                expectedPeerIds: ['session-hyphen'],
                suffix: 'command-collision',
                startedAtMs: 100
            })
        ).rejects.toBe(failure);

        const sidecar = JSON.parse(
            readFileSync(
                path.join(
                    diagnosticsRoot,
                    'live-rtc-readiness-failure-agent-a-command-collision.json'
                ),
                'utf8'
            )
        );
        expect(sidecar.healthByAgentId).toMatchObject({
            'agent:a': { localSessionId: 'session-colon' },
            'agent-a': { localSessionId: 'session-hyphen' }
        });
        expect(failureHealthCommandIds).toHaveLength(2);
        expect(new Set(failureHealthCommandIds).size).toBe(2);
        expect(failureHealthCommandIds.join('\n')).not.toMatch(/agent:a|agent-a/u);
    });

    it('retains sender and receiver health when message delivery times out', async () => {
        results.push({
            agentId: 'agent-a',
            commandId: 'send-direct-timeout',
            ok: true,
            result: {
                value: {
                    status: 'sent',
                    message: {
                        status: 'pending-admission',
                        reason: 'awaiting a durable admission retry',
                        message: {
                            id: { msgId: 'message-direct-timeout' },
                            payload: { resource: 'must-not-be-retained' }
                        },
                        entries: [{ status: 'NEW', resource: 'must-not-be-retained' }]
                    },
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
            runtimeStatus: 'sent',
            admissionStatus: 'pending-admission',
            reason: 'other',
            messageIdPresent: true,
            entryCount: 1,
            entryStatuses: ['NEW']
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
            ok: false,
            result: {
                value: {
                    status: 'must-not-be-retained',
                    message: {
                        status: 'accepted',
                        reason: 'must-not-be-retained',
                        entries: [{ status: 'COMPLETED' }]
                    }
                }
            },
            error: {
                code: 'RALLAR_BB_RTC_NO_ROUTE',
                message: 'must-not-be-retained',
                details: {
                    status: 'sent',
                    message: {
                        status: 'no-route',
                        reason: 'Skipping RTC outbound message without overlay context',
                        message: {
                            id: { msgId: 'message-direct-timeout' },
                            payload: { resource: 'must-not-be-retained' }
                        },
                        entries: []
                    },
                    credential: 'must-not-be-retained'
                }
            }
        });
        const controlWithoutDiagnosticsDirectory = new LiveRtcControlClient({
            request: api,
            baseUrl,
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
                        ok: false,
                        runtimeStatus: 'sent',
                        admissionStatus: 'no-route',
                        reason: 'other',
                        messageIdPresent: true,
                        entryCount: 0,
                        entryStatuses: []
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
            baseUrl,
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

    it('uses collision-free bounded command identities for concurrent message-failure health', async () => {
        healthValues['agent:a'] = rtcHealthValue('session-colon', 1);
        healthValues['agent-a'] = rtcHealthValue('session-hyphen', 2);
        const controlWithoutDiagnosticsDirectory = new LiveRtcControlClient({
            request: api,
            baseUrl,
            monotonicNow: () => nowMs,
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
        expect(failureHealthCommandIds).toHaveLength(2);
        expect(new Set(failureHealthCommandIds).size).toBe(2);
        expect(failureHealthCommandIds.join('\n')).not.toMatch(/agent:a|agent-a/u);
    });

    it('separates colliding receiver identities across retained message-failure captures', async () => {
        healthValues['sender'] = rtcHealthValue('session-sender', 1);
        healthValues['agent:a'] = rtcHealthValue('session-colon', 2);
        healthValues['agent-a'] = rtcHealthValue('session-hyphen', 3);
        const controlWithoutDiagnosticsDirectory = new LiveRtcControlClient({
            request: api,
            baseUrl,
            monotonicNow: () => nowMs,
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
        expect(failureHealthCommandIds).toHaveLength(4);
        expect(new Set(failureHealthCommandIds).size).toBe(4);
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
            baseUrl,
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

    it('reads the sent message identity from the RTC send-result envelope, not the command ID', () => {
        expect(
            control.requireSentMessageId({
                commandId: 'nack-probe-command',
                ok: true,
                result: {
                    value: {
                        message: {
                            transport: 'rtc',
                            status: 'sent',
                            message: { id: { msgId: 'wire-message' } }
                        }
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
                    status: 'sent',
                    message: {
                        status: 'pending-admission',
                        reason: 'credential=must-not-be-retained',
                        message: {
                            id: { msgId: 'probe-message' },
                            payload: { resource: 'must-not-be-retained' }
                        },
                        entries: Array.from({ length: 25 }, () => ({ status: 'NEW' }))
                    },
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
                runtimeStatus: 'sent',
                admissionStatus: 'pending-admission',
                reason: 'other',
                messageIdPresent: true,
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
        expect(diagnostic.sendResult?.entryCount).toBe(25);
        expect(diagnostic.sendResult?.entryStatuses).toHaveLength(20);
        expect(diagnostic.recentResults).toContainEqual({
            agentRole: 'sender',
            commandRole: 'probe',
            ok: true
        });
    });

    it('uses collision-free bounded command identities for concurrent NACK health', async () => {
        healthValues['agent:a'] = rtcHealthValue('session-colon', 1);
        healthValues['agent-a'] = rtcHealthValue('session-hyphen', 2);

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
        expect(failureHealthCommandIds).toHaveLength(2);
        expect(new Set(failureHealthCommandIds).size).toBe(2);
        expect(failureHealthCommandIds.join('\n')).not.toMatch(/agent:a|agent-a/u);
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
