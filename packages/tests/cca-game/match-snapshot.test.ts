import {
    describe,
    expect,
    it
} from 'vitest';

import {
    createTownMatchSnapshot,
    decodeTownCheckpoint,
    decodeTownMatchSnapshot
} from '../../../apps/cca-2d/src/match/match-snapshot.ts';
import {
    computeTownMatchReady,
    computeTownMatchRecovery,
    computeTownMatchRoster,
    computeTownMatchStart,
    computeTownMatchTick,
    createTownMatch
} from '../../../apps/cca-2d/src/match/town-match.ts';
import { TownRoutes } from '../../../apps/cca-2d/src/town/routes.ts';
import { requestTownSpectacle } from '../../../apps/cca-2d/src/town/spectacles/rules.ts';
import { TOWN_BARBECUE } from '../../../apps/cca-2d/src/town/spectacles/state.ts';

const members = [
    { id: 'alice', sessionId: 'alice-session', displayName: 'Alice' },
    { id: 'bob', sessionId: 'bob-session', displayName: 'Bob' }
];

describe('network match snapshot boundary', () => {
    it('requires complete seat state and rejects contradictory deadlines and controller identities', () => {
        const lobby = createTownMatch('seats', [...members, { id: 'carol', sessionId: 'carol-session', displayName: 'Carol' }]).right!;
        const away = computeTownMatchRecovery({ state: { ...lobby, phase: 'playing' }, members: lobby.members.slice(1), departedIds: [], now: 2000 }).right!;
        expect(decodeTownMatchSnapshot(JSON.stringify(away)).right?.seats[0].expiresAtEpochMs).toBe(12000);
        for (
            const seats of [
                undefined,
                away.seats.slice(1),
                [away.seats[0], away.seats[0], away.seats[2]],
                [{ ...away.seats[0], expiresAtEpochMs: 0 }, ...away.seats.slice(1)],
                [{ ...away.seats[0], expiresAtEpochMs: Infinity }, ...away.seats.slice(1)],
                [{ ...away.seats[0], status: 'active', expiresAtEpochMs: 0 }, ...away.seats.slice(1)],
                [away.seats[0], { ...away.seats[1], sessionId: 'forged' }, away.seats[2]],
                [away.seats[0], { ...away.seats[1], status: 'observer', expiresAtEpochMs: 5000 }, away.seats[2]]
            ]
        ) {
            expect(decodeTownMatchSnapshot(JSON.stringify({ ...away, seats })).left).toBeDefined();
        }
        expect(decodeTownMatchSnapshot(JSON.stringify({ ...away, members: lobby.members })).left).toBeDefined();
    });

    it('preserves retired participants in a resumed checkpoint and rejects altered identities', () => {
        const lobby = createTownMatch('recovery', [...members, { id: 'carol', sessionId: 'carol-session', displayName: 'Carol' }]).right!;
        const recovered = computeTownMatchRecovery({ state: { ...lobby, phase: 'playing' }, members: lobby.members.slice(1), departedIds: [], now: 1000 })
            .right!;
        expect(decodeTownMatchSnapshot(JSON.stringify(recovered)).right).toEqual(recovered);
        expect(decodeTownMatchSnapshot(JSON.stringify({ ...recovered, participants: recovered.participants.slice(1) })).left).toBeDefined();
        expect(
            decodeTownMatchSnapshot(
                JSON.stringify({ ...recovered, participants: [recovered.participants[0], recovered.participants[0], recovered.participants[2]] })
            ).left
        ).toBeDefined();
    });
    it('restores a complete round without losing optional state or simulation values', () => {
        let state = createTownMatch('round', members).right!;
        for (const member of members) {
            state = computeTownMatchReady(state, { ...member, ready: true });
        }
        state = computeTownMatchStart(state);
        let town = requestTownSpectacle(state.town, { kind: 'fire', origin: TOWN_BARBECUE, witnesses: ['apples'] });
        town = requestTownSpectacle(town, { kind: 'poop', origin: { x: 2, z: -2 }, witnesses: [] });
        town = requestTownSpectacle(town, { kind: 'vomit', origin: { x: -12, z: -3.5 }, witnesses: [] });
        state = { ...state, town: { ...town, heat: 6 } };
        const routes = new TownRoutes();
        for (let tick = 0; tick < 5490; tick++) {
            state = computeTownMatchTick({ state, routes, inputs: [], now: tick * 1000 / 30 });
            if (tick % 150 === 0 || tick === 5489) {
                const decoded = decodeTownMatchSnapshot(JSON.stringify(state));
                expect(decoded.left).toBeUndefined();
                expect(decoded.right).toEqual(state);
                state = decoded.right!;
            }
        }
        expect(state.phase).toBe('finished');
        expect(state.results).toHaveLength(2);
        expect(state.town.spectacles.fires).toBe(1);
        expect(state.town.spectacles.bombs).toBe(1);
        expect(state.town.spectacles.dinners).toBe(1);
        expect(state.town.raid.bonuses).toBe(1);
        const departed = computeTownMatchRoster(state, [members[0]]).right!;
        expect(decodeTownMatchSnapshot(JSON.stringify(departed)).right?.results).toEqual(state.results);
        const empty = computeTownMatchRoster(state, []).right!;
        expect(decodeTownMatchSnapshot(JSON.stringify(empty)).right?.results).toEqual(state.results);
    });

    it('binds acknowledgements to exact snapshot bytes and match identity', async () => {
        const state = createTownMatch('round', members).right!;
        const encoded = (await createTownMatchSnapshot(state, crypto.subtle)).right!;
        const checkpoint = { ...encoded, epoch: 1, sequence: 1, matchId: 'round' };
        expect((await decodeTownCheckpoint(checkpoint, crypto.subtle)).right?.state).toEqual(state);
        const changed = { ...checkpoint, snapshot: checkpoint.snapshot.replace('Alice', 'Eve') };
        expect((await decodeTownCheckpoint(changed, crypto.subtle)).left).toBeDefined();
        expect((await decodeTownCheckpoint({ ...checkpoint, matchId: 'other-round' }, crypto.subtle)).left).toBeDefined();
        const unavailable = {
            digest: async () => {
                throw new Error('Digest unavailable');
            }
        };
        expect((await decodeTownCheckpoint(checkpoint, unavailable)).left).toBeDefined();
        expect((await createTownMatchSnapshot(state, unavailable)).left).toBeDefined();
    });

    it('preserves an interrupted empty lobby without inventing a participant', () => {
        const lobby = createTownMatch('empty', [members[0]]).right!;
        const empty = computeTownMatchRoster(lobby, []).right!;
        expect(decodeTownMatchSnapshot(JSON.stringify(empty)).right).toEqual(empty);
    });

    it('refuses missing nested state, unsupported variants, injected fields and unbounded values', () => {
        const state = createTownMatch('round', members).right!;
        const invalid = [
            { ...state, tick: -1 },
            { ...state, phase: 'hacked' },
            { ...state, town: { ...state.town, raid: { phase: 'active' } } },
            { ...state, town: { ...state.town, companion: { x: 1, z: 2 } } },
            { ...state, players: [{ ...state.players[0], score: Infinity }, state.players[1]] },
            { ...state, players: [{ ...state.players[0], x: 1e100 }, state.players[1]] },
            { ...state, players: [{ ...state.players[0], clouds: Array(1000).fill({ id: 1, x: 0, z: 0, age: 0 }) }] },
            { ...state, town: { ...state.town, npcs: [{ ...state.town.npcs[0], mode: 'teleport' }] } },
            { ...state, injected: true }
        ];
        for (const snapshot of invalid) {
            expect(decodeTownMatchSnapshot(JSON.stringify(snapshot)).left).toBeDefined();
        }
        expect(decodeTownMatchSnapshot('{')).toMatchObject({ left: expect.any(Array) });
        expect(decodeTownMatchSnapshot(' '.repeat(300_000)).left).toBeDefined();
    });

    it('rejects phase clocks that would restart or overrun the fixed-length round', () => {
        const state = createTownMatch('round', members).right!;
        for (
            const snapshot of [
                { ...state, phase: 'playing', tick: 5400, remainingTicks: 0 },
                { ...state, phase: 'playing', countdownTicks: 10 },
                { ...state, tick: 1, remainingTicks: 5399 },
                { ...state, phase: 'countdown', countdownTicks: 0 },
                { ...state, phase: 'countdown', countdownTicks: 10, tick: 1, remainingTicks: 5399 },
                { ...state, countdownTicks: 10 }
            ]
        ) {
            expect(decodeTownMatchSnapshot(JSON.stringify(snapshot)).left).toBeDefined();
        }
    });

    it('rejects duplicate identities, missing fixed town entities and inconsistent round results', () => {
        const state = createTownMatch('round', members).right!;
        for (
            const snapshot of [
                { ...state, members: [state.members[0], state.members[0]] },
                { ...state, players: [state.players[0], state.players[0]] },
                { ...state, town: { ...state.town, shops: state.town.shops.slice(1) } },
                { ...state, town: { ...state.town, objects: state.town.objects.map((object) => ({ ...object, x: 0 })) } },
                { ...state, town: { ...state.town, personalities: state.town.personalities.map((actor) => ({ ...actor, home: { x: 0, z: 0 } })) } },
                { ...state, phase: 'finished', remainingTicks: 0, results: [] }
            ]
        ) {
            expect(decodeTownMatchSnapshot(JSON.stringify(snapshot)).left).toBeDefined();
        }
    });
});
