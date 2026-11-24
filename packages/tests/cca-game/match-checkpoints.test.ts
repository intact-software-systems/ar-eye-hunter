import {
    describe,
    expect,
    it
} from 'vitest';

import { TownMatchCheckpoints } from '../../../apps/cca-2d/src/match/agreement/match-checkpoints.ts';
import { decodeTownMatchSnapshot } from '../../../apps/cca-2d/src/match/agreement/match-snapshot.ts';
import { computeTownMatchRecovery, computeTownMatchRoster, createTownMatch } from '../../../apps/cca-2d/src/match/town-match.ts';
import { seatDeadlineClock } from './seat-deadline-clock.ts';

const members = [
    { id: 'alice', sessionId: 'alice-session', displayName: 'Alice' },
    { id: 'bob', sessionId: 'bob-session', displayName: 'Bob' },
    { id: 'carol', sessionId: 'carol-session', displayName: 'Carol' }
];
const authority = { epoch: 1, sessionId: 'alice-session', members };
const state = createTownMatch('round', members).right!;
const proposal = { epoch: 1, sequence: 1, digest: 'a'.repeat(64), state };

// These values have already passed the wire decoder and SHA-256 check.
describe('match checkpoint agreement', () => {
    it.each(['alice-session', 'bob-session'])('keeps recovery authority separate from returning recipient %s', (localSessionId) => {
        const checkpoints = new TownMatchCheckpoints(authority, localSessionId);
        const playing = { ...proposal, state: { ...state, phase: 'playing' as const, tick: 10, remainingTicks: 5390 } };
        checkpoints.propose(playing, 'alice-session');
        for (const member of members) {
            checkpoints.acknowledge(playing, member.sessionId);
        }
        checkpoints.commit(playing, 'alice-session');
        checkpoints.interruptTransport();
        checkpoints.changeAuthority({ ...authority, epoch: 2, sessionId: 'bob-session' });
        const current = {
            ...playing,
            epoch: 2,
            sequence: 8,
            digest: 'b'.repeat(64),
            state: { ...playing.state, tick: 20, remainingTicks: 5380 }
        };
        expect(checkpoints.propose(current, 'alice-session').left).toBeDefined();
        if (localSessionId === 'bob-session') {
            expect(checkpoints.propose(current, 'bob-session').left).toBeDefined();
            for (const member of members) {
                checkpoints.recover(member.sessionId, playing, true);
            }
        }
        expect(checkpoints.propose(current, 'bob-session').right).toBe(true);
        checkpoints.commit(current, 'bob-session');
        checkpoints.acknowledge(current, 'bob-session');
        checkpoints.acknowledge(current, 'carol-session');
        expect(checkpoints.getState().committed?.state.tick).toBe(10);
        expect(checkpoints.acknowledge(current, 'alice-session').right).toBe(true);
        expect(checkpoints.getState().committed?.state.tick).toBe(20);
    });

    it('recovers when only the host observed a temporary roster change', () => {
        const pair = { ...authority, members: members.slice(0, 2) };
        const host = new TownMatchCheckpoints(pair, 'alice-session');
        const guest = new TownMatchCheckpoints(pair, 'bob-session');
        const countdown = {
            ...proposal,
            state: { ...createTownMatch('round', pair.members).right!, phase: 'countdown' as const, countdownTicks: 50 }
        };
        for (const peer of [host, guest]) {
            peer.propose(countdown, 'alice-session');
            peer.acknowledge(countdown, 'alice-session');
            peer.acknowledge(countdown, 'bob-session');
            peer.commit(countdown, 'alice-session');
        }
        const unconfirmed = { ...countdown, sequence: 2, digest: 'b'.repeat(64) };
        guest.propose(unconfirmed, 'alice-session');
        host.changeAuthority({ ...pair, members: pair.members.slice(0, 1) });
        host.changeAuthority(pair);

        expect(guest.recoveryReport(false)).toBeUndefined();
        const report = guest.recoveryReport(true);
        expect(report).toEqual({ checkpoint: countdown, committed: true });
        host.recover('alice-session', countdown, true);
        expect(host.recover('bob-session', report!.checkpoint, report!.committed).right).toBe(true);
        expect(host.propose(unconfirmed, 'alice-session').right).toBe(true);
    });

    it('accepts current director progress after a socket interruption without confirming abandoned work', () => {
        const checkpoints = new TownMatchCheckpoints(authority, 'carol-session');
        checkpoints.propose(proposal, 'alice-session');
        for (const member of members) {
            checkpoints.acknowledge(proposal, member.sessionId);
        }
        checkpoints.commit(proposal, 'alice-session');
        const unfinished = { ...proposal, sequence: 2, digest: 'b'.repeat(64) };
        checkpoints.propose(unfinished, 'alice-session');
        checkpoints.acknowledge(unfinished, 'carol-session');

        checkpoints.interruptTransport();
        expect(checkpoints.getState().committed?.sequence).toBe(1);
        expect(checkpoints.commit(unfinished, 'alice-session').left).toBeDefined();
        expect(checkpoints.acknowledge(unfinished, 'bob-session').left).toBeDefined();
        expect(checkpoints.propose(unfinished, 'alice-session').right).toBe(true);
        expect(checkpoints.propose(unfinished, 'alice-session').right).toBe(false);
        expect(checkpoints.propose({ ...unfinished, digest: 'd'.repeat(64) }, 'alice-session').left).toBeDefined();
        const current = { ...proposal, sequence: 8, digest: 'c'.repeat(64) };
        expect(checkpoints.propose(current, 'alice-session').right).toBe(true);
        checkpoints.acknowledge(current, 'alice-session');
        checkpoints.acknowledge(current, 'bob-session');
        checkpoints.commit(current, 'alice-session');
        expect(checkpoints.getState().committed?.sequence).toBe(1);
        expect(checkpoints.acknowledge(current, 'carol-session').right).toBe(true);
        expect(checkpoints.getState().committed?.sequence).toBe(8);
        expect(checkpoints.propose({ ...current, sequence: 9 }, 'alice-session').right).toBe(true);
        expect(checkpoints.propose({ ...current, sequence: 10 }, 'alice-session').left).toBeDefined();
    });

    it('retains a verified proposal across socket loss for a surviving commit witness', () => {
        const checkpoints = new TownMatchCheckpoints(authority, 'carol-session');
        checkpoints.propose(proposal, 'alice-session');
        checkpoints.interruptTransport();
        checkpoints.interruptTransport();
        checkpoints.changeAuthority({ epoch: 2, sessionId: 'bob-session', members: members.slice(1) });
        expect(checkpoints.getState().committed).toBeUndefined();
        expect(checkpoints.recover('carol-session', proposal, false).left).toBeDefined();
        expect(checkpoints.recover('carol-session', proposal, true).right).toBe(false);
        expect(checkpoints.recover('bob-session', proposal, false).right).toBe(true);
        expect(checkpoints.getState().recoveryCheckpoint?.sequence).toBe(1);
        expect(checkpoints.getState().committed).toBeUndefined();
    });

    it.each([8, 9])('recovers witnessed proposal %s after superseding uncommitted resynchronization work', (sequence) => {
        const checkpoints = new TownMatchCheckpoints(authority, 'carol-session');
        checkpoints.propose(proposal, 'alice-session');
        for (const member of members) {
            checkpoints.acknowledge(proposal, member.sessionId);
        }
        checkpoints.commit(proposal, 'alice-session');
        checkpoints.interruptTransport();
        const superseded = { ...proposal, sequence: 8, digest: 'b'.repeat(64) };
        const latest = { ...proposal, sequence: 9, digest: 'c'.repeat(64) };
        checkpoints.propose(superseded, 'alice-session');
        checkpoints.acknowledge(superseded, 'carol-session');
        checkpoints.propose(latest, 'alice-session');
        checkpoints.changeAuthority({ epoch: 2, sessionId: 'bob-session', members: members.slice(1) });

        const witnessed = sequence === 8 ? superseded : latest;
        expect(checkpoints.recover('bob-session', witnessed, true).right).toBe(false);
        expect(checkpoints.recover('carol-session', witnessed, false).right).toBe(true);
        expect(checkpoints.getState().recoveryCheckpoint?.sequence).toBe(sequence);
        expect(checkpoints.getState().committed?.sequence).toBe(1);
        if (sequence === 9) {
            expect(checkpoints.recover('bob-session', superseded, true).left).toBeDefined();
            expect(checkpoints.getState().recoveryCheckpoint?.sequence).toBe(9);
        }
    });

    it('lets surviving backups admit a returning browser, which must acknowledge the new checkpoint before play', () => {
        const continuing = { epoch: 2, sessionId: 'bob-session', members: members.slice(1) };
        const checkpoints = new TownMatchCheckpoints(continuing, 'bob-session');
        const saved = {
            ...proposal,
            epoch: 2,
            state: computeTownMatchRecovery({
                state: { ...state, phase: 'playing' },
                members: members.slice(1),
                departedIds: [],
                clock: seatDeadlineClock(1000)
            }).right!
        };
        expect(decodeTownMatchSnapshot(JSON.stringify(saved.state)).left).toBeUndefined();
        checkpoints.propose(saved, 'bob-session');
        checkpoints.acknowledge(saved, 'bob-session');
        checkpoints.acknowledge(saved, 'carol-session');
        checkpoints.commit(saved, 'bob-session');
        const returning = { ...members[0], sessionId: 'alice-returned' };
        checkpoints.changeAuthority({ ...continuing, members: [returning, ...continuing.members] });
        expect(checkpoints.recover('alice-returned', saved, true).left).toBeDefined();
        expect(checkpoints.recover('bob-session', saved, true).right).toBe(false);
        expect(checkpoints.recover('carol-session', saved, true).right).toBe(true);
        const resumed = {
            ...saved,
            sequence: 2,
            digest: 'b'.repeat(64),
            state: computeTownMatchRecovery({
                state: saved.state,
                members: [returning, ...continuing.members],
                departedIds: [],
                clock: seatDeadlineClock(2000)
            }).right!
        };
        expect(decodeTownMatchSnapshot(JSON.stringify(resumed.state)).left).toBeUndefined();
        expect(checkpoints.propose(resumed, 'bob-session').right).toBe(true);
        checkpoints.acknowledge(resumed, 'bob-session');
        checkpoints.acknowledge(resumed, 'carol-session');
        checkpoints.commit(resumed, 'bob-session');
        expect(checkpoints.getState().committed?.sequence).toBe(1);
        expect(checkpoints.acknowledge(resumed, 'alice-returned').right).toBe(true);
        expect(checkpoints.getState().committed?.sequence).toBe(2);
    });

    it('requires every frozen recipient acknowledgement plus the director commit before confirming', () => {
        const checkpoints = new TownMatchCheckpoints(authority, 'carol-session');
        expect(checkpoints.propose(proposal, 'alice-session').right).toBe(true);
        expect(checkpoints.getState().committed).toBeUndefined();
        expect(checkpoints.commit(proposal, 'alice-session').right).toBe(false);
        expect(checkpoints.acknowledge(proposal, 'alice-session').right).toBe(false);
        expect(checkpoints.acknowledge(proposal, 'bob-session').right).toBe(false);
        expect(checkpoints.getState().committed).toBeUndefined();
        expect(checkpoints.acknowledge(proposal, 'carol-session').right).toBe(true);
        expect(checkpoints.getState().committed?.state.matchId).toBe('round');
        expect(checkpoints.getState().committed?.sequence).toBe(1);
        expect(checkpoints.getState().pending).toBeUndefined();
        // A repeated transport delivery cannot reopen or award the checkpoint twice.
        expect(checkpoints.propose(proposal, 'alice-session').right).toBe(false);
        expect(checkpoints.getState().committed?.sequence).toBe(1);
    });

    it('rejects a forged director, wrong digest, missing member, stale sequence and premature replacement', () => {
        const checkpoints = new TownMatchCheckpoints(authority, 'carol-session');
        expect(checkpoints.propose(proposal, 'bob-session').left).toBeDefined();
        expect(checkpoints.propose({ ...proposal, epoch: 0 }, 'alice-session').left).toBeDefined();
        expect(checkpoints.propose({ ...proposal, state: { ...state, members: state.members.slice(1) } }, 'alice-session').left).toBeDefined();
        expect(checkpoints.propose(proposal, 'alice-session').right).toBe(true);
        expect(checkpoints.propose({ ...proposal, sequence: 2 }, 'alice-session').left).toBeDefined();
        expect(checkpoints.acknowledge(proposal, 'outsider').left).toBeDefined();
        expect(checkpoints.acknowledge({ ...proposal, digest: 'b'.repeat(64) }, 'bob-session').left).toBeDefined();
        expect(checkpoints.commit(proposal, 'bob-session').left).toBeDefined();
        for (const member of members) {
            checkpoints.acknowledge(proposal, member.sessionId);
        }
        expect(checkpoints.getState().committed).toBeUndefined();
        expect(checkpoints.commit(proposal, 'alice-session').right).toBe(true);
        expect(checkpoints.propose({ ...proposal, sequence: 0 }, 'alice-session').left).toBeDefined();
        expect(checkpoints.getState().committed?.digest).toBe('a'.repeat(64));
    });

    it('cannot replace a running round or rewind its countdown under the same appointment', () => {
        const checkpoints = new TownMatchCheckpoints(authority, 'carol-session');
        const playing = { ...proposal, state: { ...state, phase: 'playing' as const, tick: 10, remainingTicks: 5390 } };
        checkpoints.propose(playing, 'alice-session');
        for (const member of members) {
            checkpoints.acknowledge(playing, member.sessionId);
        }
        checkpoints.commit(playing, 'alice-session');
        expect(checkpoints.propose({ ...proposal, sequence: 2, state: { ...state, matchId: 'silent-restart' } }, 'alice-session').left).toBeDefined();
        expect(checkpoints.propose({ ...playing, sequence: 2, state: { ...playing.state, phase: 'lobby' } }, 'alice-session').left).toBeDefined();
        expect(checkpoints.propose({ ...proposal, sequence: 2 }, 'alice-session').left).toBeDefined();
        expect(checkpoints.getState().committed?.state.tick).toBe(10);
    });

    it('drops provisional progress at a new authority and recovers only a matching committed checkpoint', () => {
        const checkpoints = new TownMatchCheckpoints(authority, 'carol-session');
        checkpoints.propose(proposal, 'alice-session');
        for (const member of members) {
            checkpoints.acknowledge(proposal, member.sessionId);
        }
        checkpoints.commit(proposal, 'alice-session');
        checkpoints.propose({ ...proposal, sequence: 2, digest: 'b'.repeat(64) }, 'alice-session');
        const successor = { epoch: 2, sessionId: 'bob-session', members: members.slice(1) };
        expect(checkpoints.changeAuthority(successor).right).toBe(true);
        expect(checkpoints.getState().pending).toBeUndefined();
        expect(checkpoints.getState().committed?.sequence).toBe(1);
        expect(checkpoints.recover('bob-session', proposal, true).right).toBe(false);
        expect(checkpoints.recover('carol-session', { ...proposal, digest: 'f'.repeat(64) }, true).left).toBeDefined();
        expect(checkpoints.recover('carol-session', proposal, true).right).toBe(true);
        expect(checkpoints.getState().recovered).toBe(true);
        expect(checkpoints.propose({ ...proposal, sequence: 3 }, 'alice-session').left).toBeDefined();
        expect(checkpoints.changeAuthority(authority).left).toBeDefined();
    });

    it('refuses new-epoch gameplay until surviving peers agree on the committed recovery point', () => {
        const checkpoints = new TownMatchCheckpoints(authority, 'carol-session');
        checkpoints.propose(proposal, 'alice-session');
        for (const member of members) {
            checkpoints.acknowledge(proposal, member.sessionId);
        }
        checkpoints.commit(proposal, 'alice-session');
        checkpoints.changeAuthority({ ...authority, epoch: 2, sessionId: 'bob-session' });
        const resumed = { ...proposal, epoch: 2, sequence: 1, state: { ...state, phase: 'countdown' as const, countdownTicks: 90 } };
        expect(checkpoints.propose(resumed, 'bob-session').left).toBeDefined();
        expect(checkpoints.propose({ ...resumed, state: { ...resumed.state, phase: 'finished' } }, 'bob-session').left).toBeDefined();
        for (const member of members) {
            checkpoints.recover(member.sessionId, proposal, true);
        }
        expect(checkpoints.propose(resumed, 'bob-session').right).toBe(true);
    });

    it('allows a fresh ready cycle after all current players commit their new lobby', () => {
        const checkpoints = new TownMatchCheckpoints(authority, 'carol-session');
        checkpoints.changeAuthority({ ...authority, epoch: 2, sessionId: 'bob-session' });
        const lobby = { ...proposal, epoch: 2 };
        checkpoints.propose(lobby, 'bob-session');
        for (const member of members) {
            checkpoints.acknowledge(lobby, member.sessionId);
        }
        expect(checkpoints.commit(lobby, 'bob-session').right).toBe(true);
        const countdown = { ...lobby, sequence: 2, state: { ...state, phase: 'countdown' as const, countdownTicks: 90 } };
        expect(checkpoints.propose(countdown, 'bob-session').right).toBe(true);
    });

    it('cannot recover from a merely received proposal or with only one remaining player', () => {
        const checkpoints = new TownMatchCheckpoints(authority, 'carol-session');
        checkpoints.propose(proposal, 'alice-session');
        const successor = { epoch: 2, sessionId: 'bob-session', members: members.slice(1) };
        checkpoints.changeAuthority(successor);
        expect(checkpoints.recover('bob-session', proposal, false).left).toBeDefined();
        expect(checkpoints.getState().recovered).toBe(false);
        const single = new TownMatchCheckpoints({ ...successor, members: [members[1]] }, 'bob-session');
        expect(single.recover('bob-session', proposal, false).left).toBeDefined();
        expect(single.getState().recovered).toBe(false);
    });

    it('reconciles a verified pending proposal with a survivor commit without publishing it prematurely', () => {
        const checkpoints = new TownMatchCheckpoints(authority, 'carol-session');
        checkpoints.propose(proposal, 'alice-session');
        for (const member of members) {
            checkpoints.acknowledge(proposal, member.sessionId);
        }
        checkpoints.commit(proposal, 'alice-session');
        const latest = { ...proposal, sequence: 2, digest: 'b'.repeat(64), state: { ...state, phase: 'playing' as const, tick: 10, remainingTicks: 5390 } };
        checkpoints.propose(latest, 'alice-session');
        const successor = { epoch: 2, sessionId: 'bob-session', members: members.slice(1) };
        checkpoints.changeAuthority(successor);
        const interrupted = { ...proposal, epoch: 2, sequence: 1, state: { ...state, members: state.members.slice(1), phase: 'interrupted' as const } };
        expect(checkpoints.propose(interrupted, 'bob-session').right).toBe(true);
        expect(checkpoints.recover('carol-session', latest, false).left).toBeDefined();
        expect(checkpoints.recover('outsider', latest, true).left).toBeDefined();
        expect(checkpoints.recover('carol-session', { ...latest, digest: 'c'.repeat(64) }, true).left).toBeDefined();
        expect(checkpoints.recover('carol-session', latest, true).right).toBe(false);
        expect(checkpoints.getState().pending).toBeUndefined();
        expect(checkpoints.getState().recoveryCheckpoint?.sequence).toBe(2);
        expect(checkpoints.getState().committed?.sequence).toBe(1);
        expect(checkpoints.recover('bob-session', latest, false).right).toBe(true);
        const resumed = {
            ...latest,
            epoch: 2,
            sequence: 1,
            state: computeTownMatchRecovery({ state: latest.state, members: members.slice(1), departedIds: [], clock: seatDeadlineClock(1000) }).right!
        };
        expect(checkpoints.propose({ ...resumed, state: { ...resumed.state, tick: 0 } }, 'bob-session').left).toBeDefined();
        expect(checkpoints.propose(resumed, 'bob-session').right).toBe(true);
        checkpoints.acknowledge(resumed, 'bob-session');
        checkpoints.commit(resumed, 'bob-session');
        expect(checkpoints.getState().committed?.sequence).toBe(1);
        expect(checkpoints.getState().committed?.epoch).toBe(1);
        expect(checkpoints.acknowledge(resumed, 'carol-session').right).toBe(true);
        expect(checkpoints.getState().committed?.state.tick).toBe(10);
        expect(checkpoints.getState().committed?.epoch).toBe(2);
    });

    it('keeps the verified source across a second appointment while an older interruption is pending', () => {
        const checkpoints = new TownMatchCheckpoints(authority, 'carol-session');
        checkpoints.propose(proposal, 'alice-session');
        for (const member of members) {
            checkpoints.acknowledge(proposal, member.sessionId);
        }
        checkpoints.commit(proposal, 'alice-session');
        const latest = { ...proposal, sequence: 2, digest: 'b'.repeat(64), state: { ...state, phase: 'playing' as const, tick: 10, remainingTicks: 5390 } };
        checkpoints.propose(latest, 'alice-session');
        checkpoints.changeAuthority({ epoch: 2, sessionId: 'bob-session', members: members.slice(1) });
        checkpoints.propose({ ...proposal, epoch: 2, sequence: 1, state: { ...state, members: state.members.slice(1), phase: 'interrupted' } }, 'bob-session');
        checkpoints.changeAuthority({ epoch: 3, sessionId: 'carol-session', members: members.slice(1) });
        expect(checkpoints.recover('bob-session', latest, true).right).toBe(false);
        expect(checkpoints.recover('carol-session', latest, false).right).toBe(true);
        expect(checkpoints.getState().recoveryCheckpoint?.sequence).toBe(2);
        expect(checkpoints.getState().committed?.sequence).toBe(1);
    });

    it('retains a newer recovery proposal when a second host disappears during partial commitment', () => {
        const checkpoints = new TownMatchCheckpoints(authority, 'carol-session');
        checkpoints.propose(proposal, 'alice-session');
        for (const member of members) {
            checkpoints.acknowledge(proposal, member.sessionId);
        }
        checkpoints.commit(proposal, 'alice-session');
        const latest = { ...proposal, sequence: 2, digest: 'b'.repeat(64), state: { ...state, phase: 'playing' as const, tick: 10, remainingTicks: 5390 } };
        checkpoints.propose(latest, 'alice-session');
        checkpoints.changeAuthority({ epoch: 2, sessionId: 'bob-session', members: members.slice(1) });
        checkpoints.recover('carol-session', latest, true);
        checkpoints.recover('bob-session', latest, false);
        const resumed = {
            ...latest,
            epoch: 2,
            sequence: 1,
            digest: 'c'.repeat(64),
            state: computeTownMatchRecovery({ state: latest.state, members: members.slice(1), departedIds: [], clock: seatDeadlineClock(1000) }).right!
        };
        expect(checkpoints.propose(resumed, 'bob-session').right).toBe(true);
        checkpoints.changeAuthority({ epoch: 3, sessionId: 'carol-session', members: members.slice(1) });
        expect(checkpoints.recover('bob-session', resumed, true).right).toBe(false);
        expect(checkpoints.recover('carol-session', resumed, false).right).toBe(true);
        expect(checkpoints.getState().recoveryCheckpoint?.epoch).toBe(2);
        expect(checkpoints.getState().committed?.epoch).toBe(1);
    });

    it('can agree on a retained rematch lobby without replacing the old terminal result before commitment', () => {
        const checkpoints = new TownMatchCheckpoints(authority, 'carol-session');
        const terminal = { ...proposal, state: { ...state, phase: 'interrupted' as const } };
        checkpoints.propose(terminal, 'alice-session');
        for (const member of members) {
            checkpoints.acknowledge(terminal, member.sessionId);
        }
        checkpoints.commit(terminal, 'alice-session');
        const lobby = { ...proposal, sequence: 2, digest: 'b'.repeat(64), state: createTownMatch('rematch', members).right! };
        checkpoints.propose(lobby, 'alice-session');
        checkpoints.changeAuthority({ epoch: 2, sessionId: 'bob-session', members: members.slice(1) });
        expect(checkpoints.recover('carol-session', lobby, true).right).toBe(false);
        expect(checkpoints.recover('bob-session', lobby, false).right).toBe(true);
        expect(checkpoints.getState().committed?.state.matchId).toBe('round');
        expect(
            checkpoints.propose({ ...lobby, epoch: 2, sequence: 1, state: computeTownMatchRoster(lobby.state, members.slice(1)).right! }, 'bob-session').right
        )
            .toBe(true);
    });
});
