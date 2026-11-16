import {
    describe,
    expect,
    it
} from 'vitest';

import { TownMatchCheckpoints } from '../../../apps/cca-2d/src/match/match-checkpoints.ts';
import { createTownMatch } from '../../../apps/cca-2d/src/match/town-match.ts';

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
    it('requires every frozen recipient acknowledgement plus the director commit before confirming', () => {
        const checkpoints = new TownMatchCheckpoints(authority);
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
        const checkpoints = new TownMatchCheckpoints(authority);
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
        const checkpoints = new TownMatchCheckpoints(authority);
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
        const checkpoints = new TownMatchCheckpoints(authority);
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
        expect(checkpoints.recover('bob-session', proposal).right).toBe(false);
        expect(checkpoints.recover('carol-session', { ...proposal, digest: 'f'.repeat(64) }).left).toBeDefined();
        expect(checkpoints.recover('carol-session', proposal).right).toBe(true);
        expect(checkpoints.getState().recovered).toBe(true);
        expect(checkpoints.propose({ ...proposal, sequence: 3 }, 'alice-session').left).toBeDefined();
        expect(checkpoints.changeAuthority(authority).left).toBeDefined();
    });

    it('refuses new-epoch gameplay until surviving peers agree on the committed recovery point', () => {
        const checkpoints = new TownMatchCheckpoints(authority);
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
            checkpoints.recover(member.sessionId, proposal);
        }
        expect(checkpoints.propose(resumed, 'bob-session').right).toBe(true);
    });

    it('allows a fresh ready cycle after all current players commit their new lobby', () => {
        const checkpoints = new TownMatchCheckpoints(authority);
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
        const checkpoints = new TownMatchCheckpoints(authority);
        checkpoints.propose(proposal, 'alice-session');
        const successor = { epoch: 2, sessionId: 'bob-session', members: members.slice(1) };
        checkpoints.changeAuthority(successor);
        expect(checkpoints.recover('bob-session', proposal).left).toBeDefined();
        expect(checkpoints.getState().recovered).toBe(false);
        const single = new TownMatchCheckpoints({ ...successor, members: [members[1]] });
        expect(single.recover('bob-session', proposal).left).toBeDefined();
        expect(single.getState().recovered).toBe(false);
    });
});
