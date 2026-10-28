import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { decodeBarrierArrival, toBarrierResolvedEvent } from '@shared-test/rallar-bb-test/barrier/control-barrier-protocol.ts';

import type { RallarRoomTransportStatus } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { ALCongestionCounters } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import type { BlackBoxRallarDeliveryObservation } from '../../shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';

import type { RallarBlackBoxBrowserTestRuntime } from '../../shared-test/rallar-bb-test/browser/browser-command-contracts.ts';
import { isRallarBlackBoxTestResult } from '../../shared-test/rallar-bb-test/composite-results.ts';
import { createAlmScalePayload } from '../../shared-test/rallar-bb-test/conformance/alm/scale/create-alm-scale-payload.ts';
import { createAlmScaleRecipes } from '../../shared-test/rallar-bb-test/conformance/alm/scale/create-alm-scale-recipes.ts';
import { createDefaultRallarBlackBoxBrowserTestRuntime } from '../../shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import type { RallarBlackBoxDistributedRunManifest } from '../../shared-test/rallar-bb-test/distributed-run.ts';
import { computeDistributedGroupAssertionResults } from '../../shared-test/rallar-bb-test/distributed/group-assertions-evaluation.ts';
import type { DistributedGroupAssertionRecipeEvidence } from '../../shared-test/rallar-bb-test/distributed/group-assertions-evidence.ts';
import type {
    RallarBlackBoxTestAlmUsage,
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestJsonValue,
    RallarBlackBoxTestResult
} from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { decodeJsonValue } from '../../shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import { isJsonRecordValue } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { createBrowserRallarRequiredMethodsTestDouble } from './browser-rallar-required-methods-test-double.ts';

interface SamplerExecution {
    readonly result: RallarBlackBoxTestResult;
    readonly final: RallarBlackBoxTestResult;
    readonly runtime: RallarBlackBoxBrowserTestRuntime;
    readonly elapsedMs: number;
    readonly sampleStartsMs: readonly number[];
}

interface SamplerInput {
    readonly role: 'director' | 'player';
    readonly readings: readonly (RallarBlackBoxTestAlmUsage | undefined)[];
    readonly congestion: ALCongestionCounters | undefined;
    readonly readLatencyMs?: number;
}

interface TrafficScenario {
    readonly role: 'director' | 'player';
    readonly participantCount?: 6 | 11 | 15 | 30 | 50;
    readonly missingPlayer?: boolean;
    readonly missingSequence?: boolean;
    readonly wrongDirector?: boolean;
    readonly wrongType?: boolean;
    readonly cancelAtMs?: number;
    readonly duplicateStart?: boolean;
    readonly startDelayMs?: number;
    readonly ackDelayMs?: number;
    readonly endAudience?: 'substituted' | 'duplicate' | 'disagreed' | 'reordered';
}

const GROUP = { applicationId: 'scale-app', workspaceId: 'scale-workspace', groupId: 'scale-room' };
const HEALTHY: RallarBlackBoxTestAlmUsage = {
    own: { admissions: 6, bytes: 3_000 },
    inbound: { admissions: 84, bytes: 42_000 },
    usage: { admissions: 90, bytes: 45_000, oldestAgeMs: 25_000, tracks: 1 },
    limits: { maxAdmissions: 1_000, maxBytes: 4_194_304, maxAgeMs: 300_000, maxTracks: 64 },
    overloaded: false,
    orderingTracks: 85,
    deliveredMarkers: 85,
    repliesHeld: 0,
    replyWaitsOpen: 0
};
const EMPTY: RallarBlackBoxTestAlmUsage = {
    ...HEALTHY,
    own: { admissions: 0, bytes: 0 },
    inbound: { admissions: 0, bytes: 0 },
    usage: { admissions: 0, bytes: 0, oldestAgeMs: 0, tracks: 0 },
    orderingTracks: 0,
    deliveredMarkers: 0,
    repliesHeld: 0,
    replyWaitsOpen: 0
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
    const scale = createAlmScaleRecipes({ participantCount: 15, group: GROUP, readyTimeoutMs: 45_000, almDiagnostics: false });
    const traffic = scale.recipes[role === 'director' ? 0 : 1].commands.find((command) => command.kind === 'parallel');
    if (traffic?.kind !== 'parallel') {
        throw new Error('Missing scale traffic');
    }
    const sampler = traffic.groups[1].commands[0];
    return { ...sampler, commandId: `alm-scale-${role}-traffic:g2:sampling:c1:alm-scale-${role}-sampler` };
}

async function runSampler(input: SamplerInput): Promise<SamplerExecution> {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let index = 0;
    const sampleStartsMs: number[] = [];
    const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({
        now: Date.now,
        sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        rallarRuntime: {
            ...createBrowserRallarRequiredMethodsTestDouble(),
            connect: async () => ({ connected: true }),
            send: async () => ({ sent: true }),
            refreshRoom: async () => undefined,
            close: async () => ({ closed: true }),
            health: async () => ({ connected: true }),
            readAlmUsage: async () => {
                sampleStartsMs.push(Date.now() - 1_000);
                if (input.readLatencyMs) {
                    await new Promise<void>((resolve) => setTimeout(resolve, input.readLatencyMs));
                }
                return input.readings[Math.min(index++, input.readings.length - 1)];
            },
            readCongestionCounters: async () => input.congestion
        }
    });
    const execution = runtime.execute(getSampler(input.role));
    await vi.runAllTimersAsync();
    const result = await execution;
    const elapsedMs = Date.now() - 1_000;
    const sampledStartsMs = [...sampleStartsMs];
    const finalExecution = runtime.execute({ kind: 'stats', commandId: `alm-scale-${input.role}-final-stats` });
    await vi.runAllTimersAsync();
    const final = await finalExecution;
    return { result, final, runtime, elapsedMs, sampleStartsMs: sampledStartsMs };
}

describe('ALM scale sampled acceptance', () => {
    afterEach(() => vi.useRealTimers());

    it.each(['director', 'player'] as const)('checks seven readings across 30 seconds on the %s page', async (role) => {
        const { result, elapsedMs, sampleStartsMs } = await runSampler({
            role,
            readings: [HEALTHY],
            congestion: { dropped: 0, deferred: 2, handedOver: 1, rateLimited: 0, circuitOpen: 0, queuedBytesHighWater: 0 }
        });
        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({ groupCount: 7, maxConcurrency: 7, passed: 90, failed: 0, cancelled: false });
        expect(elapsedMs).toBe(30_000);
        expect(sampleStartsMs).toEqual([0, 5_000, 10_000, 15_000, 20_000, 25_000, 30_000]);
    });

    it.each(['director', 'player'] as const)('keeps seven %s readings on nominal five-second starts with one-second read latency', async (role) => {
        const { result, sampleStartsMs } = await runSampler({
            role,
            readings: [HEALTHY],
            congestion: { dropped: 0, deferred: 2, handedOver: 1, rateLimited: 0, circuitOpen: 0, queuedBytesHighWater: 0 },
            readLatencyMs: 1_000
        });
        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({ groupCount: 7, maxConcurrency: 7, passed: 90, failed: 0, cancelled: false });
        expect(sampleStartsMs).toEqual([0, 5_000, 10_000, 15_000, 20_000, 25_000, 30_000]);
    });

    it('keeps a six-second overlapping read bound to its own sampled budget result', async () => {
        const { result, sampleStartsMs } = await runSampler({
            role: 'player',
            readings: [HEALTHY, { ...HEALTHY, own: { admissions: 1_001, bytes: 3_000 } }, HEALTHY],
            congestion: { dropped: 0, deferred: 0, handedOver: 0, rateLimited: 0, circuitOpen: 0, queuedBytesHighWater: 0 },
            readLatencyMs: 6_000
        });
        expect(sampleStartsMs).toEqual([0, 5_000, 10_000, 15_000, 20_000, 25_000, 30_000]);
        expect(result.ok).toBe(false);
        expect(result.value).toMatchObject({ failed: 1, groupCount: 7 });
    });

    it.each(['director', 'player'] as const)('keeps a transient excess failed even after a zero final reading on %s', async (role) => {
        const { result, final } = await runSampler({
            role,
            readings: [HEALTHY, { ...HEALTHY, own: { admissions: 1_001, bytes: 3_000 } }, EMPTY],
            congestion: { dropped: 0, deferred: 0, handedOver: 0, rateLimited: 0, circuitOpen: 0, queuedBytesHighWater: 0 }
        });
        expect(final.value).toMatchObject({ rallar: { alm: { own: { admissions: 0 } } } });
        expect(result.ok).toBe(false);
        expect(result.value).toMatchObject({ failed: 1, cancelled: false });
    });

    it.each([
        {
            name: 'missing ledger',
            reading: undefined,
            congestion: { dropped: 0, deferred: 0, handedOver: 0, rateLimited: 0, circuitOpen: 0, queuedBytesHighWater: 0 }
        },
        { name: 'missing congestion', reading: HEALTHY, congestion: undefined },
        {
            name: 'own byte excess',
            reading: { ...HEALTHY, own: { admissions: 6, bytes: 4_194_305 } },
            congestion: { dropped: 0, deferred: 0, handedOver: 0, rateLimited: 0, circuitOpen: 0, queuedBytesHighWater: 0 }
        },
        {
            name: 'oldest counted age excess',
            reading: { ...HEALTHY, usage: { ...HEALTHY.usage, oldestAgeMs: 300_001 } },
            congestion: { dropped: 0, deferred: 0, handedOver: 0, rateLimited: 0, circuitOpen: 0, queuedBytesHighWater: 0 }
        },
        {
            name: 'own ordering track excess',
            reading: { ...HEALTHY, usage: { ...HEALTHY.usage, tracks: 65 } },
            congestion: { dropped: 0, deferred: 0, handedOver: 0, rateLimited: 0, circuitOpen: 0, queuedBytesHighWater: 0 }
        },
        {
            name: 'ordering snapshot excess',
            reading: { ...HEALTHY, orderingTracks: 513 },
            congestion: { dropped: 0, deferred: 0, handedOver: 0, rateLimited: 0, circuitOpen: 0, queuedBytesHighWater: 0 }
        },
        {
            name: 'overload',
            reading: { ...HEALTHY, overloaded: true },
            congestion: { dropped: 0, deferred: 0, handedOver: 0, rateLimited: 0, circuitOpen: 0, queuedBytesHighWater: 0 }
        },
        {
            name: 'relaxed runtime limit',
            reading: { ...HEALTHY, limits: { ...HEALTHY.limits, maxTracks: 128 } },
            congestion: { dropped: 0, deferred: 0, handedOver: 0, rateLimited: 0, circuitOpen: 0, queuedBytesHighWater: 0 }
        },
        {
            name: 'congestion drop',
            reading: HEALTHY,
            congestion: { dropped: 1, deferred: 0, handedOver: 0, rateLimited: 0, circuitOpen: 0, queuedBytesHighWater: 0 }
        }
    ])('fails closed on $name', async ({ reading, congestion }) => {
        const { result } = await runSampler({ role: 'player', readings: [reading], congestion });
        expect(result.ok).toBe(false);
    });
});

function recordTrafficArrivals(runtime: RallarBlackBoxBrowserTestRuntime, scenario: TrafficScenario): void {
    const input = { participantCount: scenario.participantCount ?? 15, group: GROUP, readyTimeoutMs: 45_000, almDiagnostics: false } as const;
    const prefix = `alm-scale-${scenario.role}`;
    const shotCount = (input.participantCount - 1) * 6;
    const payloads = scenario.role === 'player'
        ? [createAlmScalePayload(input, 'started'), createAlmScalePayload(input, scenario.duplicateStart ? 'started' : 'ended')]
        : Array.from({ length: shotCount }, (_, index) => {
            const player = scenario.missingPlayer && index >= shotCount - 6 ? 1 : Math.floor(index / 6) + 1;
            return decodeTrafficFixture(
                JSON.stringify(createAlmScalePayload(input, 'shot'))
                    .replaceAll('{auth.sessionId}', `session-${player}`)
                    .replaceAll('"{loop.iteration}"', String(scenario.missingSequence && index === shotCount - 1 ? 5 : index % 6 + 1))
            );
        });
    if (scenario.wrongType) {
        payloads.push(payloads[0]);
    }
    for (const [index, payload] of payloads.entries()) {
        runtime.receiveRallarBrowserEvent({
            kind: 'message',
            connection: prefix,
            topic: 'rallar.browser.messages.rtc.message',
            data: {
                typeId: `room.ar-eye-hunter.director.${
                    scenario.role === 'director' && !(scenario.wrongType && index === shotCount - 1) ? 'intent' : 'event'
                }.v1`,
                payload: decodeTrafficFixture(
                    JSON.stringify(payload).replaceAll('{auth.sessionId}', scenario.wrongDirector ? 'wrong-director' : 'director-session')
                )
            }
        });
    }
}

function decodeTrafficFixture(serialized: string): RallarBlackBoxTestJsonValue {
    const decoded = decodeJsonValue(JSON.parse(serialized));
    if (decoded === undefined) {
        throw new Error('Invalid authored traffic fixture');
    }
    return decoded;
}

function createTrafficReceipt(scenario: TrafficScenario, handleId: string): BlackBoxRallarDeliveryObservation {
    const frozenPlayers = Array.from({ length: (scenario.participantCount ?? 15) - 1 }, (_, index) => `session-${index + 1}`);
    const endReceipt = scenario.role === 'director' && handleId === 'alm-scale-director-end';
    const expectedPlayers = endReceipt && scenario.endAudience === 'substituted'
        ? [...frozenPlayers.slice(0, -1), 'substituted-session']
        : endReceipt && scenario.endAudience === 'duplicate'
        ? [...frozenPlayers.slice(0, -1), frozenPlayers[0]]
        : endReceipt && scenario.endAudience === 'reordered'
        ? [...frozenPlayers].reverse()
        : frozenPlayers;
    const confirmedPlayers = endReceipt && scenario.endAudience === 'disagreed'
        ? [...frozenPlayers.slice(0, -1), 'substituted-session']
        : expectedPlayers;
    return {
        handleId,
        state: 'acknowledged',
        submitted: true,
        enqueued: false,
        receiptMode: scenario.role === 'player' ? 'leader' : 'receiver',
        confirmedHopPeerIds: [],
        unconfirmedHopPeerIds: [],
        expectedRecipientPeerIds: scenario.role === 'player'
            ? ['director-session']
            : expectedPlayers,
        confirmedRecipientPeerIds: scenario.role === 'player'
            ? ['director-session']
            : confirmedPlayers,
        unconfirmedRecipientPeerIds: [],
        attempts: 1,
        attemptOutcomes: [],
        attemptCarriers: [],
        attemptRefusalReasons: [],
        reason: undefined,
        backpressured: false,
        relayRejection: undefined,
        failure: undefined,
        carrierFallback: undefined,
        durabilityDowngrade: undefined
    };
}

function createTrafficRuntime(scenario: TrafficScenario): RallarBlackBoxBrowserTestRuntime {
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    return createDefaultRallarBlackBoxBrowserTestRuntime({
        now: Date.now,
        sleep,
        rallarRuntime: {
            ...createBrowserRallarRequiredMethodsTestDouble(),
            connect: async () => ({ sessionId: 'player-session', connected: true }),
            waitForRoom: async () => READY_ROOM,
            send: async () => ({}),
            refreshRoom: async () => undefined,
            close: async () => ({}),
            health: async () => ({ connected: true }),
            readAlmUsage: async () => HEALTHY,
            readCongestionCounters: async () => ({ dropped: 0, deferred: 0, handedOver: 0, rateLimited: 0, circuitOpen: 0, queuedBytesHighWater: 0 }),
            sendMessage: async (command) => ({
                handleId: command.handleId,
                carrier: command.carrier,
                status: 'acknowledged',
                traceId: 'trace-scale-send',
                corrId: String(command.handleId)
            }),
            observeDelivery: async (command) => {
                await sleep(scenario.ackDelayMs ?? 0);
                return createTrafficReceipt(scenario, String(command.handleId));
            },
            readReceipts: async (command) => createTrafficReceipt(scenario, String(command.handleId)),
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
}

async function runTrafficScenario(scenario: TrafficScenario): Promise<RallarBlackBoxTestResult> {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.stubGlobal('localStorage', {
        getItem: () =>
            JSON.stringify({
                clientId: 'page-client',
                username: 'Player',
                sessionId: 'player-session',
                accessToken: 'test-token',
                expiresAtEpochMs: Date.now() + 60_000
            })
    });
    const runtime = createTrafficRuntime(scenario);
    const recipe = createAlmScaleRecipes({ participantCount: scenario.participantCount ?? 15, group: GROUP, readyTimeoutMs: 45_000, almDiagnostics: false })
        .recipes[scenario.role === 'director' ? 0 : 1];
    await runtime.execute(recipe.commands.find((command) => command.kind === 'rtc.connect')!);
    await runtime.execute({ kind: 'director.status', commandId: 'alm-scale-player-ready-status', roomRef: GROUP, refresh: true });
    if (!scenario.startDelayMs) {
        recordTrafficArrivals(runtime, scenario);
    }
    else {
        setTimeout(() => recordTrafficArrivals(runtime, scenario), scenario.startDelayMs);
    }
    const traffic = recipe.commands.find((command) => command.kind === 'parallel');
    if (traffic?.kind !== 'parallel') {
        throw new Error('Missing traffic');
    }
    releaseSingleRoleBarrierOnArrival(runtime, scenario.role);
    const execution = runtime.execute(traffic);
    if (scenario.cancelAtMs !== undefined) {
        setTimeout(() => {
            void runtime.execute({ kind: 'recipe.cancel', commandId: 'cancel-traffic', reason: 'test cancellation' });
        }, scenario.cancelAtMs);
    }
    await vi.runAllTimersAsync();
    return await execution;
}

function releaseSingleRoleBarrierOnArrival(runtime: RallarBlackBoxBrowserTestRuntime, role: TrafficScenario['role']): void {
    // Isolated page arrival checks use one external participant; the cadence cohort joins all fifteen.
    runtime.subscribe((state) => {
        const arrival = state.events.map((event) => decodeBarrierArrival(event).right).find((value) => value !== undefined);
        if (arrival && !state.events.some((event) => event.topic === 'rallar.bb.barrier.resolved')) {
            runtime.recordEvent(toBarrierResolvedEvent({
                kind: 'barrier',
                protocolVersion: 1,
                runId: 'single-role-arrival-proof',
                agentId: role,
                barrierId: arrival.barrierId,
                resolution: { outcome: 'released', arrivedAgentIds: [role] }
            }));
        }
    });
}

describe('ALM scale single-page traffic and arrival validation', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it.each(
        [
            { role: 'director', missingPlayer: true },
            { role: 'director', missingSequence: true },
            { role: 'director', wrongType: true },
            { role: 'player', duplicateStart: true },
            { role: 'player', wrongDirector: true },
            { role: 'player', startDelayMs: 8_000 },
            { role: 'player', ackDelayMs: 9_000 }
        ] as const
    )('rejects incomplete identities or traffic outside the sampled window: %j', async (scenario) => {
        expect((await runTrafficScenario(scenario)).ok).toBe(false);
    });

    it.each(['director', 'player'] as const)('accepts complete %s traffic inside the window', async (role) => {
        const result = await runTrafficScenario({ role });
        expect(result.error).toBeUndefined();
        expect(result.ok).toBe(true);
        if (role === 'player') {
            expect(result.value).toMatchObject({ groups: [{ results: [{ result: { value: { groups: [{ durationMs: 25_000 }] } } }] }, {}] });
        }
    });

    it.each(['substituted', 'duplicate', 'disagreed'] as const)('rejects acknowledged END with a %s player audience', async (endAudience) => {
        const result = await runTrafficScenario({ role: 'director', endAudience });
        expect(result.ok).toBe(false);
    });

    it('accepts the same unique END player audience in a different order', async () => {
        const result = await runTrafficScenario({ role: 'director', endAudience: 'reordered' });
        expect(result.error).toBeUndefined();
        expect(result.ok).toBe(true);
    });

    it('keeps the generated workload and sampler cancelled after interruption', async () => {
        const result = await runTrafficScenario({ role: 'player', cancelAtMs: 7_000 });
        expect(result.ok).toBe(false);
        expect(result.status).toBe('cancelled');
        expect(result.value).toMatchObject({
            cancelled: true,
            groups: [{ cancelled: true, results: [{ result: { value: { cancelled: true } } }] }, { cancelled: true }]
        });
    });

    it.each([6, 11, 30, 50] as const)('executes all per-player arrivals within native composite bounds for %i participants', async (participantCount) => {
        const result = await runTrafficScenario({ role: 'director', participantCount });
        expect(result.error).toBeUndefined();
        expect(result.ok).toBe(true);
    });
});

function createEvidenceResult(commandId: string, kind: RallarBlackBoxTestCommand['kind'], value: RallarBlackBoxTestResult['value']): RallarBlackBoxTestResult {
    return { commandId, kind, value, status: 'ok', ok: true, startedAtEpochMs: 1_000, endedAtEpochMs: 31_000, durationMs: 30_000 };
}

interface SamplerEvidence {
    readonly groupCount: number;
    readonly failed: number;
    readonly cancelled: boolean;
    readonly missingSampleSlot?: number;
    readonly overLimitSampleSlot?: number;
}

const HEALTHY_SAMPLER: SamplerEvidence = { groupCount: 7, failed: 0, cancelled: false };

interface WorkloadEvidence {
    readonly elapsedMs: number;
    readonly cancelled: boolean;
    readonly arrivalsFailed: number;
}

const HEALTHY_WORKLOAD: WorkloadEvidence = { elapsedMs: 25_000, cancelled: false, arrivalsFailed: 0 };

interface ControllerEvidenceInput {
    readonly agentId: string;
    readonly director: boolean;
    readonly samplerEvidence: SamplerEvidence;
    readonly workloadEvidence: WorkloadEvidence;
    readonly endAudience?: 'substituted' | 'duplicate' | 'disagreed' | 'reordered';
    readonly connectSessionId?: string;
}

function createEvidence(input: ControllerEvidenceInput): DistributedGroupAssertionRecipeEvidence {
    const { agentId, director, samplerEvidence, workloadEvidence } = input;
    const prefix = director ? 'alm-scale-director' : 'alm-scale-player';
    return {
        agentId,
        recipeId: prefix,
        hasResult: true,
        resultValue: {
            results: [
                ...(!director
                    ? [createEvidenceResult(`${prefix}-connect`, 'rtc.connect', {
                        sessionId: input.connectSessionId ?? `session-${Number(agentId.slice(-2))}`
                    })]
                    : []),
                createSamplerTrafficEvidence(prefix, samplerEvidence),
                ...createWorkloadEvidence(prefix, director, workloadEvidence),
                createEvidenceResult(`${prefix}-final-stats`, 'stats', {
                    rallar: { alm: HEALTHY, congestion: { dropped: 0, deferred: 0, handedOver: 0, rateLimited: 0, circuitOpen: 0, queuedBytesHighWater: 0 } }
                }),
                createEvidenceResult(`${prefix}-storage`, 'storage.counters', {
                    byOwner: { 'al-admission': 0, 'al-work': 5 },
                    workProbeCount: 5,
                    workNonProbeCount: 0
                }),
                createEvidenceResult(`${prefix}-received`, 'messages.received', { observed: director ? 84 : 2 }),
                ...(director ? createLifecycleReceiptEvidence(prefix, input.endAudience) : [createEvidenceResult(`${prefix}-shots`, 'loop', {
                    commandId: `${prefix}-shots`,
                    iterations: 6,
                    failed: 0,
                    cancelled: false,
                    pacing: { completedIterations: 6 },
                    results: []
                })])
            ]
        }
    };
}

function createWorkloadEvidence(prefix: string, director: boolean, evidence: WorkloadEvidence): readonly RallarBlackBoxTestResult[] {
    return [
        createEvidenceResult(`${prefix}-window`, 'parallel', {
            groupCount: 1,
            passed: director ? 23 : 8,
            failed: 0,
            cancelled: evidence.cancelled,
            groups: [{ commandCount: director ? 23 : 8, durationMs: evidence.elapsedMs }]
        }),
        ...(director
            ? [createEvidenceResult(`${prefix}-shot-arrivals`, 'loop', {
                iterations: 6,
                passed: 252,
                failed: evidence.arrivalsFailed,
                cancelled: false,
                pacing: { completedIterations: 6 }
            })]
            : ['started', 'ended'].map((kind) =>
                createEvidenceResult(`${prefix}-${kind}-arrival`, 'wait', {
                    matched: true,
                    event: { payload: { data: { typeId: 'room.ar-eye-hunter.director.event.v1' } } }
                })
            ))
    ];
}

function createSamplerTrafficEvidence(prefix: string, samplerEvidence: SamplerEvidence): RallarBlackBoxTestResult {
    const sampler = createEvidenceResult(`${prefix}-sampler`, 'parallel', {
        commandId: `${prefix}-sampler`,
        groupCount: samplerEvidence.groupCount,
        maxConcurrency: 7,
        passed: 90,
        failed: samplerEvidence.failed,
        cancelled: samplerEvidence.cancelled,
        groups: Array.from({ length: 7 }, (_, index) => {
            const stats = createEvidenceResult(`${prefix}-sample-${index + 1}-stats`, 'stats', {
                rallar: {
                    alm: samplerEvidence.overLimitSampleSlot === index + 1
                        ? { ...HEALTHY, own: { ...HEALTHY.own, admissions: 1_001 } }
                        : HEALTHY,
                    congestion: { dropped: 0, deferred: 0, handedOver: 0, rateLimited: 0, circuitOpen: 0, queuedBytesHighWater: 0 }
                }
            });
            return {
                groupId: `sample-${index + 1}`,
                commandCount: index === 0 ? 12 : 13,
                passed: index === 0 ? 12 : 13,
                failed: 0,
                cancelled: false,
                durationMs: 0,
                results: [
                    ...(index === 0 ? [] : [{ result: createEvidenceResult(`${prefix}-sample-${index + 1}-offset`, 'wait', { matched: false }) }]),
                    ...(samplerEvidence.missingSampleSlot === index + 1 ? [] : [{ result: stats }])
                ]
            };
        })
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

function createLifecycleReceiptEvidence(
    prefix: string,
    endAudience: ControllerEvidenceInput['endAudience']
): readonly RallarBlackBoxTestResult[] {
    const frozenPlayers = Array.from({ length: 14 }, (_, index) => `session-${index + 2}`);
    return ['start', 'end'].map((event) => {
        const expectedPlayers = event === 'end' && endAudience === 'substituted'
            ? [...frozenPlayers.slice(0, -1), 'substituted-session']
            : event === 'end' && endAudience === 'duplicate'
            ? [...frozenPlayers.slice(0, -1), frozenPlayers[0]]
            : event === 'end' && endAudience === 'reordered'
            ? [...frozenPlayers].reverse()
            : frozenPlayers;
        const confirmedPlayers = event === 'end' && endAudience === 'disagreed'
            ? [...frozenPlayers.slice(0, -1), 'substituted-session']
            : expectedPlayers;
        return createEvidenceResult(`${prefix}-${event}-receipt`, 'messages.receipts', {
            state: 'acknowledged',
            receiptMode: 'receiver',
            expectedRecipientPeerIds: expectedPlayers,
            confirmedRecipientPeerIds: confirmedPlayers,
            unconfirmedRecipientPeerIds: []
        });
    });
}

function evaluateEvidence(evidence: readonly DistributedGroupAssertionRecipeEvidence[]) {
    const scale = createAlmScaleRecipes({ participantCount: 15, group: GROUP, readyTimeoutMs: 45_000, almDiagnostics: false });
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
    // Synthetic values isolate evaluator guards; the cadence cohort supplies actual runtime acceptance evidence.
    const healthy = Array.from({ length: 15 }, (_, index) =>
        createEvidence({
            agentId: `controller-${String(index + 1).padStart(2, '0')}`,
            director: index === 0,
            samplerEvidence: HEALTHY_SAMPLER,
            workloadEvidence: HEALTHY_WORKLOAD
        }));

    it('accepts all frozen roles with nested sampler, full receipts and named storage exclusions', () => {
        const results = evaluateEvidence(healthy)!;
        expect(results).toHaveLength(231);
        expect(results.every((result) => result.ok)).toBe(true);
        expect(results.find((result) => result.groupAssertionId === 'alm-scale-player-sampler-groupCount')?.perAgent.map((row) => row.agentId))
            .toEqual(Array.from({ length: 14 }, (_, index) => `controller-${String(index + 2).padStart(2, '0')}`));
    });

    it.each(['substituted', 'duplicate', 'disagreed'] as const)('rejects canonical native evidence with a %s END audience', (endAudience) => {
        const evidence = healthy.map((row) =>
            row.agentId === 'controller-01'
                ? createEvidence({
                    agentId: row.agentId,
                    director: true,
                    samplerEvidence: HEALTHY_SAMPLER,
                    workloadEvidence: HEALTHY_WORKLOAD,
                    endAudience
                })
                : row
        );
        const results = evaluateEvidence(evidence)!;
        expect(results.some((result) => !result.ok && result.violatingAgentIds.includes('controller-01'))).toBe(true);
    });

    it('accepts canonical native evidence with the same unique END audience in another order', () => {
        const evidence = healthy.map((row) =>
            row.agentId === 'controller-01'
                ? createEvidence({
                    agentId: row.agentId,
                    director: true,
                    samplerEvidence: HEALTHY_SAMPLER,
                    workloadEvidence: HEALTHY_WORKLOAD,
                    endAudience: 'reordered'
                })
                : row
        );
        expect(evaluateEvidence(evidence)!.every((result) => result.ok)).toBe(true);
    });

    it('rejects duplicate frozen player connection sessions without shrinking the receiver set', () => {
        const evidence = healthy.map((row) =>
            row.agentId === 'controller-09'
                ? createEvidence({
                    agentId: row.agentId,
                    director: false,
                    samplerEvidence: HEALTHY_SAMPLER,
                    workloadEvidence: HEALTHY_WORKLOAD,
                    connectSessionId: 'session-8'
                })
                : row
        );
        const assertion = evaluateEvidence(evidence)!.find((result) =>
            result.groupAssertionId === 'alm-scale-director-start-receipt-expectedRecipientPeerIds-frozen-player-sessions'
        )!;
        expect(assertion.ok).toBe(false);
        expect(assertion.participants.expected).toBe(15);
        expect(assertion.violatingAgentIds).toContain('controller-09');
    });

    it.each([
        { name: 'missing fourth reading', sampler: { ...HEALTHY_SAMPLER, missingSampleSlot: 4 } },
        { name: 'fourth reading over budget', sampler: { ...HEALTHY_SAMPLER, overLimitSampleSlot: 4 } }
    ])('rejects $name from the exact frozen player', ({ sampler }) => {
        const evidence = healthy.map((row) =>
            row.agentId === 'controller-09'
                ? createEvidence({
                    agentId: row.agentId,
                    director: false,
                    samplerEvidence: sampler,
                    workloadEvidence: HEALTHY_WORKLOAD
                })
                : row
        );
        const assertion = evaluateEvidence(evidence)!.find((result) =>
            result.groupAssertionId === 'alm-scale-player-sampler-groups-3-results-1-result-value-rallar-alm-own-admissions'
        )!;
        expect(assertion.ok).toBe(false);
        expect(assertion.perAgent.find((row) => row.agentId === 'controller-09')?.evidence)
            .toBe(sampler.missingSampleSlot ? 'unresolved' : 'resolved');
    });

    it.each(['missing', 'duplicate'] as const)('fails with the exact controller when its recipe evidence is %s', (failure) => {
        const evidence = failure === 'missing' ? healthy.filter((row) => row.agentId !== 'controller-09') : [...healthy, healthy[8]];
        const results = evaluateEvidence(evidence)!;
        const sampler = results.find((result) => result.groupAssertionId === 'alm-scale-player-sampler-groupCount')!;
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
        const assertion = evaluateEvidence(evidence)!.find((result) => result.groupAssertionId === 'alm-scale-player-sampler-groupCount')!;
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
        { name: 'incomplete sampler', sampler: { ...HEALTHY_SAMPLER, groupCount: 6 }, assertion: 'groupCount' },
        { name: 'cancelled sampler', sampler: { ...HEALTHY_SAMPLER, cancelled: true }, assertion: 'cancelled' }
    ])('attributes $name to its original controller even with healthy final stats', ({ sampler, assertion }) => {
        const evidence = healthy.map((row) =>
            row.agentId === 'controller-09'
                ? createEvidence({ agentId: row.agentId, director: false, samplerEvidence: sampler, workloadEvidence: HEALTHY_WORKLOAD })
                : row
        );
        const results = evaluateEvidence(evidence)!;
        const failed = results.find((result) => result.groupAssertionId === `alm-scale-player-sampler-${assertion}`)!;
        expect(failed.ok).toBe(false);
        expect(failed.violatingAgentIds).toEqual(['controller-09']);
        expect(failed.missingAgentIds).toEqual([]);
    });

    it.each(
        [
            { role: 'director', evidence: { ...HEALTHY_WORKLOAD, arrivalsFailed: 1 }, command: 'shot-arrivals', path: 'failed' },
            { role: 'player', evidence: { ...HEALTHY_WORKLOAD, elapsedMs: 33_000 }, command: 'window', path: 'groups-0-durationMs' },
            { role: 'player', evidence: { ...HEALTHY_WORKLOAD, cancelled: true }, command: 'window', path: 'cancelled' }
        ] as const
    )('keeps native traffic failures on the original controller: $command/$path', ({ role, evidence, command, path }) => {
        const controller = role === 'director' ? 'controller-01' : 'controller-09';
        const rows = healthy.map((row) =>
            row.agentId === controller
                ? createEvidence({ agentId: row.agentId, director: role === 'director', samplerEvidence: HEALTHY_SAMPLER, workloadEvidence: evidence })
                : row
        );
        const assertion = evaluateEvidence(rows)!.find((result) => result.groupAssertionId === `alm-scale-${role}-${command}-${path}`)!;
        expect(assertion.ok).toBe(false);
        expect(assertion.violatingAgentIds).toEqual([controller]);
    });
});
