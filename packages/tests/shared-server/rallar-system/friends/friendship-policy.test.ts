import { describe, expect, it } from 'vitest';

import { computeFriendship } from '@shared-server/rallar-system/friends/compute-friendship.ts';

describe('mutual friendship consent', () => {
    it('requires the recipient to accept before either account becomes a friend', () => {
        expect(computeFriendship({ action: 'request', actor: null, target: null }).right)
            .toEqual({ actor: 'outgoing', target: 'incoming' });
        expect(computeFriendship({ action: 'request', actor: 'incoming', target: 'outgoing' }).right)
            .toEqual({ actor: 'incoming', target: 'outgoing' });
        expect(computeFriendship({ action: 'accept', actor: 'incoming', target: 'outgoing' }).right)
            .toEqual({ actor: 'friend', target: 'friend' });
    });

    it('refuses acceptance after cancellation and refuses a sender accepting their own request', () => {
        expect(computeFriendship({ action: 'cancel', actor: 'outgoing', target: 'incoming' }).right)
            .toEqual({ actor: null, target: null });
        expect(computeFriendship({ action: 'accept', actor: null, target: null }).left)
            .toBe('request-unavailable');
        expect(computeFriendship({ action: 'accept', actor: 'outgoing', target: 'incoming' }).left)
            .toBe('request-unavailable');
    });

    it('removes mutual access when blocked and never restores friendship on unblock', () => {
        expect(computeFriendship({ action: 'block', actor: 'friend', target: 'friend' }).right)
            .toEqual({ actor: 'blocked', target: null });
        expect(computeFriendship({ action: 'request', actor: null, target: 'blocked' }).left)
            .toBe('person-unavailable');
        expect(computeFriendship({ action: 'unblock', actor: 'blocked', target: null }).right)
            .toEqual({ actor: null, target: null });
    });

    it('keeps independent blocks private and leaves the other account blocked on unblock', () => {
        expect(computeFriendship({ action: 'block', actor: null, target: 'blocked' }).right)
            .toEqual({ actor: 'blocked', target: 'blocked' });
        expect(computeFriendship({ action: 'unblock', actor: 'blocked', target: 'blocked' }).right)
            .toEqual({ actor: null, target: 'blocked' });
    });

    it('declines an incoming request and removes friends without leaving a pending request', () => {
        expect(computeFriendship({ action: 'decline', actor: 'incoming', target: 'outgoing' }).right)
            .toEqual({ actor: null, target: null });
        expect(computeFriendship({ action: 'remove', actor: 'friend', target: 'friend' }).right)
            .toEqual({ actor: null, target: null });
        expect(computeFriendship({ action: 'cancel', actor: 'friend', target: 'friend' }).left)
            .toBe('request-unavailable');
    });

    it('fails closed on inconsistent mirrored consent rather than inventing a relationship', () => {
        expect(() => computeFriendship({ action: 'request', actor: 'friend', target: null }))
            .toThrow('Friendship consent is inconsistent');
    });
});
