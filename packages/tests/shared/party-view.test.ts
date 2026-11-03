import { decodePartyView } from '@shared/api/parties/party-view.ts';
import { describe, expect, it } from 'vitest';

const scope = { applicationId: 'game', workspaceId: 'default' };
const ref = { ...scope, partyId: 'friends' };
const invitation = { ref, invitationId: 'invitation', senderPrincipalId: 'bob', principalId: 'alice', createdAtEpochMs: 1000, expiresAtEpochMs: 10000 };
const member = { principalId: 'alice', joinedAtEpochMs: 1000, displayName: 'Alice', presence: 'present' };
const view = { scope, principalId: 'alice', observedAtEpochMs: 1001, maxMembers: 2, party: null, invitations: [invitation] };
const roster = { ref, rosterRevision: 0, leaderPrincipalId: 'alice', members: [member], invitations: [] };

describe('private party wire view', () => {
    it('decodes exact idle, invitation and member views', () => {
        for (const input of [view, { ...view, invitations: [] }, { ...view, party: roster, invitations: [] }]) {
            expect(decodePartyView(input)).toEqual(input);
        }
    });

    it('rejects foreign rosters, unrelated invitations, leaked sessions and inconsistent leadership', () => {
        for (
            const input of [
                { ...view, invitations: [{ ...invitation, principalId: 'carol' }] },
                { ...view, invitations: [{ ...invitation, ref: { ...ref, workspaceId: 'foreign' } }] },
                { ...view, invitations: [{ ...invitation, expiresAtEpochMs: 1001 }] },
                { ...view, invitations: [invitation, invitation] },
                { ...view, party: { ...roster, leaderPrincipalId: 'carol' } },
                { ...view, party: { ...roster, members: [{ ...member, principalId: 'bob' }], leaderPrincipalId: 'bob' } },
                { ...view, party: { ...roster, ref: { ...ref, applicationId: 'foreign' } } },
                { ...view, party: { ...roster, members: [{ ...member, sessionId: 'private' }] } },
                { ...view, party: { ...roster, members: [member, member] } },
                { ...view, party: { ...roster, members: [member, { ...member, principalId: 'bob' }], leaderPrincipalId: 'bob', invitations: [invitation] } }
            ]
        ) {
            expect(() => decodePartyView(input)).toThrow();
        }
    });
});
