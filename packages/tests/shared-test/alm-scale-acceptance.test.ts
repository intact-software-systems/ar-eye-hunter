import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RallarRoomTransportStatus } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { ALCongestionCounters } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import type { RallarBlackBoxBrowserTestRuntime } from '../../shared-test/rallar-bb-test/browser/browser-command-contracts.ts';
import { isRallarBlackBoxTestResult } from '../../shared-test/rallar-bb-test/composite-results.ts';
import { createAlmScaleRecipes } from '../../shared-test/rallar-bb-test/conformance/alm/scale/create-alm-scale-recipes.ts';
import { createRallarBlackBoxBrowserTestRuntime } from '../../shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import type { RallarBlackBoxDistributedRunManifest } from '../../shared-test/rallar-bb-test/distributed-run.ts';
import { computeDistributedGroupAssertionResults } from '../../shared-test/rallar-bb-test/distributed/group-assertions-evaluation.ts';
import type { DistributedGroupAssertionRecipeEvidence } from '../../shared-test/rallar-bb-test/distributed/group-assertions-evidence.ts';
import type {
    RallarBlackBoxTestAlmUsage,
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestResult
} from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { createBrowserRallarRequiredMethodsTestDouble } from './browser-rallar-required-methods-test-double.ts';

interface SamplerExecution {
    readonly result: RallarBlackBoxTestResult;
    readonly final: RallarBlackBoxTestResult;
    readonly runtime: RallarBlackBoxBrowserTestRuntime;
    readonly elapsedMs: number;
}

const GROUP = { applicationId: 'scale-app', workspaceId: 'scale-workspace', groupId: 'scale-room' };
const HEALTHY: RallarBlackBoxTestAlmUsage = {
    own: { admissions: 6, bytes: 3_000 },
    inbound: { admissions: 84, bytes: 42_000 },
    usage: { admissions: 90, bytes: 45_000, oldestAgeMs: 25_000, tracks: 1 },
    limits: { maxAdmissions: 1_000, maxBytes: 4_194_304, maxAgeMs: 300_000, maxTracks: 64 },
    overloaded: false,
    orderingTracks: 85
};
const EMPTY: RallarBlackBoxTestAlmUsage = {
    ...HEALTHY,
    own: { admissions: 0, bytes: 0 },
    inbound: { admissions: 0, bytes: 0 },
    usage: { admissions: 0, bytes: 0, oldestAgeMs: 0, tracks: 0 },
    orderingTracks: 0
};
const READY_ROOM: RallarRoomTransportStatus = {
    ws: {
        connectState: 'connected',
        readyState: 'open',
        isOpen: true,
        reconnecting: false,
        reconnectEnabled: true,
        reconnectAttempts: 0,
        maxReconnectAttempts: 5,
        reconnectExhausted: false
    },
    rtc: {
        desired: true,
        mode: 'eager',
        state: 'open',
        laneId: 'scale-lane',
        peers: [],
        failedPeerIds: [],
        desiredPeerIds: ['director-session'],
        knownPeerIds: ['director-session'],
        activePeerIds: ['director-session'],
        readyPeerIds: ['director-session'],
        acceptedLayoutIdentity: { groupRevision: 1, presenceRevision: 1, version: 1, state: 'active' }
    }
};

function getSampler(role: 'director' | 'player'): RallarBlackBoxTestCommand {
    const scale = createAlmScaleRecipes({ participantCount: 15, group: GROUP, readyTimeoutMs: 45_000 });
    const traffic = scale.recipes[role === 'director' ? 0 : 1].commands.find((command) => command.kind === 'parallel');
    if (traffic?.kind !== 'parallel') {
        throw new Error('Missing scale traffic');
    }
    return traffic.groups[1].commands[0];
}

async function runSampler(
    role: 'director' | 'player',
    readings: readonly (RallarBlackBoxTestAlmUsage | undefined)[],
    congestion: ALCongestionCounters | undefined
): Promise<SamplerExecution> {
    let index = 0;
    let now = 1_000;
    const runtime = createRallarBlackBoxBrowserTestRuntime({
        now: () => now,
        sleep: async (ms) => {
            now += ms;
        },
        rallarRuntime: {
            ...createBrowserRallarRequiredMethodsTestDouble(),
            connect: async () => ({ connected: true }),
            send: async () => ({ sent: true }),
            refreshRoom: async () => undefined,
            close: async () => ({ closed: true }),
            health: async () => ({ connected: true }),
            readAlmUsage: async () => readings[Math.min(index++, readings.length - 1)],
            readCongestionCounters: async () => congestion
        }
    });
    const result = await runtime.execute(getSampler(role));
    const final = await runtime.execute({ kind: 'stats', commandId: `alm-scale-${role}-final-stats` });
    return { result, final, runtime, elapsedMs: now - 1_000 };
}

describe('ALM scale sampled acceptance', () => {
    it.each(['director', 'player'] as const)('checks seven readings across 30 seconds on the %s page', async (role) => {
        const { result, elapsedMs } = await runSampler(role, [HEALTHY], { dropped: 0, deferred: 2, handedOver: 1 });
        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({ iterations: 7, failed: 0, cancelled: false, pacing: { completedIterations: 7, requestedIntervalMs: 5_000 } });
        expect(elapsedMs).toBe(30_000);
    });

    it.each(['director', 'player'] as const)('keeps a transient excess failed even after a zero final reading on %s', async (role) => {
        const { result, final } = await runSampler(role, [HEALTHY, { ...HEALTHY, own: { admissions: 1_001, bytes: 3_000 } }, EMPTY], {
            dropped: 0,
            deferred: 0,
            handedOver: 0
        });
        expect(final.value).toMatchObject({ rallar: { alm: { own: { admissions: 0 } } } });
        expect(result.ok).toBe(false);
        expect(result.value).toMatchObject({ failed: 1, cancelled: false });
    });

    it.each([
        { name: 'missing ledger', reading: undefined, congestion: { dropped: 0, deferred: 0, handedOver: 0 } },
        { name: 'missing congestion', reading: HEALTHY, congestion: undefined },
        { name: 'own byte excess', reading: { ...HEALTHY, own: { admissions: 6, bytes: 4_194_305 } }, congestion: { dropped: 0, deferred: 0, handedOver: 0 } },
        {
            name: 'oldest counted age excess',
            reading: { ...HEALTHY, usage: { ...HEALTHY.usage, oldestAgeMs: 300_001 } },
            congestion: { dropped: 0, deferred: 0, handedOver: 0 }
        },
        {
            name: 'own ordering track excess',
            reading: { ...HEALTHY, usage: { ...HEALTHY.usage, tracks: 65 } },
            congestion: { dropped: 0, deferred: 0, handedOver: 0 }
        },
        { name: 'ordering snapshot excess', reading: { ...HEALTHY, orderingTracks: 513 }, congestion: { dropped: 0, deferred: 0, handedOver: 0 } },
        { name: 'overload', reading: { ...HEALTHY, overloaded: true }, congestion: { dropped: 0, deferred: 0, handedOver: 0 } },
        {
            name: 'relaxed runtime limit',
            reading: { ...HEALTHY, limits: { ...HEALTHY.limits, maxTracks: 128 } },
            congestion: { dropped: 0, deferred: 0, handedOver: 0 }
        },
        { name: 'congestion drop', reading: HEALTHY, congestion: { dropped: 1, deferred: 0, handedOver: 0 } }
    ])('fails closed on $name', async ({ reading, congestion }) => {
        const { result } = await runSampler('player', [reading], congestion);
        expect(result.ok).toBe(false);
    });
});

describe('ALM scale player wire execution', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it.each(['director-session', 'wrong-session'])('joins six scoped shot receipts to the appointed director: %s', async (recipientSessionId) => {
        vi.stubGlobal('localStorage', {
            getItem: () =>
                JSON.stringify({
                    clientId: 'player-client',
                    username: 'Player',
                    sessionId: 'player-session',
                    accessToken: 'test-token',
                    expiresAtEpochMs: Date.now() + 60_000
                })
        });
        const sent: RallarBlackBoxTestCommand['metadata'][] = [];
        let now = 1_000;
        const receipt = (handleId: string) => ({
            handleId,
            state: 'acknowledged',
            submitted: true,
            enqueued: false,
            receiptMode: 'leader',
            confirmedHopPeerIds: [],
            unconfirmedHopPeerIds: [],
            expectedRecipientPeerIds: [recipientSessionId],
            confirmedRecipientPeerIds: [recipientSessionId],
            unconfirmedRecipientPeerIds: [],
            attempts: 1,
            attemptOutcomes: [],
            attemptCarriers: [],
            attemptRefusalReasons: []
        });
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            now: () => now,
            sleep: async (ms) => {
                now += ms;
            },
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: async () => ({ sessionId: 'player-session', connected: true }),
                waitForRoom: async () => READY_ROOM,
                send: async () => ({ sent: true }),
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true, readyPeerIds: ['director-session'] }),
                readAlmUsage: async () => HEALTHY,
                readCongestionCounters: async () => ({ dropped: 0, deferred: 0, handedOver: 0 }),
                sendMessage: async (command) => {
                    sent.push(command);
                    return { handleId: command.handleId, carrier: command.carrier, status: 'acknowledged' };
                },
                observeDelivery: async (command) => receipt(String(command.handleId)),
                readReceipts: async (command) => receipt(String(command.handleId)),
                director: {
                    status: async () => ({ directorStatus: { active: true, appointment: { sessionId: 'director-session' } } }),
                    appoint: async () => ({}),
                    resign: async () => ({}),
                    relayStart: async () => ({}),
                    intent: async () => ({}),
                    syncRequest: async () => ({}),
                    relayStop: async () => ({})
                }
            }
        });
        const recipe = createAlmScaleRecipes({ participantCount: 15, group: GROUP, readyTimeoutMs: 45_000 }).recipes[1];
        const connect = recipe.commands.find((command) => command.kind === 'rtc.connect')!;
        const connected = await runtime.execute(connect);
        expect(connected.error).toBeUndefined();
        if (!isJsonRecordValue(connected.value) || typeof connected.value.sessionId !== 'string') {
            throw new Error('Connect did not report its page session');
        }
        const connectedSessionId = connected.value.sessionId;
        await runtime.execute({ kind: 'director.status', commandId: 'alm-scale-player-ready-status', roomRef: GROUP, refresh: true });
        const traffic = recipe.commands.find((command) => command.kind === 'parallel');
        if (traffic?.kind !== 'parallel') {
            throw new Error('Missing player traffic');
        }
        const result = await runtime.execute({
            ...traffic,
            groups: [{ ...traffic.groups[0], commands: [{ kind: 'health', commandId: 'connected-health' }, traffic.groups[0].commands[1]] }, traffic.groups[1]]
        });
        expect(result.ok).toBe(recipientSessionId === 'director-session');
        if (recipientSessionId === 'director-session') {
            expect(sent).toHaveLength(6);
            expect(sent.map((command) => command?.handleId)).toEqual([
                'alm-scale-player-shot-1',
                'alm-scale-player-shot-2',
                'alm-scale-player-shot-3',
                'alm-scale-player-shot-4',
                'alm-scale-player-shot-5',
                'alm-scale-player-shot-6'
            ]);
            sent.forEach((command, index) =>
                expect(command).toMatchObject({
                    payload: {
                        payload: {
                            senderId: connectedSessionId,
                            seq: index + 1,
                            payload: { shot: { sessionId: 'player-session', seq: index + 1 } }
                        }
                    }
                })
            );
        }
    });
});

function createEvidenceResult(commandId: string, kind: RallarBlackBoxTestCommand['kind'], value: RallarBlackBoxTestResult['value']): RallarBlackBoxTestResult {
    return { commandId, kind, value, status: 'ok', ok: true, startedAtEpochMs: 1_000, endedAtEpochMs: 31_000, durationMs: 30_000 };
}

interface SamplerEvidence {
    readonly iterations: number;
    readonly failed: number;
    readonly cancelled: boolean;
}

const HEALTHY_SAMPLER: SamplerEvidence = { iterations: 7, failed: 0, cancelled: false };

function createEvidence(agentId: string, director: boolean, samplerEvidence: SamplerEvidence): DistributedGroupAssertionRecipeEvidence {
    const prefix = director ? 'alm-scale-director' : 'alm-scale-player';
    return {
        agentId,
        recipeId: prefix,
        hasResult: true,
        resultValue: {
            results: [
                createSamplerTrafficEvidence(prefix, samplerEvidence),
                createEvidenceResult(`${prefix}-final-stats`, 'stats', { rallar: { alm: HEALTHY, congestion: { dropped: 0, deferred: 0, handedOver: 0 } } }),
                createEvidenceResult(`${prefix}-storage`, 'storage.counters', {
                    byOwner: { 'al-admission': 0, 'al-work': 5 },
                    workProbeCount: 5,
                    workNonProbeCount: 0
                }),
                createEvidenceResult(`${prefix}-received`, 'messages.received', { observed: director ? 84 : 2 }),
                ...(director ? createLifecycleReceiptEvidence(prefix) : [createEvidenceResult(`${prefix}-shots`, 'loop', {
                    commandId: `${prefix}-shots`,
                    iterations: 6,
                    childResultCount: 60,
                    passed: 60,
                    failed: 0,
                    cancelled: false,
                    pacing: { completedIterations: 6 },
                    results: []
                })])
            ]
        }
    };
}

function createSamplerTrafficEvidence(prefix: string, samplerEvidence: SamplerEvidence): RallarBlackBoxTestResult {
    const sampler = createEvidenceResult(`${prefix}-sampler`, 'loop', {
        commandId: `${prefix}-sampler`,
        ...samplerEvidence,
        childResultCount: 84,
        passed: 84,
        pacing: { completedIterations: samplerEvidence.iterations },
        results: []
    });
    return createEvidenceResult(`${prefix}-traffic`, 'parallel', {
        commandId: `${prefix}-traffic`,
        groupCount: 1,
        maxConcurrency: 2,
        passed: 1,
        failed: 0,
        cancelled: false,
        groups: [{
            groupId: 'sampling',
            commandCount: 1,
            passed: 1,
            failed: 0,
            cancelled: false,
            durationMs: 30_000,
            results: [{
                commandId: sampler.commandId,
                originalCommandId: sampler.commandId,
                parentCommandId: `${prefix}-traffic`,
                path: '$.groups[0].results[0]',
                sourceRecipePath: '$.commands[0]',
                childIndex: 0,
                commandIndex: 0,
                groupIndex: 0,
                groupId: 'sampling',
                result: sampler
            }]
        }]
    });
}

function createLifecycleReceiptEvidence(prefix: string): readonly RallarBlackBoxTestResult[] {
    return ['start', 'end'].map((event) =>
        createEvidenceResult(`${prefix}-${event}-receipt`, 'messages.receipts', {
            state: 'acknowledged',
            receiptMode: 'receiver',
            expectedRecipientPeerIds: Array.from({ length: 14 }, (_, index) => `session-${index + 2}`),
            confirmedRecipientPeerIds: Array.from({ length: 14 }, (_, index) => `session-${index + 2}`),
            unconfirmedRecipientPeerIds: []
        })
    );
}

function evaluateEvidence(evidence: readonly DistributedGroupAssertionRecipeEvidence[]) {
    const scale = createAlmScaleRecipes({ participantCount: 15, group: GROUP, readyTimeoutMs: 45_000 });
    const participants = Array.from(
        { length: 15 },
        (_, index) => ({ agentId: `controller-${String(index + 1).padStart(2, '0')}`, roles: [index === 0 ? 'sender' : 'receiver'] })
    );
    const manifest: RallarBlackBoxDistributedRunManifest = {
        schemaVersion: 1,
        distributedRunId: 'scale-proof',
        controlRunId: 'scale-proof',
        group: GROUP,
        recipes: scale.recipes.map((recipe) => ({ recipeId: recipe.recipeId, recipe, variables: {} })),
        targetPolicy: { mode: 'all-online-group-members' },
        variables: {},
        roleAssignments: [],
        ackTimeoutMs: 30_000,
        barrier: { enabled: false },
        startMode: 'manual',
        groupAssertions: scale.groupAssertions,
        metadata: {}
    };
    return computeDistributedGroupAssertionResults({
        manifest,
        participants,
        recipeEvidence: evidence,
        recipeResults: participants.map((participant) => ({ agentId: participant.agentId, recipeKey: participant.agentId, state: 'passed' }))
    });
}

describe('ALM scale controller evidence', () => {
    const healthy = Array.from({ length: 15 }, (_, index) => createEvidence(`controller-${String(index + 1).padStart(2, '0')}`, index === 0, HEALTHY_SAMPLER));

    it('accepts all frozen roles with nested sampler, full receipts and named storage exclusions', () => {
        const results = evaluateEvidence(healthy)!;
        expect(results.length).toBeGreaterThan(30);
        expect(results.every((result) => result.ok)).toBe(true);
        expect(results.find((result) => result.groupAssertionId === 'alm-scale-player-sampler-iterations')?.perAgent.map((row) => row.agentId))
            .toEqual(Array.from({ length: 14 }, (_, index) => `controller-${String(index + 2).padStart(2, '0')}`));
    });

    it.each(['missing', 'duplicate'] as const)('fails with the exact controller when its recipe evidence is %s', (failure) => {
        const evidence = failure === 'missing' ? healthy.filter((row) => row.agentId !== 'controller-09') : [...healthy, healthy[8]];
        const results = evaluateEvidence(evidence)!;
        const sampler = results.find((result) => result.groupAssertionId === 'alm-scale-player-sampler-iterations')!;
        expect(sampler.ok).toBe(false);
        expect(sampler.missingAgentIds).toEqual(failure === 'missing' ? ['controller-09'] : []);
        expect(sampler.violatingAgentIds).toEqual([]);
        expect(sampler.perAgent.find((row) => row.agentId === 'controller-09')).toMatchObject({ evidence: failure });
    });

    it('fails duplicate nested sampler sources with the exact original controller', () => {
        const evidence = healthy.map((row) => {
            if (row.agentId !== 'controller-09' || !row.hasResult || !isJsonRecordValue(row.resultValue)) {
                return row;
            }
            const results = row.resultValue.results;
            if (!Array.isArray(results)) {
                throw new Error('Missing recipe results');
            }
            return { ...row, resultValue: { results: [...results, createSamplerTrafficEvidence('alm-scale-player', HEALTHY_SAMPLER)] } };
        });
        const assertion = evaluateEvidence(evidence)!.find((result) => result.groupAssertionId === 'alm-scale-player-sampler-iterations')!;
        expect(assertion.ok).toBe(false);
        expect(assertion.perAgent.find((row) => row.agentId === 'controller-09')).toMatchObject({ evidence: 'duplicate' });
    });

    it('rejects a shrunken receipt audience even when every declared recipient confirmed', () => {
        const evidence = healthy.map((row) => {
            if (row.agentId !== 'controller-01' || !row.hasResult || !isJsonRecordValue(row.resultValue)) {
                return row;
            }
            const results = row.resultValue.results;
            if (!Array.isArray(results)) {
                throw new Error('Missing recipe results');
            }
            return {
                ...row,
                resultValue: {
                    results: results.map((result) =>
                        isRallarBlackBoxTestResult(result) && result.commandId === 'alm-scale-director-start-receipt'
                            ? createEvidenceResult(result.commandId, 'messages.receipts', {
                                state: 'acknowledged',
                                receiptMode: 'receiver',
                                expectedRecipientPeerIds: Array.from({ length: 13 }, (_, index) => `session-${index + 2}`),
                                confirmedRecipientPeerIds: Array.from({ length: 13 }, (_, index) => `session-${index + 2}`),
                                unconfirmedRecipientPeerIds: []
                            })
                            : result
                    )
                }
            };
        });
        const assertion = evaluateEvidence(evidence)!.find((result) =>
            result.groupAssertionId === 'alm-scale-director-start-receipt-expectedRecipientPeerIds-length'
        )!;
        expect(assertion.ok).toBe(false);
        expect(assertion.violatingAgentIds).toEqual(['controller-01']);
    });

    it.each([
        { name: 'transient sampler failure', sampler: { ...HEALTHY_SAMPLER, failed: 1 }, assertion: 'failed' },
        { name: 'incomplete sampler', sampler: { ...HEALTHY_SAMPLER, iterations: 6 }, assertion: 'iterations' },
        { name: 'cancelled sampler', sampler: { ...HEALTHY_SAMPLER, cancelled: true }, assertion: 'cancelled' }
    ])('attributes $name to its original controller even with healthy final stats', ({ sampler, assertion }) => {
        const evidence = healthy.map((row) =>
            row.agentId === 'controller-09'
                ? createEvidence(row.agentId, false, sampler)
                : row
        );
        const results = evaluateEvidence(evidence)!;
        const failed = results.find((result) => result.groupAssertionId === `alm-scale-player-sampler-${assertion}`)!;
        expect(failed.ok).toBe(false);
        expect(failed.violatingAgentIds).toEqual(['controller-09']);
        expect(failed.missingAgentIds).toEqual([]);
    });
});
