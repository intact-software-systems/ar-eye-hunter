// @vitest-environment happy-dom
import { act, createElement, type RefObject, type SetStateAction } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useArenaDirectorMessageHandler } from '../../../apps/ar-eye-hunter-v1/src/game/arena-runtime/messages/use-arena-director-message-handler.ts';
import {
    useArenaPeerMessageHandlers,
    type ArenaPeerMessageHandlers
} from '../../../apps/ar-eye-hunter-v1/src/game/arena-runtime/messages/use-arena-peer-message-handlers.ts';
import { useArenaStateAcceptance, type ArenaStateAcceptance } from '../../../apps/ar-eye-hunter-v1/src/game/arena-runtime/state/use-arena-state-acceptance.ts';
import type { ArenaRallarGameMatchHandle } from '../../../apps/ar-eye-hunter-v1/src/game/rallar-game-match-adapter.ts';
import {
    createInitialArenaState,
    createInitialVitalsState,
    finishArenaMatchIfDue,
    resolveEyeAttackCue,
    resolvePickupIntent,
    resolvePlayerHitIntent,
    spawnWeaponPickup,
    startArenaMatch,
    toArenaSnapshot,
    upsertPlayerPose,
    type ArenaSimulationState
} from '../../../apps/ar-eye-hunter-v1/src/game/simulation.ts';
import type {
    ArenaEvent,
    ArenaSnapshot,
    GameRealtimeMessage,
    PickupAccepted,
    PlayerHitAccepted,
    PlayerPose,
    RemotePlayer
} from '../../../apps/ar-eye-hunter-v1/src/game/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

interface IncomingFixture {
    readonly snapshot: DeferredState<ArenaSnapshot | undefined>;
    readonly activeEvent: DeferredState<ArenaEvent | undefined>;
    readonly events: DeferredState<readonly ArenaEvent[]>;
    readonly hits: DeferredState<readonly PlayerHitAccepted[]>;
    readonly pickups: DeferredState<readonly PickupAccepted[]>;
    readonly players: DeferredState<ReadonlyMap<string, RemotePlayer>>;
    readonly matchRef: RefObject<Pick<ArenaRallarGameMatchHandle, 'publishEvent' | 'publishSnapshot'> | undefined>;
    readonly snapshotRef: RefObject<ArenaSnapshot | undefined>;
    readonly roomIdRef: RefObject<string | undefined>;
    clock: number;
}

interface IncomingOwners {
    readonly acceptance: ArenaStateAcceptance;
    readonly director: ReturnType<typeof useArenaDirectorMessageHandler>;
    readonly peers: ArenaPeerMessageHandlers;
    unmount(): Promise<void>;
}

interface IncomingMessages {
    readonly snapshot: ArenaSnapshot;
    readonly start: GameRealtimeMessage;
    readonly end: GameRealtimeMessage;
    readonly event: GameRealtimeMessage;
    readonly hit: GameRealtimeMessage;
    readonly pickup: GameRealtimeMessage;
    readonly eye: GameRealtimeMessage;
    readonly motion: GameRealtimeMessage;
}

class DeferredState<
    T extends
        | ArenaSnapshot
        | ArenaEvent
        | readonly ArenaEvent[]
        | readonly PlayerHitAccepted[]
        | readonly PickupAccepted[]
        | ReadonlyMap<string, RemotePlayer>
        | undefined,
> {
    private readonly pending: SetStateAction<T>[] = [];
    value: T;
    constructor(value: T) {
        this.value = value;
    }
    readonly set = (update: SetStateAction<T>): void => {
        this.pending.push(update);
    };
    flush(): void {
        for (const update of this.pending.splice(0)) {
            this.value = typeof update === 'function' ? update(this.value) : update;
        }
    }
}

let mounted: IncomingOwners | undefined;
afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
    vi.restoreAllMocks();
});

for (const kind of ['start', 'end', 'event', 'hit', 'pickup', 'eye', 'motion'] as const) {
    describe(`incoming ${kind} publication`, () => {
        it.each([true, false])('publishes only while the captured owner remains current (%s)', async (current) => {
            const messages = incomingMessages();
            const fixture = incomingFixture(messages.snapshot);
            mounted = await mountIncoming(fixture);
            let valid = true;
            if (kind === 'motion') {
                mounted.peers.acceptMotionMessage('attacker', messages.motion, () => valid);
            }
            else {
                mounted.director(messages[kind], () => valid);
            }
            valid = current;
            if (!current) {
                replaceRoom(fixture);
            }
            const previous = fixture.snapshot.value;
            flushIncoming(fixture);
            if (current) {
                if (kind === 'motion') {
                    expect([...fixture.players.value.keys()]).toEqual(['attacker']);
                }
                else if (kind === 'event') {
                    expect(fixture.events.value.at(-1)?.id).toBe('incoming-event');
                    expect(fixture.activeEvent.value?.id).toBe('incoming-event');
                }
                else {
                    expect(fixture.snapshot.value?.revision).toBeGreaterThan(messages.snapshot.revision);
                }
            }
            else {
                expect(fixture.snapshot.value).toBe(previous);
                expect(fixture.snapshotRef.current).toBe(previous);
                expect(fixture.players.value.size).toBe(0);
                expect(fixture.activeEvent.value).toBeUndefined();
                expect(fixture.events.value).toEqual([]);
                expect(fixture.hits.value).toEqual([]);
                expect(fixture.pickups.value).toEqual([]);
            }
        });
    });
}

describe('accepted state derived publication', () => {
    it.each(['hit', 'pickup', 'eye'] as const)('fences delayed %s event publications', async (kind) => {
        const messages = incomingMessages();
        const fixture = incomingFixture(messages.snapshot);
        mounted = await mountIncoming(fixture);
        let valid = true;
        mounted.director(messages[kind], () => valid);
        fixture.clock = 99999;
        fixture.snapshot.flush();
        expect(fixture.snapshotRef.current).toBe(fixture.snapshot.value);
        valid = false;
        replaceRoom(fixture);
        flushIncoming(fixture);
        expect(fixture.activeEvent.value).toBeUndefined();
        expect(fixture.events.value).toEqual([]);
        expect(fixture.hits.value).toEqual([]);
        expect(fixture.pickups.value).toEqual([]);
    });

    it.each(['hit', 'pickup', 'eye'] as const)('captures the supplied clock before deferred %s projection', async (kind) => {
        const messages = incomingMessages();
        const fixture = incomingFixture(messages.snapshot);
        mounted = await mountIncoming(fixture);
        mounted.director(messages[kind], () => true);
        fixture.clock = 99999;
        flushIncoming(fixture);
        expect(fixture.snapshot.value?.sentAtEpochMs).toBe(5000);
    });

    it('allows a fresh replacement owner after ignoring old queued work', async () => {
        const messages = incomingMessages();
        const fixture = incomingFixture(messages.snapshot);
        mounted = await mountIncoming(fixture);
        let previousValid = true;
        mounted.director(messages.start, () => previousValid);
        previousValid = false;
        replaceRoom(fixture);
        mounted.director(messages.event, () => true);
        flushIncoming(fixture);
        expect(fixture.snapshot.value?.roomId).toBe('replacement');
        expect(fixture.snapshot.value?.match).toBeUndefined();
        expect(fixture.events.value.map((event) => event.id)).toEqual(['incoming-event']);
        expect(fixture.activeEvent.value?.id).toBe('incoming-event');
    });
});

describe('accepted match-start lifetime', () => {
    it.each(['current', 'replacement', 'network-end'] as const)('retains its publisher and supplied time across the event await (%s)', async (end) => {
        vi.spyOn(Date, 'now').mockReturnValue(5001);
        const messages = incomingMessages();
        const fixture = incomingFixture(messages.snapshot);
        const eventStarted = Promise.withResolvers<void>();
        const eventDone = Promise.withResolvers<void>();
        const snapshots: ArenaSnapshot[] = [];
        let valid = true;
        fixture.matchRef.current = {
            publishEvent: async () => {
                eventStarted.resolve();
                await eventDone.promise;
                return { status: 'sent' };
            },
            publishSnapshot: async (snapshot) => {
                snapshots.push(snapshot);
                return { status: 'sent' };
            }
        };
        mounted = await mountIncoming(fixture);
        const completion = mounted.acceptance.acceptMatchStartIntent({
            matchId: 'accepted-start',
            directorSessionId: 'attacker',
            durationMs: 60000,
            sentAtEpochMs: 1000
        }, () => valid);
        await eventStarted.promise;
        fixture.clock = 99999;
        if (end === 'replacement') {
            replaceRoom(fixture);
            fixture.matchRef.current = {
                publishEvent: async () => ({ status: 'sent' }),
                publishSnapshot: async (snapshot) => {
                    snapshots.push(snapshot);
                    return { status: 'sent' };
                }
            };
        }
        if (end !== 'current') {
            valid = false;
        }
        eventDone.resolve();
        await completion;
        flushIncoming(fixture);
        if (end === 'current') {
            expect(snapshots.map((snapshot) => snapshot.match?.startedAtEpochMs)).toEqual([5000]);
            expect(fixture.snapshot.value?.sentAtEpochMs).toBe(5000);
        }
        else {
            expect(snapshots).toEqual([]);
            if (end === 'replacement') {
                expect(fixture.snapshotRef.current?.roomId).toBe('replacement');
            }
        }
    });

    it('binds an unscoped bootstrap snapshot to the current room', async () => {
        const fixture = incomingFixture({ ...incomingMessages().snapshot, roomId: undefined });
        const snapshots: ArenaSnapshot[] = [];
        fixture.matchRef.current = {
            publishEvent: async () => ({ status: 'sent' }),
            publishSnapshot: async (snapshot) => {
                snapshots.push(snapshot);
                return { status: 'sent' };
            }
        };
        mounted = await mountIncoming(fixture);
        await mounted.acceptance.acceptMatchStartIntent(
            { matchId: 'bootstrap-start', directorSessionId: 'attacker', durationMs: 60000, sentAtEpochMs: 1000 },
            () => true
        );
        flushIncoming(fixture);
        expect(fixture.snapshotRef.current?.roomId).toBe('arena-1');
        expect(fixture.snapshot.value?.match?.matchId).toBe('bootstrap-start');
        expect(snapshots.map((snapshot) => snapshot.roomId)).toEqual(['arena-1']);
    });

    it('rejects a match-start against an explicitly prior-room snapshot', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(5001);
        const fixture = incomingFixture({ ...incomingMessages().snapshot, roomId: 'prior-room' });
        const events: GameRealtimeMessage[] = [];
        fixture.matchRef.current = {
            publishEvent: async (event) => {
                events.push(event);
                return { status: 'sent' };
            },
            publishSnapshot: async () => ({ status: 'sent' })
        };
        mounted = await mountIncoming(fixture);
        await mounted.acceptance.acceptMatchStartIntent(
            { matchId: 'wrong-start', directorSessionId: 'attacker', durationMs: 60000, sentAtEpochMs: 1000 },
            () => true
        );
        flushIncoming(fixture);
        expect(fixture.snapshotRef.current?.match).toBeUndefined();
        expect(events).toEqual([]);
    });
});

function incomingFixture(snapshot: ArenaSnapshot): IncomingFixture {
    return {
        snapshot: new DeferredState<ArenaSnapshot | undefined>(snapshot),
        activeEvent: new DeferredState<ArenaEvent | undefined>(undefined),
        events: new DeferredState<readonly ArenaEvent[]>([]),
        hits: new DeferredState<readonly PlayerHitAccepted[]>([]),
        pickups: new DeferredState<readonly PickupAccepted[]>([]),
        players: new DeferredState<ReadonlyMap<string, RemotePlayer>>(new Map()),
        matchRef: { current: undefined },
        snapshotRef: { current: snapshot },
        roomIdRef: { current: 'arena-1' },
        clock: 5000
    };
}

async function mountIncoming(fixture: IncomingFixture): Promise<IncomingOwners> {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let owners: Omit<IncomingOwners, 'unmount'> | undefined;
    function Harness() {
        const input = {
            nowMs: () => fixture.clock,
            arenaMatchRef: fixture.matchRef,
            arenaSnapshotRef: fixture.snapshotRef,
            roomIdRef: fixture.roomIdRef,
            setArenaSnapshot: fixture.snapshot.set,
            setActiveEvent: fixture.activeEvent.set,
            setRemoteEvents: fixture.events.set,
            setPickupAcceptances: fixture.pickups.set,
            setRemotePlayerHits: fixture.hits.set,
            sessionRef: { current: undefined },
            setRemotePlayers: fixture.players.set,
            setRemoteShots: () => {}
        };
        const acceptance = useArenaStateAcceptance(input);
        owners = {
            acceptance,
            director: useArenaDirectorMessageHandler({ ...input, ...acceptance }),
            peers: useArenaPeerMessageHandlers(input)
        };
        return null;
    }
    await act(async () => root.render(createElement(Harness)));
    if (!owners) {
        throw new Error('The incoming owners did not mount.');
    }
    return {
        ...owners,
        unmount: async () => {
            await act(async () => root.unmount());
            container.remove();
        }
    };
}

function replaceRoom(fixture: IncomingFixture): void {
    const snapshot = toArenaSnapshot(createInitialArenaState(12, 1000), 'replacement', 1000);
    fixture.snapshot.value = snapshot;
    fixture.snapshotRef.current = snapshot;
    fixture.roomIdRef.current = 'replacement';
    fixture.activeEvent.value = undefined;
    fixture.events.value = [];
    fixture.hits.value = [];
    fixture.pickups.value = [];
    fixture.players.value = new Map();
}

function flushIncoming(fixture: IncomingFixture): void {
    fixture.snapshot.flush();
    fixture.activeEvent.flush();
    fixture.events.flush();
    fixture.hits.flush();
    fixture.pickups.flush();
    fixture.players.flush();
}

function incomingMessages(): IncomingMessages {
    const now = 1000;
    const initial = spawnWeaponPickup(createInitialArenaState(44, now), now, 'audit-pea-shooter');
    const pickup = initial.pickups[0];
    const pose: PlayerPose = {
        sessionId: 'attacker',
        username: 'attacker',
        color: '#00ffaa',
        position: [0, 1.72, 0],
        rotation: [0, 0, 0],
        vitals: createInitialVitalsState(),
        score: 0,
        seq: 1,
        sentAtEpochMs: now
    };
    const state = upsertPlayerPose(
        upsertPlayerPose(upsertPlayerPose(initial, pose, now), {
            ...pose,
            sessionId: 'target',
            position: [0, 1.72, 9]
        }, now),
        { ...pose, sessionId: 'picker', position: pickup.position },
        now
    );
    const started = startArenaMatch(state, { matchId: 'incoming-match', directorSessionId: 'attacker', durationMs: 60000, sentAtEpochMs: now }, now);
    if (!started.accepted) {
        throw new Error('Incoming acceptance fixture did not resolve.');
    }
    const ended = finishArenaMatchIfDue(started.state, now + 60001);
    if (!ended.match) {
        throw new Error('Incoming match fixture did not finish.');
    }
    return {
        snapshot: toArenaSnapshot(state, 'arena-1', now),
        start: { protocol: 'ar-eye-hunter.v1', kind: 'director-match-started', accepted: started.acceptedMatch },
        end: {
            protocol: 'ar-eye-hunter.v1',
            kind: 'director-match-ended',
            accepted: {
                match: ended.match,
                revision: ended.revision,
                acceptedAtEpochMs: now + 60001
            }
        },
        event: {
            protocol: 'ar-eye-hunter.v1',
            kind: 'arena-event',
            event: { id: 'incoming-event', kind: 'spawn-eye', startsAtEpochMs: now, expiresAtEpochMs: 9000, revision: state.revision + 1, source: 'director' }
        },
        ...incomingCombatMessages(state, now),
        motion: { protocol: 'ar-eye-hunter.v1', kind: 'player-pose', pose }
    };
}

function incomingCombatMessages(state: ArenaSimulationState, now: number): Pick<IncomingMessages, 'hit' | 'pickup' | 'eye'> {
    const hit = resolvePlayerHitIntent(state, {
        shot: { sessionId: 'attacker', username: 'attacker', color: '#00ffaa', origin: [0, 1.72, 0], direction: [0, 0, 1], seq: 1, sentAtEpochMs: now },
        targetSessionId: 'target',
        predictedImpact: [0, 1.72, 9],
        sentAtEpochMs: now
    }, now);
    const picked = resolvePickupIntent(state, {
        pickupId: state.pickups[0].id,
        sessionId: 'picker',
        position: state.pickups[0].position,
        seq: 1,
        sentAtEpochMs: now
    }, now);
    const eye = resolveEyeAttackCue(state, {
        id: 'cue-1',
        targetId: state.targets[0].id,
        targetSessionId: 'target',
        origin: [0, 1.72, 0],
        aimPoint: [0, 1.72, 9],
        damage: 5,
        range: 50,
        coneRadians: 0.1,
        startsAtEpochMs: 500,
        firesAtEpochMs: now,
        expiresAtEpochMs: 2000,
        revision: state.revision
    }, now);
    if (!hit.accepted || !picked.accepted || !eye.accepted) {
        throw new Error('Incoming combat fixture did not resolve.');
    }
    return {
        hit: { protocol: 'ar-eye-hunter.v1', kind: 'director-player-hit-accepted', accepted: hit.acceptedHit },
        pickup: { protocol: 'ar-eye-hunter.v1', kind: 'director-pickup-accepted', accepted: picked.acceptedPickup },
        eye: { protocol: 'ar-eye-hunter.v1', kind: 'director-eye-attack-accepted', accepted: eye.acceptedAttack }
    };
}
