import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import type { LiveRtcJsonRecord } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';
import {
    createLiveRtcControlClientTestFixture,
    type LiveRtcControlClientTestFixture,
    type LiveRtcControlClientTestState
} from './live-rtc-control-client-test-fixture.ts';

describe('live RTC control client readiness evidence', () => {
    let fixture: LiveRtcControlClientTestFixture;
    let state: LiveRtcControlClientTestState;
    let control: LiveRtcControlClient;
    let diagnosticsRoot: string;
    let refreshRoom: typeof fixture.refreshRoom;
    let agent: typeof fixture.agent;

    beforeEach(async () => {
        fixture = await createLiveRtcControlClientTestFixture();
        ({ state, control, diagnosticsRoot, refreshRoom, agent } = fixture);
    });

    afterEach(async () => await fixture.close());

    it('waits for refreshed room membership and includes refresh time in readiness', async () => {
        const refresh = Promise.withResolvers<void>();
        let roomMembers = ['session-a'];
        let refreshStarted = false;
        let completed = false;
        refreshRoom.mockImplementation(async () => {
            refreshStarted = true;
            await refresh.promise;
            roomMembers = ['session-a', 'session-b', 'session-c'];
            state.nowMs = 350;
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
            state.nowMs += 100;
            state.readyPeerIds = refreshCount === 1 ? ['session-b'] : ['session-b', 'session-c'];
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
        state.readyPeerIds = [];
        refreshRoom.mockImplementation(async () => {
            state.nowMs = 60_101;
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

    it('retains sanitized signaling evidence per browser and preserves readiness failure when a reader fails', async () => {
        const failure = new Error('original readiness failure');
        refreshRoom.mockRejectedValue(failure);
        const browserAgent = {
            ...agent,
            readSignalingObservation: async () => ({
                available: true,
                droppedReceived: 0,
                droppedAttempts: 0,
                droppedSocketLifetimes: 0,
                socketLifetimes: [{
                    socketInstanceOrdinal: 1,
                    endpointOrigin: 'ws://api.test',
                    createdAtEpochMs: 1,
                    openedAtEpochMs: 2,
                    closedAtEpochMs: 40,
                    url: 'secret-socket-url'
                }],
                droppedNativeLifetimes: 0,
                nativeLifetimes: [{
                    nativeInstanceOrdinal: 2,
                    createdAtEpochMs: 5,
                    creationState: { signalingState: 'stable', connectionState: 'new', iceConnectionState: 'new' },
                    closedAtEpochMs: 40,
                    closeState: { signalingState: 'closed', connectionState: 'closed', iceConnectionState: 'closed' },
                    observation: 'live' as const,
                    observedAtEpochMs: 50,
                    state: { signalingState: 'closed', connectionState: 'closed', iceConnectionState: 'closed', token: 'secret-token' },
                    reference: 'secret-native-reference'
                }],
                received: [{
                    msgId: 'signal-1',
                    socketInstanceOrdinal: 1,
                    signalType: 'Offer' as const,
                    hasCandidate: false,
                    offerId: 'offer-1',
                    fromId: 'session-a',
                    toId: 'session-b',
                    receivedAtEpochMs: 10,
                    sdp: 'secret-sdp',
                    token: 'secret-token',
                    fingerprint: 'secret-fingerprint'
                }],
                attempts: [{
                    msgId: 'signal-1',
                    socketInstanceOrdinal: 1,
                    nativeInstanceOrdinal: 2,
                    match: 'unique' as const,
                    signalType: 'Offer' as const,
                    offerId: 'offer-1',
                    fromId: 'session-a',
                    toId: 'session-b',
                    receivedAtEpochMs: 10,
                    attemptedAtEpochMs: 20,
                    settledAtEpochMs: 30,
                    settlement: 'applied' as const,
                    state: { signalingState: 'stable', connectionState: 'new', iceConnectionState: 'new', token: 'secret-token' },
                    description: 'secret-sdp'
                }],
                frames: ['secret-frame']
            })
        };
        await expect(control.waitForPeerReadiness({
            runId: 'run-signaling',
            agent: browserAgent,
            participantAgents: [browserAgent, {
                agentId: 'agent-b',
                readSignalingObservation: async () => {
                    throw new Error('secret-token');
                }
            }, { agentId: 'agent-c' }],
            expectedPeerIds: ['session-b'],
            suffix: 'signaling',
            startedAtMs: 100
        })).rejects.toBe(failure);

        const serialized = readFileSync(path.join(diagnosticsRoot, 'live-rtc-readiness-failure-agent-a-signaling.json'), 'utf8');
        expect(JSON.parse(serialized).signalingByAgentId).toMatchObject({
            'agent-a': {
                available: true,
                received: [{ msgId: 'signal-1', signalType: 'Offer' }],
                attempts: [{ nativeInstanceOrdinal: 2, settlement: 'applied' }],
                socketLifetimes: [{ socketInstanceOrdinal: 1, endpointOrigin: 'ws://api.test', closedAtEpochMs: 40 }],
                nativeLifetimes: [{ nativeInstanceOrdinal: 2, closedAtEpochMs: 40, observation: 'live', state: { connectionState: 'closed' } }]
            },
            'agent-b': { available: false, received: [], attempts: [] },
            'agent-c': { available: false, received: [], attempts: [] }
        });
        expect(serialized).not.toMatch(/secret-|fingerprint|description|frames/);
    });

    it('joins a bounded readiness causal tail to concurrent current health without retaining secrets', async () => {
        state.runAgentIds = [
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
        state.events = entries.map((entry, index) => ({
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
        state.healthValues['agent-a'] = {
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
        state.healthValues['agent-b'] = {
            rallar: {
                rtcDiagnostics: {
                    sessionId: 'session-b',
                    generatedAtEpochMs: 11,
                    peers: [{ peerId: 'session-a', connection: { state: 'Connecting' }, lanes: [] }]
                }
            }
        };
        state.healthValues['agent-c'] = {
            rallar: {
                rtcDiagnostics: {
                    sessionId: 'session-c',
                    generatedAtEpochMs: 12,
                    peers: [{ peerId: 'session-a', connection: { state: 'Connecting' }, lanes: [] }]
                }
            }
        };
        state.healthValues['retired-agent-a'] = { rallar: { session: { sessionId: 'retired-session-a' } } };
        state.healthValues['retired-agent-b'] = { rallar: { session: { sessionId: 'retired-session-b' } } };
        const allHealthStarted = Promise.withResolvers<void>();
        const releaseHealth = Promise.withResolvers<void>();
        const healthAgents: string[] = [];
        state.holdHealthCommand = async (agentId) => {
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
        expect(state.readinessHealthAgents.sort()).toEqual(['agent-a', 'agent-b', 'agent-c']);
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
        state.runAgentIds = [...discoveredAgentIds, 'agent-outside'];
        state.events = [...selectedAgentIds, 'agent-outside'].map((agentId, index) => ({
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
            state.healthValues[agentId] = { rallar: { session: { sessionId: `session-${index}` } } };
        });
        const allHealthStarted = Promise.withResolvers<void>();
        const releaseHealth = Promise.withResolvers<void>();
        state.holdHealthCommand = async () => {
            if (state.readinessHealthAgents.length === 3) {
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
            expect(state.readinessHealthAgents).toHaveLength(3);
            expect(new Set(state.readinessHealthAgents)).toEqual(new Set(selectedAgentIds));
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
        expect(state.readinessHealthAgents).toHaveLength(3);
    });

    it('names the sidecar by harness slot for a maximum-length punctuation identity', async () => {
        const punctuationAgentId = ':'.repeat(128);
        state.runAgentIds = [];
        state.healthValues[punctuationAgentId] = { rallar: { session: { sessionId: 'session-c' } } };
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
        state.runAgentIds = [];
        const captures = [
            { prefix: 'A' as const, agentId: 'credential=SENTINEL-first', sessionId: 'session-a' },
            { prefix: 'B' as const, agentId: 'credential=SENTINEL-second', sessionId: 'session-b' }
        ];
        const failure = new Error('SENTINEL-readiness-error');
        refreshRoom.mockRejectedValue(failure);
        for (const capture of captures) {
            state.healthValues[capture.agentId] = { rallar: { session: { sessionId: capture.sessionId } } };
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
        state.healthCommandFailure = { agentId: 'agent-a', body: 'SENTINEL-health-response' };
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
        expect(state.readinessHealthAgents).toEqual(['agent-a']);
    });

    it('uses collision-free bounded command identities for concurrent readiness health', async () => {
        state.runAgentIds = ['agent-a'];
        state.healthValues['agent:a'] = {
            rallar: { session: { sessionId: 'session-colon' } }
        };
        state.healthValues['agent-a'] = {
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
        expect(state.failureHealthCommandIds).toHaveLength(2);
        expect(new Set(state.failureHealthCommandIds).size).toBe(2);
        expect(state.failureHealthCommandIds.join('\n')).not.toMatch(/agent:a|agent-a/u);
    });
});
