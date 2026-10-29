import { describe, expect, it } from 'vitest';

import {
    changeRallarGameRematchSettings,
    createRallarGameRematch,
    evaluateRallarGameRematchStart,
    isRallarGameRematch,
    setRallarGameRematchReady,
    type RallarGameRematch
} from '@shared/rallar-game/rematch.ts';

const preparation: RallarGameRematch = {
    completedGameId: 'round-1',
    settingsKey: 'duration:60000',
    players: [
        { sessionId: 'alice-session', ready: true, participationKey: 'alice-member-1' },
        { sessionId: 'bob-session', ready: false }
    ]
};

const startAuthority = {
    completedGameId: 'round-1',
    settingsKey: 'duration:60000',
    actorSessionId: 'alice-session',
    leaderSessionId: 'alice-session',
    participants: [
        { sessionId: 'alice-session', participationKey: 'alice-member-1' },
        { sessionId: 'bob-session', participationKey: 'bob-member-1' },
        { sessionId: 'visitor-session', participationKey: 'visitor-member-1' }
    ]
};

const bobReady = {
    completedGameId: 'round-1',
    settingsKey: 'duration:60000',
    sessionId: 'bob-session',
    participationKey: 'bob-member-1',
    ready: true
};

describe('coordinated game rematch', () => {
    it('starts with unconfirmed participants and no inherited consent', () => {
        expect(
            createRallarGameRematch({
                completedGameId: 'round-1',
                settingsKey: 'duration:60000',
                participantSessionIds: ['bob-session', 'alice-session'],
                capacity: 4
            }).right
        )
            .toEqual({
                completedGameId: 'round-1',
                settingsKey: 'duration:60000',
                players: [
                    { sessionId: 'alice-session', ready: false },
                    { sessionId: 'bob-session', ready: false }
                ]
            });
    });

    it('requires every present candidate, lets the leader start, and never enrolls a room visitor implicitly', () => {
        expect(evaluateRallarGameRematchStart(preparation, startAuthority).left?.code).toBe('players-not-ready');
        const confirmed = setRallarGameRematchReady({
            preparation: preparation,
            assignment: bobReady,
            participants: startAuthority.participants,
            capacity: 4
        }).right!;
        expect(evaluateRallarGameRematchStart(confirmed, startAuthority).right)
            .toEqual(['alice-session', 'bob-session']);
        expect(preparation.players[1].ready).toBe(false);
    });

    it('treats repeated readiness as an assignment and cancellation blocks start again', () => {
        const first = setRallarGameRematchReady({
            preparation: preparation,
            assignment: bobReady,
            participants: startAuthority.participants,
            capacity: 4
        }).right!;
        const repeated = setRallarGameRematchReady({
            preparation: first,
            assignment: bobReady,
            participants: startAuthority.participants,
            capacity: 4
        }).right!;
        expect(repeated).toEqual(first);
        const cancelled = setRallarGameRematchReady({
            preparation: repeated,
            assignment: { ...bobReady, ready: false },
            participants: startAuthority.participants,
            capacity: 4
        }).right!;
        expect(evaluateRallarGameRematchStart(cancelled, startAuthority).left?.code).toBe('players-not-ready');
    });

    it('excludes expired or non-player sessions, preserving consent for a same-session reconnect', () => {
        const confirmed = setRallarGameRematchReady({ preparation, assignment: bobReady, participants: startAuthority.participants, capacity: 4 }).right!;
        expect(
            evaluateRallarGameRematchStart(confirmed, {
                ...startAuthority,
                participants: [{ sessionId: 'alice-session', participationKey: 'alice-member-1' }]
            }).right
        ).toEqual(['alice-session']);
        expect(evaluateRallarGameRematchStart(confirmed, startAuthority).right)
            .toEqual(['alice-session', 'bob-session']);
        expect(evaluateRallarGameRematchStart(preparation, startAuthority).left?.code).toBe('players-not-ready');
    });

    it('requires an eligible leader who has personally confirmed', () => {
        expect(
            evaluateRallarGameRematchStart(preparation, {
                ...startAuthority,
                actorSessionId: 'bob-session'
            }).left?.code
        ).toBe('leader-required');
        expect(
            evaluateRallarGameRematchStart(preparation, {
                ...startAuthority,
                leaderSessionId: undefined
            }).left?.code
        ).toBe('leader-required');
        expect(
            evaluateRallarGameRematchStart(preparation, {
                ...startAuthority,
                participants: []
            }).left?.code
        ).toBe('player-required');
        expect(
            evaluateRallarGameRematchStart(preparation, {
                ...startAuthority,
                actorSessionId: 'visitor-session',
                leaderSessionId: 'visitor-session'
            }).left?.code
        ).toBe('leader-not-ready');
    });

    it('rejects old game or settings assignments and start requests', () => {
        for (
            const identity of [
                { completedGameId: 'round-0', settingsKey: 'duration:60000' },
                { completedGameId: 'round-1', settingsKey: 'duration:180000' }
            ]
        ) {
            expect(
                setRallarGameRematchReady({
                    preparation: preparation,
                    assignment: {
                        ...bobReady,
                        ...identity
                    },
                    participants: startAuthority.participants,
                    capacity: 4
                }).left?.code
            ).toBe('stale-preparation');
            expect(
                evaluateRallarGameRematchStart(preparation, {
                    ...startAuthority,
                    ...identity
                }).left?.code
            ).toBe('stale-preparation');
        }
    });

    it('invalidates confirmations only when the agreed settings change', () => {
        expect(changeRallarGameRematchSettings(preparation, 'duration:60000')).toEqual(preparation);
        const changed = changeRallarGameRematchSettings(preparation, 'duration:180000');
        expect(changed.players).toEqual([
            { sessionId: 'alice-session', ready: false },
            { sessionId: 'bob-session', ready: false }
        ]);
        expect(changed.settingsKey).toBe('duration:180000');
        expect(
            setRallarGameRematchReady({ preparation: changed, assignment: bobReady, participants: startAuthority.participants, capacity: 4 }).left
                ?.code
        )
            .toBe('stale-preparation');
    });

    it('allows explicit newcomer consent without inheriting another session readiness', () => {
        const newcomer = setRallarGameRematchReady({
            preparation: preparation,
            assignment: {
                ...bobReady,
                sessionId: 'visitor-session',
                participationKey: 'visitor-member-1'
            },
            participants: startAuthority.participants,
            capacity: 4
        }).right!;
        expect(newcomer.players).toEqual([
            { sessionId: 'alice-session', ready: true, participationKey: 'alice-member-1' },
            { sessionId: 'bob-session', ready: false },
            { sessionId: 'visitor-session', ready: true, participationKey: 'visitor-member-1' }
        ]);
        expect(
            setRallarGameRematchReady({
                preparation: preparation,
                assignment: {
                    ...bobReady,
                    sessionId: 'bob-new-session'
                },
                participants: startAuthority.participants,
                capacity: 4
            }).left?.code
        ).toBe('player-required');
        expect(
            setRallarGameRematchReady({
                preparation: preparation,
                assignment: {
                    ...bobReady,
                    sessionId: 'visitor-session',
                    participationKey: 'visitor-member-1',
                    ready: false
                },
                participants: startAuthority.participants,
                capacity: 4
            }).right
        ).toEqual(preparation);
    });

    it('requires fresh consent after a membership change while retaining consent across a transport reconnect', () => {
        const confirmed = setRallarGameRematchReady({ preparation, assignment: bobReady, participants: startAuthority.participants, capacity: 4 }).right!;
        const changedAuthority = {
            ...startAuthority,
            participants: [
                { sessionId: 'alice-session', participationKey: 'alice-member-1' },
                { sessionId: 'bob-session', participationKey: 'bob-rejoined-as-player' }
            ]
        };
        expect(evaluateRallarGameRematchStart(confirmed, changedAuthority).left?.code).toBe('players-not-ready');
        expect(setRallarGameRematchReady({ preparation: confirmed, assignment: bobReady, participants: changedAuthority.participants, capacity: 4 }).left?.code)
            .toBe('stale-participation');
        const reconfirmed = setRallarGameRematchReady({
            preparation: confirmed,
            assignment: { ...bobReady, participationKey: 'bob-rejoined-as-player' },
            participants: changedAuthority.participants,
            capacity: 4
        }).right!;
        expect(evaluateRallarGameRematchStart(reconfirmed, changedAuthority).right).toEqual(['alice-session', 'bob-session']);
        expect(evaluateRallarGameRematchStart(confirmed, startAuthority).right).toEqual(['alice-session', 'bob-session']);
    });

    it('bounds the roster and refuses duplicate or empty participant identities', () => {
        expect(
            createRallarGameRematch({ completedGameId: 'round-1', settingsKey: 'duration:60000', participantSessionIds: ['alice', 'bob'], capacity: 1 }).left
                ?.code
        )
            .toBe('capacity-reached');
        expect(
            createRallarGameRematch({ completedGameId: 'round-1', settingsKey: 'duration:60000', participantSessionIds: ['alice', 'alice'], capacity: 4 }).left
                ?.code
        )
            .toBe('invalid-preparation');
        expect(createRallarGameRematch({ completedGameId: 'round-1', settingsKey: 'duration:60000', participantSessionIds: [''], capacity: 4 }).left?.code)
            .toBe('invalid-preparation');
        expect(
            setRallarGameRematchReady({
                preparation: preparation,
                assignment: {
                    ...bobReady,
                    sessionId: 'visitor-session',
                    participationKey: 'visitor-member-1'
                },
                participants: startAuthority.participants,
                capacity: 2
            }).left?.code
        ).toBe('capacity-reached');
    });

    it('reuses an absent candidate seat only when an eligible newcomer opts in to a full roster', () => {
        const full: RallarGameRematch = {
            ...preparation,
            players: ['alice', 'bob', 'carol', 'dave'].map((sessionId) => ({ sessionId, ready: true, participationKey: sessionId }))
        };
        const participants = ['alice', 'bob', 'carol', 'eve'].map((sessionId) => ({ sessionId, participationKey: sessionId }));
        const replacement = setRallarGameRematchReady({
            preparation: full,
            participants,
            assignment: { ...bobReady, sessionId: 'eve', participationKey: 'eve' },
            capacity: 4
        }).right!;
        expect(replacement.players.map((player) => player.sessionId)).toEqual(['alice', 'bob', 'carol', 'eve']);
        expect(
            setRallarGameRematchReady({
                preparation: replacement,
                participants: [...participants, { sessionId: 'dave', participationKey: 'dave' }],
                assignment: { ...bobReady, sessionId: 'dave', participationKey: 'dave' },
                capacity: 4
            }).left?.code
        ).toBe('capacity-reached');
    });

    it('validates complete snapshots instead of accepting sparse or corrupt preparation', () => {
        expect(isRallarGameRematch(preparation, 4)).toBe(true);
        for (
            const corrupt of [
                null,
                { ...preparation, settingsKey: '' },
                { ...preparation, completedGameId: '' },
                { ...preparation, players: [{ sessionId: 'alice-session' }] },
                { ...preparation, players: [{ sessionId: 'alice-session', ready: 'yes' }] },
                { ...preparation, players: [preparation.players[0], preparation.players[0]] },
                { ...preparation, players: [{ sessionId: '', ready: true }] },
                { ...preparation, extraAuthority: true }
            ]
        ) {
            expect(isRallarGameRematch(corrupt, 4)).toBe(false);
        }
        expect(isRallarGameRematch(preparation, 1)).toBe(false);
    });
});
