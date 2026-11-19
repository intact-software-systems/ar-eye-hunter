import { expect, it } from 'vitest';

import { PollAuthority } from '../../../../examples/shared-deadline-poll/poll-authority.ts';

it('uses receipt time, retains each first ballot, and returns a private disposition with the shared tally', () => {
    let now = 98;
    const room = { applicationId: 'polls', workspaceId: 'default', groupId: 'weekly' };
    const schedule = { opensAtEpochMs: 99, closesAtEpochMs: 100 };
    const poll = new PollAuthority(room, schedule, () => now);
    expect(poll.vote('alice', 'no')).toMatchObject({ disposition: 'pending', no: 0 });
    now = 99;
    expect(poll.vote('alice', 'yes').disposition).toBe('accepted');
    now = 100;
    expect(poll.vote('bob', 'no').disposition).toBe('late');
    now = 101;
    expect(poll.vote('alice', 'no')).toEqual({
        roomRef: room,
        schedule,
        yes: 1,
        no: 0,
        disposition: 'accepted'
    });
    expect(poll.vote('bob', 'yes').disposition).toBe('late');
    expect(poll.read('charlie')).toEqual({
        roomRef: room,
        schedule,
        yes: 1,
        no: 0,
        disposition: 'pending'
    });
});
