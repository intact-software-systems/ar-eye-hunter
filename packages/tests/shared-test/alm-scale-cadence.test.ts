import {
    afterEach,
    beforeEach,
    expect,
    it,
    vi
} from 'vitest';

import type { BlackBoxRallarRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';
import { createBlackBoxRallarRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime.ts';
import type { BlackBoxBrowserMessagesDependency } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts';
import { BlackBoxRallarVolatileLimits } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-volatile-limits.ts';
import { requireBlackBoxRallarInput } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts';
import { decodeBlackBoxRallarMessageSendInput } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-message-send-input.ts';
import {
    decodeBlackBoxRallarDeliveryHandleInput,
    decodeBlackBoxRallarDeliveryObserveInput,
    decodeBlackBoxRallarStorageCountersInput
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-messaging-input.ts';
import { decodeBarrierArrival, toBarrierResolvedEvent } from '@shared-test/rallar-bb-test/barrier/control-barrier-protocol.ts';
import { createSpaBrowserRallarRuntime } from '@shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts';
import type { RallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/browser/browser-command-contracts.ts';
import { replaceCommandPlaceholders } from '@shared-test/rallar-bb-test/browser/browser-command-placeholders.ts';
import { createAlmScalePayload } from '@shared-test/rallar-bb-test/conformance/alm/scale/create-alm-scale-payload.ts';
import { createAlmScaleRecipes } from '@shared-test/rallar-bb-test/conformance/alm/scale/create-alm-scale-recipes.ts';
import { createDefaultRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';
import { computeDistributedGroupAssertionResults } from '@shared-test/rallar-bb-test/distributed/group-assertions-evaluation.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestJsonValue,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { decodeJsonValue } from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import type { RallarMessageHandle } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import { createBrowserRallarRequiredMethodsTestDouble } from './browser-rallar-required-methods-test-double.ts';
import {
    facade,
    loadRuntime,
    resetFacade
} from './rallar-browser-runtime/browser-rallar-runtime-test-harness.ts';

const GROUP = { applicationId: 'scale-app', workspaceId: 'scale-workspace', groupId: 'scale-room' };
const INPUT = { participantCount: 15, group: GROUP, readyTimeoutMs: 45_000 } as const;

interface ScaleWirePayload extends RallarBlackBoxTestRecord {
    readonly typeId: string;
    readonly payload: RallarBlackBoxTestJsonValue;
}

interface ShotStart {
    readonly atMs: number;
    readonly msgId: string;
    readonly payload: ScaleWirePayload;
}

beforeEach(() => {
    resetFacade();
    facade.behavior.restore.mockReturnValue(facade.session);
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(facade.session) });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function openShot(payload: ScaleWirePayload, starts: ShotStart[]) {
    const msgId = `shot-${starts.length + 1}`;
    const registry = facade.deliveries;
    const handle = registry.open({
        id: { v: 3, msgId, ts: Date.now(), senderId: facade.session.sessionId },
        route: { topicId: 'room.ar-eye-hunter.director', contextId: GROUP.groupId, resourceId: GROUP.groupId },
        payload: { typeId: payload.typeId, contentType: 'application/json', resource: JSON.stringify(payload.payload) },
        delivery: { ack: 'group-leader', reliability: 'at-least-once' }
    }, 'rtc');
    starts.push({ atMs: Date.now(), msgId, payload });
    registry.record({
        kind: 'admission',
        msgId,
        carrier: 'rtc',
        atMs: Date.now(),
        verdict: { kind: 'admitted', durable: false, queuedAttempts: 1 },
        trackedReceiptAlgo: handle.lifecycle().receiptAlgo
    });
    setTimeout(() =>
        registry.record({
            kind: 'acknowledgement',
            msgId,
            carrier: 'rtc',
            atMs: Date.now(),
            mode: 'leader',
            confirmedHopPeerIds: [],
            unconfirmedHopPeerIds: [],
            expectedRecipientPeerIds: ['director-session'],
            confirmedRecipientPeerIds: ['director-session'],
            unconfirmedRecipientPeerIds: [],
            complete: true
        }), 2_000);
    return handle;
}

function getTraffic(): Extract<RallarBlackBoxTestCommand, { kind: 'parallel'; }> {
    const traffic = createAlmScaleRecipes(INPUT).recipes[1].commands.find((command) => command.kind === 'parallel');
    if (traffic?.kind !== 'parallel') {
        throw new Error('Missing player traffic');
    }
    return traffic;
}

it('starts all six generated shots on five-second offsets despite two-second leader ACKs', async () => {
    const native = await loadRuntime();
    await native.connect({
        connection: 'alm-scale-player',
        roomRef: GROUP,
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            applicationId: GROUP.applicationId,
            workspaceId: GROUP.workspaceId,
            username: 'Player',
            password: '',
            transport: 'messages.rtc',
            typeId: 'room.ar-eye-hunter.director.intent.v1',
            topicId: 'room.ar-eye-hunter.director'
        }
    });
    vi.stubGlobal('window', { __blackBoxRallar: native });
    const bridge = createSpaBrowserRallarRuntime();
    const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({ rallarRuntime: bridge, now: Date.now });
    const starts: ShotStart[] = [];
    facade.behavior.typedSend.mockImplementation(async (payload) => openShot(toScaleWirePayload(decodeJsonValue(payload)), starts));
    facade.behavior.directorStatus.mockReturnValue({
        roomId: GROUP.groupId,
        active: true,
        role: 'client',
        state: 'fresh',
        isDirector: false,
        isFresh: true,
        freshness: 'fresh',
        nowEpochMs: 1_000,
        appointment: {
            version: 1,
            mode: 'appointed-spa',
            sessionId: 'director-session',
            principalId: 'director-client',
            epoch: 1,
            appointedAtEpochMs: 1_000,
            heartbeatTtlMs: 60_000
        }
    });
    expect(await runtime.execute({ kind: 'director.status', commandId: 'alm-scale-player-ready-status', roomRef: GROUP, refresh: true })).toMatchObject({
        ok: true,
        value: { directorStatus: { appointment: { sessionId: 'director-session' } } }
    });
    const started = JSON.parse(JSON.stringify(createAlmScalePayload(INPUT, 'started')).replaceAll('{auth.sessionId}', 'director-session'));
    runtime.receiveRallarBrowserEvent({
        kind: 'message',
        connection: 'alm-scale-player',
        topic: 'rallar.browser.messages.rtc.message',
        data: { typeId: 'room.ar-eye-hunter.director.event.v1', payload: started }
    });
    const traffic = getTraffic();
    const window = traffic.groups[0].commands[0];
    if (window.kind !== 'parallel') {
        throw new Error('Missing player workload window');
    }
    // This focused proof ends before the distributed completion barrier; the cohort proof executes it.
    const execution = runtime.execute({
        ...traffic,
        groups: [{ ...traffic.groups[0], commands: [{ ...window, groups: [{ ...window.groups[0], commands: window.groups[0].commands.slice(0, 4) }] }] }]
    });
    await vi.runAllTimersAsync();
    const result = await execution;
    expect(starts.map((shot) => shot.atMs - 1_000)).toEqual([0, 5_000, 10_000, 15_000, 20_000, 25_000]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(new Set(starts.map((shot) => shot.msgId)).size).toBe(6);
    for (const [index, shot] of starts.entries()) {
        expect(shot.payload.payload).toMatchObject({
            senderId: facade.session.sessionId,
            seq: index + 1,
            payload: { shot: { sessionId: facade.session.sessionId, seq: index + 1 } }
        });
        expect(await native.readReceipts({ connection: 'alm-scale-player', handleId: `alm-scale-player-shot-${index + 1}` })).toMatchObject({
            handleId: `alm-scale-player-shot-${index + 1}`,
            state: 'acknowledged',
            expectedRecipientPeerIds: ['director-session'],
            confirmedRecipientPeerIds: ['director-session']
        });
    }
});

interface CohortPolicy {
    readonly shotAckMs: number | undefined;
    readonly admissionMs: number;
    readonly wrongLeader: boolean;
    readonly partialLeader: boolean;
    readonly cancelAtMs: number | undefined;
}

const NORMAL_POLICY: CohortPolicy = { shotAckMs: 2_000, admissionMs: 0, wrongLeader: false, partialLeader: false, cancelAtMs: undefined };

class ScaleActor {
    readonly agentId: string;
    readonly role: 'director' | 'player';
    readonly session: AuthSession;
    readonly registry = new BrowserRallarDeliveryRegistry({ nowMs: Date.now, retainTerminalMs: 60_000, maxEntries: 1_000, cancel: () => undefined });
    readonly native: BlackBoxRallarRuntime;
    readonly runtime: RallarBlackBoxBrowserTestRuntime;
    readonly recipe: RallarBlackBoxTestRecipe;
    readonly starts: ShotStart[] = [];
    private readonly cohort: ScaleCohort;

    constructor(cohort: ScaleCohort, index: number) {
        this.cohort = cohort;
        this.agentId = `actor-${index}`;
        this.role = index === 0 ? 'director' : 'player';
        this.session = { ...facade.session, sessionId: index === 0 ? 'director-session' : `player-${index}`, username: `Player ${index}` };
        this.recipe = replaceCommandPlaceholders(createAlmScaleRecipes(INPUT).recipes[index === 0 ? 0 : 1], {
            session: this.session,
            config: { runId: 'scale-proof', agentId: this.agentId, apiBaseUrl: 'https://api.example.test' },
            wsTicket: undefined
        });
        this.native = this.createNative();
        this.runtime = this.createBrowserRuntime();
        this.runtime.subscribe((state) => cohort.observeBarrier(this, state));
    }

    private createNative(): BlackBoxRallarRuntime {
        return createBlackBoxRallarRuntime({
            facade: {
                ...facade.rallar,
                session: () => this.session,
                auth: { ...facade.rallar.auth, login: async () => this.session, restore: () => this.session },
                messages: {
                    ...facade.rallar.messages,
                    room: <T>(definition: Parameters<BlackBoxBrowserMessagesDependency['room']>[0]) => ({
                        ...facade.rallar.messages.room<T>(definition),
                        send: async (payload: T) => this.cohort.send(this, toScaleWirePayload(decodeJsonValue(payload)))
                    })
                },
                deliveries: { ...facade.rallar.deliveries, getHandle: (msgId) => this.registry.getHandle(msgId) },
                peers: { ...facade.rallar.peers, session: () => this.session, getRoomLeaderSessionId: () => 'director-session' }
            },
            volatileLimits: new BlackBoxRallarVolatileLimits(),
            targetWindow: {},
            clock: { now: Date.now },
            readDocument: () => ({ timeOrigin: 1_000, origin: 'https://scale.example.test' }),
            delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        });
    }

    private createBrowserRuntime(): RallarBlackBoxBrowserTestRuntime {
        return createDefaultRallarBlackBoxBrowserTestRuntime({
            now: Date.now,
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: async () => {
                    throw new Error('Actor is connected through its native page before traffic');
                },
                send: async () => {
                    throw new Error('Scale uses typed messages.send');
                },
                refreshRoom: async () => undefined,
                health: async () => this.native.health(),
                sendMessage: async (send) => this.native.sendMessage(requireBlackBoxRallarInput(decodeBlackBoxRallarMessageSendInput(send))),
                observeDelivery: async (observe) => this.native.observeDelivery(requireBlackBoxRallarInput(decodeBlackBoxRallarDeliveryObserveInput(observe))),
                readReceipts: async (receipt) => this.native.readReceipts(requireBlackBoxRallarInput(decodeBlackBoxRallarDeliveryHandleInput(receipt))),
                cancelDelivery: async (cancel) => this.native.cancelDelivery(requireBlackBoxRallarInput(decodeBlackBoxRallarDeliveryHandleInput(cancel))),
                readAlmUsage: async () => ({
                    own: { admissions: 6, bytes: 3_000 },
                    inbound: { admissions: 84, bytes: 42_000 },
                    usage: { admissions: 90, bytes: 45_000, oldestAgeMs: 25_000, tracks: 1 },
                    limits: { maxAdmissions: 1_000, maxBytes: 4_194_304, maxAgeMs: 300_000, maxTracks: 64 },
                    overloaded: false,
                    orderingTracks: 85
                }),
                readCongestionCounters: async () => ({ dropped: 0, deferred: 0, handedOver: 0 }),
                readStorageCounters: async (command) =>
                    this.native.readStorageCounters(requireBlackBoxRallarInput(decodeBlackBoxRallarStorageCountersInput(command))),
                close: async () => this.native.close(),
                director: this.createDirectorPort()
            }
        });
    }

    private createDirectorPort() {
        return {
            appoint: async () => {
                throw new Error('Appointment is established before traffic');
            },
            resign: async () => {
                throw new Error('No resignation in scale traffic');
            },
            relayStart: async () => {
                throw new Error('No relay control in scale traffic');
            },
            relayStop: async () => {
                throw new Error('No relay control in scale traffic');
            },
            intent: async () => {
                throw new Error('Scale uses typed shot sends');
            },
            syncRequest: async () => {
                throw new Error('No sync request in scale traffic');
            },
            status: async () => ({ directorStatus: { active: true, appointment: { sessionId: 'director-session' } } })
        };
    }

    async connect(): Promise<void> {
        await this.native.connect({
            connection: `alm-scale-${this.role}`,
            roomRef: GROUP,
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                applicationId: GROUP.applicationId,
                workspaceId: GROUP.workspaceId,
                username: this.session.username,
                password: 'test-password',
                transport: 'messages.rtc',
                typeId: 'room.ar-eye-hunter.director.intent.v1',
                topicId: 'room.ar-eye-hunter.director'
            }
        });
        expect(await this.runtime.execute({ kind: 'director.status', commandId: `alm-scale-${this.role}-ready-status`, roomRef: GROUP, refresh: true }))
            .toMatchObject({ ok: true });
        expect(await this.runtime.execute({ kind: 'storage.counters', commandId: `alm-scale-${this.role}-storage-reset`, reset: true })).toMatchObject({
            ok: true
        });
    }

    run(): Promise<RallarBlackBoxTestResult> {
        const trafficIndex = this.recipe.commands.findIndex((command) => command.kind === 'parallel');
        return this.runtime.execute({
            kind: 'recipe.run',
            commandId: `${this.agentId}-run`,
            recipe: { ...this.recipe, commands: this.recipe.commands.slice(trafficIndex) }
        });
    }
}

class ScaleCohort {
    readonly actors: readonly ScaleActor[];
    readonly policy: CohortPolicy;
    readonly arrivals = new Map<string, Set<string>>();
    readonly lifecycle: ScaleWirePayload[] = [];
    private readonly seenArrivals = new Set<string>();

    constructor(policy: CohortPolicy) {
        this.policy = policy;
        this.actors = Array.from({ length: 15 }, (_, index) => new ScaleActor(this, index));
    }

    observeBarrier(actor: ScaleActor, state: RallarBlackBoxTestState): void {
        for (const event of state.events) {
            const arrival = decodeBarrierArrival(event).right;
            const key = `${actor.agentId}:${event.eventId}`;
            if (arrival === undefined || this.seenArrivals.has(key)) {
                continue;
            }
            this.seenArrivals.add(key);
            const arrived = this.arrivals.get(arrival.barrierId) ?? new Set<string>();
            arrived.add(actor.agentId);
            this.arrivals.set(arrival.barrierId, arrived);
            if (arrived.size === this.actors.length) {
                this.releaseBarrier(arrival.barrierId, [...arrived]);
            }
        }
    }

    private releaseBarrier(barrierId: string, arrivedAgentIds: readonly string[]): void {
        for (const actor of this.actors) {
            actor.runtime.recordEvent(
                toBarrierResolvedEvent({
                    kind: 'barrier',
                    protocolVersion: 1,
                    runId: 'scale-proof',
                    agentId: actor.agentId,
                    barrierId,
                    resolution: { outcome: 'released', arrivedAgentIds }
                })
            );
        }
    }

    send(actor: ScaleActor, payload: ScaleWirePayload): RallarMessageHandle {
        const msgId = `${actor.agentId}-message-${actor.starts.length + 1}`;
        const handle = actor.registry.open({
            id: { v: 3, msgId, ts: Date.now(), senderId: actor.session.sessionId },
            route: { topicId: 'room.ar-eye-hunter.director', contextId: GROUP.groupId, resourceId: GROUP.groupId },
            payload: { typeId: payload.typeId, contentType: 'application/json', resource: JSON.stringify(payload) },
            delivery: { ack: actor.role === 'player' ? 'group-leader' : 'all-logical-recipients', reliability: 'at-least-once' },
            constraints: { expiresAtMs: Date.now() + 30_000 }
        }, 'rtc');
        actor.starts.push({ atMs: Date.now(), msgId, payload });
        const admit = () => {
            actor.registry.record({
                kind: 'admission',
                msgId,
                carrier: 'rtc',
                atMs: Date.now(),
                verdict: { kind: 'admitted', durable: false, queuedAttempts: 1 },
                trackedReceiptAlgo: handle.lifecycle().receiptAlgo
            });
            this.deliver(actor, payload);
            const ackMs = actor.role === 'player' ? this.policy.shotAckMs : 0;
            if (ackMs !== undefined) {
                setTimeout(() => this.acknowledge(actor, msgId), ackMs);
            }
        };
        if (actor.role === 'player' && this.policy.admissionMs > 0) {
            setTimeout(admit, this.policy.admissionMs);
        }
        else {
            admit();
        }
        return handle;
    }

    private deliver(sender: ScaleActor, payload: ScaleWirePayload): void {
        if (sender.role === 'director') {
            this.lifecycle.push(payload);
        }
        for (const receiver of this.actors.filter((actor) => sender.role === 'director' ? actor.role === 'player' : actor.role === 'director')) {
            receiver.runtime.receiveRallarBrowserEvent({
                kind: 'message',
                topic: 'rallar.browser.messages.rtc.message',
                connection: `alm-scale-${receiver.role}`,
                data: { typeId: payload.typeId, payload }
            });
        }
    }

    private acknowledge(actor: ScaleActor, msgId: string): void {
        const expected = actor.role === 'director'
            ? this.actors.slice(1).map((player) => player.session.sessionId)
            : [this.policy.wrongLeader ? 'wrong-director' : 'director-session'];
        const unconfirmed = this.policy.partialLeader && actor.role === 'player' ? expected : [];
        const confirmed = expected.filter((sessionId) => !unconfirmed.includes(sessionId));
        actor.registry.record({
            kind: 'acknowledgement',
            msgId,
            carrier: 'rtc',
            atMs: Date.now(),
            mode: actor.role === 'director' ? 'receiver' : 'leader',
            confirmedHopPeerIds: [],
            unconfirmedHopPeerIds: [],
            expectedRecipientPeerIds: expected,
            confirmedRecipientPeerIds: confirmed,
            unconfirmedRecipientPeerIds: unconfirmed,
            complete: unconfirmed.length === 0
        });
    }

    async run(): Promise<readonly RallarBlackBoxTestResult[]> {
        for (const actor of this.actors) {
            await actor.connect();
        }
        const execution = Promise.all(this.actors.map((actor) => actor.run()));
        if (this.policy.cancelAtMs !== undefined) {
            setTimeout(() => {
                for (const actor of this.actors) {
                    void actor.runtime.execute({ kind: 'recipe.cancel', commandId: `${actor.agentId}-cancel`, reason: 'cancel cohort' });
                }
            }, this.policy.cancelAtMs);
        }
        await vi.runAllTimersAsync();
        return await execution;
    }

    evaluate(results: readonly RallarBlackBoxTestResult[]) {
        const scale = createAlmScaleRecipes(INPUT);
        const participants = this.actors.map((actor) => ({ agentId: actor.agentId, roles: [actor.role === 'director' ? 'sender' : 'receiver'] }));
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
            recipeEvidence: this.actors.map((actor, index) => ({
                agentId: actor.agentId,
                recipeId: actor.recipe.recipeId,
                hasResult: true,
                resultValue: results[index].value!
            })),
            recipeResults: this.actors.map((actor, index) => ({
                agentId: actor.agentId,
                recipeKey: actor.agentId,
                state: results[index].ok ? 'passed' : 'failed'
            }))
        })!;
    }
}

function toScaleWirePayload(value: RallarBlackBoxTestJsonValue | undefined): ScaleWirePayload {
    if (!isJsonRecordValue(value) || typeof value.typeId !== 'string' || !('payload' in value)) {
        throw new TypeError('Typed send did not carry a message payload');
    }
    const payload = decodeJsonValue(value.payload);
    if (payload === undefined) {
        throw new TypeError('Typed send did not carry a JSON payload');
    }
    return { ...value, typeId: value.typeId, payload };
}

it('passes all 73 assertions from real generated 15-participant traffic and final result trees', async () => {
    const cohort = new ScaleCohort(NORMAL_POLICY);
    const results = await cohort.run();
    expect(results.map((result) => ({ ok: result.ok, error: result.error }))).toEqual(Array.from({ length: 15 }, () => ({ ok: true, error: undefined })));
    expect(cohort.actors.slice(1).flatMap((actor) => actor.starts)).toHaveLength(84);
    expect(cohort.lifecycle).toHaveLength(2);
    expect(cohort.arrivals.get('alm-scale-shots-complete')?.size).toBe(15);
    const assertions = cohort.evaluate(results);
    expect(assertions).toHaveLength(73);
    expect(assertions.filter((assertion) => !assertion.ok)).toEqual([]);
    expect(assertions.every((assertion) => assertion.perAgent.every((row) => row.evidence === 'resolved'))).toBe(true);
});

it.each([
    { name: 'nine-second shot ACKs', policy: { ...NORMAL_POLICY, shotAckMs: 9_000 } },
    { name: 'missing shot ACKs', policy: { ...NORMAL_POLICY, shotAckMs: undefined } },
    { name: 'slow admission', policy: { ...NORMAL_POLICY, admissionMs: 6_000 } },
    { name: 'wrong leader receipts', policy: { ...NORMAL_POLICY, wrongLeader: true } },
    { name: 'partial leader receipts', policy: { ...NORMAL_POLICY, partialLeader: true } },
    { name: 'cancellation during ACK and pending offsets', policy: { ...NORMAL_POLICY, cancelAtMs: 1_000 } },
    { name: 'cancellation after later offsets start', policy: { ...NORMAL_POLICY, cancelAtMs: 7_000 } }
])('keeps $name failed without an end event or late resurrection', async ({ policy }) => {
    const cohort = new ScaleCohort(policy);
    const results = await cohort.run();
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(cohort.lifecycle).toHaveLength(1);
    expect(cohort.arrivals.get('alm-scale-shots-complete')?.size ?? 0).toBeLessThan(15);
    expect(cohort.evaluate(results).some((assertion) => !assertion.ok)).toBe(true);
    for (const actor of cohort.actors.slice(1)) {
        if (policy.cancelAtMs !== undefined) {
            expect(actor.starts.every((shot) => shot.atMs < 1_000 + policy.cancelAtMs!)).toBe(true);
            expect(results[cohort.actors.indexOf(actor)].status).toBe('cancelled');
        }
        for (const shot of actor.starts) {
            actor.registry.record({
                kind: 'acknowledgement',
                msgId: shot.msgId,
                carrier: 'rtc',
                atMs: Date.now(),
                mode: 'leader',
                confirmedHopPeerIds: [],
                unconfirmedHopPeerIds: [],
                expectedRecipientPeerIds: ['director-session'],
                confirmedRecipientPeerIds: ['director-session'],
                unconfirmedRecipientPeerIds: [],
                complete: true
            });
        }
    }
    await vi.runAllTimersAsync();
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(cohort.lifecycle).toHaveLength(1);
});
