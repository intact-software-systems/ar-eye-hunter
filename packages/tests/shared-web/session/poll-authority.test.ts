import { expect, it } from 'vitest';

import { PollAuthority } from '../../../../examples/shared-deadline-poll/poll-authority.ts';

it('uses receipt time, retains each first ballot, and returns a private disposition with the shared tally', async () => {
    let now = 98;
    const room = { applicationId: 'polls', workspaceId: 'default', groupId: 'weekly' };
    const schedule = { opensAtEpochMs: 99, closesAtEpochMs: 100 };
    const poll = new PollAuthority(room, schedule, () => now);
    expect(await poll.vote('alice', 'no')).toMatchObject({ disposition: 'pending', no: 0 });
    now = 99;
    expect((await poll.vote('alice', 'yes')).disposition).toBe('accepted');
    now = 100;
    expect((await poll.read('bob')).closed).toBe(true);
    now = 99;
    expect((await poll.vote('bob', 'no')).disposition).toBe('late');
    now = 101;
    expect(await poll.vote('alice', 'no')).toEqual({
        roomRef: room,
        schedule,
        closed: true,
        revision: null,
        canExtend: false,
        yes: 1,
        no: 0,
        disposition: 'accepted'
    });
    expect((await poll.vote('bob', 'yes')).disposition).toBe('late');
    expect(await poll.read('charlie')).toEqual({
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

it('checks the current room deadline for each ballot and records nothing when the deadline is unavailable', async () => {
    let now = 12;
    let deadline = { name: 'voting-close', revision: 1, atEpochMs: 20 };
    let available = true;
    const poll = new PollAuthority(
        { applicationId: 'poll', workspaceId: 'a', groupId: 'g' },
        {
            opensAtEpochMs: 11,
            hostId: 'host',
            readDeadline: async () => available ? deadline : null
        },
        () => now
    );
    expect(await poll.read('host')).toMatchObject({ revision: 1, canExtend: true });
    expect(await poll.vote('first', 'yes')).toMatchObject({ yes: 1, disposition: 'accepted' });
    now = 20;
    expect(await poll.read('next')).toMatchObject({ closed: true, revision: 1 });
    deadline = { name: 'voting-close', revision: 2, atEpochMs: 30 };
    now = 21;
    available = false;
    await expect(poll.vote('next', 'no')).rejects.toThrow();
    available = true;
    expect(await poll.read('next')).toMatchObject({ no: 0, disposition: 'pending' });
    expect(await poll.vote('next', 'yes')).toMatchObject({ yes: 2, revision: 2, disposition: 'accepted' });
    now = 30;
    expect(await poll.vote('last', 'no')).toMatchObject({ yes: 2, no: 0, closed: true, disposition: 'late' });
});

it('settles ballots in receipt order while a room deadline read is pending', async () => {
    let now = 19;
    const firstRead = Promise.withResolvers<void>();
    let readCount = 0;
    const poll = new PollAuthority(
        { applicationId: 'poll', workspaceId: 'a', groupId: 'g' },
        {
            hostId: 'host',
            opensAtEpochMs: 11,
            async readDeadline() {
                if (++readCount === 1) {
                    await firstRead.promise;
                }
                return { name: 'voting-close', revision: 1, atEpochMs: 20 };
            }
        },
        () => now
    );
    const first = poll.vote('voter', 'yes');
    now = 20;
    const repeat = poll.vote('voter', 'no');
    await new Promise((resolve) => setTimeout(resolve, 0));
    firstRead.resolve();
    expect(await first).toMatchObject({ yes: 1, no: 0, disposition: 'accepted' });
    expect(await repeat).toMatchObject({ yes: 1, no: 0, disposition: 'accepted', closed: true });
});
