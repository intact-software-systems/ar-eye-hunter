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
    expect(poll.read('bob').closed).toBe(true);
    now = 99;
    expect(poll.vote('bob', 'no').disposition).toBe('late');
    now = 101;
    expect(poll.vote('alice', 'no')).toEqual({
        roomRef: room,
        schedule,
        closed: true,
        revision: null,
        canExtend: false,
        yes: 1,
        no: 0,
        disposition: 'accepted'
    });
    expect(poll.vote('bob', 'yes').disposition).toBe('late');
    expect(poll.read('charlie')).toEqual({
        roomRef: room,
        schedule,
        closed: true,
        revision: null,
        canExtend: false,
        yes: 1,
        no: 0,
        disposition: 'pending'
    });
});

it('extends an open poll once for the host and keeps accepted votes across the old cutoff', () => {
    let now = 10;
    const poll = new PollAuthority({ applicationId: 'poll', workspaceId: 'a', groupId: 'g' }, { opensAtEpochMs: 11, closesAtEpochMs: 20 }, () => now, 'host');
    expect(poll.extend('host', 0).revision).toBe(0);
    now = 12;
    expect(() => poll.extend('guest', 0)).toThrow();
    poll.vote('guest', 'yes');
    expect(poll.extend('host', 1).revision).toBe(0);
    expect(poll.extend('host', 0).schedule.closesAtEpochMs).toBe(60020);
    expect(poll.extend('host', 0).revision).toBe(1);
    now = 20;
    expect(poll.read('guest')).toMatchObject({ closed: false, yes: 1, disposition: 'accepted' });
    now = 60020;
    expect(poll.extend('host', 1)).toMatchObject({ closed: true, revision: 1 });
});
