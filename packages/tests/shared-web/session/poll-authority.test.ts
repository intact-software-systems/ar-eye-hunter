import { expect, it } from 'vitest';

import { PollAuthority } from '../../../../examples/shared-deadline-poll/poll-authority.ts';

it('uses receipt time, retains each first ballot, and returns a private disposition with the shared tally', () => {
    let now = 99;
    const room = { applicationId: 'polls', workspaceId: 'default', groupId: 'weekly' };
    const poll = new PollAuthority(room, 100, () => now);
    expect(poll.vote('alice', 'yes').disposition).toBe('accepted');
    now = 100;
    expect(poll.vote('bob', 'no').disposition).toBe('late');
    now = 101;
    expect(poll.vote('alice', 'no')).toEqual({
        roomRef: room,
        closesAtEpochMs: 100,
        yes: 1,
        no: 0,
        disposition: 'accepted'
    });
    expect(poll.vote('bob', 'yes').disposition).toBe('late');
    expect(poll.read('charlie')).toEqual({
        roomRef: room,
        closesAtEpochMs: 100,
        yes: 1,
        no: 0,
        disposition: 'pending'
    });
});
