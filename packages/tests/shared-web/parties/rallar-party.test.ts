import { RallarParty } from '@shared-web/browser/parties/rallar-party.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { PartyView } from '@shared/api/parties/party-view.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

const scope = { applicationId: 'game', workspaceId: 'default' };
const ref = { ...scope, partyId: 'party' };
const session: AuthSession = { clientId: 'alice', username: 'alice', sessionId: 'alice-session', accessToken: 'test', expiresAtEpochMs: 9999999999999 };
const view: PartyView = {
    scope,
    principalId: 'alice',
    observedAtEpochMs: 1000,
    maxMembers: 2,
    invitations: [],
    party: {
        ref,
        rosterRevision: 3,
        leaderPrincipalId: 'alice',
        invitations: [],
        members: [
            { principalId: 'alice', joinedAtEpochMs: 1, displayName: 'Alice', presence: 'present' },
            { principalId: 'bob', joinedAtEpochMs: 2, displayName: 'Bob', presence: 'away' }
        ]
    }
};
const cleanups: (() => void)[] = [];
afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
});

function browser() {
    const api = {
        read: vi.fn<RallarParty.Api['read']>(async () => view),
        change: vi.fn<RallarParty.Api['change']>(async ({ request, requestId }) => ({
            ref: request.ref,
            principalId: session.clientId,
            requestId,
            status: 'applied',
            code: null
        }))
    };
    const owner = new RallarParty({
        api,
        auth: { session: () => session, onChange: () => () => {} },
        activity: { isActive: () => true, onChange: () => () => {} },
        timers: createDefaultTimers(),
        createId: () => crypto.randomUUID()
    }, { scope, refreshIntervalMs: 30000 });
    cleanups.push(() => owner.stop());
    return { owner, api };
}

describe('party browser consent', () => {
    it('recovers present and away members and binds leadership changes to the displayed roster', async () => {
        const test = browser();
        await test.owner.start();
        expect(test.owner.getState().view).toEqual(view);
        await test.owner.changeRoster({ action: 'transfer', principalId: 'bob' });
        expect(test.api.change).toHaveBeenCalledWith(
            expect.objectContaining({ request: { ref, expectedRosterRevision: 3, intent: { action: 'transfer', principalId: 'bob' } } })
        );
        await test.owner.changeRoster({ action: 'leave' });
        expect(test.api.change).toHaveBeenCalledWith(expect.objectContaining({ request: { ref, expectedRosterRevision: 3, intent: { action: 'leave' } } }));
    });

    it('creates a new identity once and retries an uncertain invitation with its original roster consent', async () => {
        const test = browser();
        test.api.read.mockResolvedValueOnce({ ...view, party: null });
        await test.owner.start();
        await test.owner.create();
        expect(test.api.change.mock.calls[0]?.[0].request).toMatchObject({ ref: scope, expectedRosterRevision: null, intent: { action: 'create' } });
        test.api.change.mockRejectedValueOnce(new Error('Response lost'));
        await test.owner.invite('carol');
        const first = test.api.change.mock.calls[1]?.[0];
        expect(first?.request).toMatchObject({ ref, expectedRosterRevision: 3, intent: { action: 'invite', principalId: 'carol' } });
        if (view.party === null) {
            throw new Error('Expected a party fixture');
        }
        test.api.read.mockResolvedValue({ ...view, party: { ...view.party, rosterRevision: 4 } });
        await test.owner.refresh();
        await test.owner.changeRoster({ action: 'disband' });
        expect(test.api.change).toHaveBeenCalledTimes(2);
        await test.owner.retry();
        expect(test.api.change.mock.calls[2]?.[0]).toEqual(first);
    });

    it('accepts only a displayed invitation and preserves explicit null roster consent', async () => {
        const test = browser();
        test.api.read.mockResolvedValue({
            ...view,
            party: null,
            invitations: [{
                ref,
                invitationId: 'invite',
                principalId: 'alice',
                senderPrincipalId: 'bob',
                createdAtEpochMs: 1,
                expiresAtEpochMs: 2000
            }]
        });
        await test.owner.start();
        await test.owner.respond(ref, 'missing', 'accept');
        expect(test.api.change).not.toHaveBeenCalled();
        await test.owner.respond(ref, 'invite', 'accept');
        expect(test.api.change).toHaveBeenCalledWith(
            expect.objectContaining({ request: { ref, expectedRosterRevision: null, intent: { action: 'accept', invitationId: 'invite' } } })
        );
    });

    it.each(['accept', 'decline'] as const)('binds %s to the selected party when invitation IDs collide', async (action) => {
        const test = browser();
        const second = { ...ref, partyId: 'second-party' };
        test.api.read.mockResolvedValue({
            ...view,
            party: null,
            invitations: [ref, second].map((ref) => ({
                ref,
                invitationId: 'same-invitation-id',
                principalId: 'alice',
                senderPrincipalId: ref.partyId === 'party' ? 'bob' : 'carol',
                createdAtEpochMs: 1,
                expiresAtEpochMs: 2000
            }))
        });
        await test.owner.start();
        await test.owner.respond({ ...second, workspaceId: 'another-workspace' }, 'same-invitation-id', action);
        expect(test.api.change).not.toHaveBeenCalled();
        await test.owner.respond(second, 'same-invitation-id', action);
        expect(test.api.change).toHaveBeenCalledWith(expect.objectContaining({
            request: {
                ref: second,
                expectedRosterRevision: null,
                intent: { action, invitationId: 'same-invitation-id' }
            }
        }));
    });

    it('refuses mismatched private views and keeps a misbound mutation unresolved', async () => {
        const test = browser();
        test.api.read.mockResolvedValueOnce({ ...view, scope: { ...scope, applicationId: 'other' }, party: null });
        await test.owner.start();
        expect(test.owner.getState()).toMatchObject({ view: null, error: expect.stringContaining('scope') });
        await test.owner.refresh();
        test.api.change.mockImplementationOnce(async ({ requestId }) => ({
            ref: { ...ref, partyId: 'another-party' },
            principalId: 'alice',
            requestId,
            status: 'applied',
            code: null
        }));
        await test.owner.changeRoster({ action: 'leave' });
        expect(test.owner.getState()).toMatchObject({ retryPending: true, error: expect.stringContaining('command') });
    });

    it('refreshes on a definitive roster refusal without retrying or silently changing consent', async () => {
        const test = browser();
        await test.owner.start();
        test.api.change.mockImplementationOnce(async ({ request, requestId }) => ({
            ref: request.ref,
            principalId: 'alice',
            requestId,
            status: 'refused',
            code: 'party-changed'
        }));
        await test.owner.changeRoster({ action: 'take-leadership' });
        expect(test.owner.getState()).toMatchObject({ retryPending: false, error: expect.stringContaining('party changed') });
        expect(test.api.change).toHaveBeenCalledTimes(1);
    });
});
