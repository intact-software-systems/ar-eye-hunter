import { describe, expect, it } from 'vitest';

import { decodePartyRecord } from '../../../../../shared-server/rallar-system/parties/persistence/decode-party-record.ts';

const ref = { applicationId: 'game', workspaceId: 'default', partyId: 'party-one' };
const record = {
    ref,
    status: 'active',
    leaderPrincipalId: 'alice',
    rosterRevision: 2,
    createdAtEpochMs: 1000,
    members: [{ principalId: 'alice', joinedAtEpochMs: 1000 }, { principalId: 'bob', joinedAtEpochMs: 2000 }],
    invitations: [{
        invitationId: 'invite-charlie',
        senderPrincipalId: 'alice',
        principalId: 'charlie',
        createdAtEpochMs: 2000,
        expiresAtEpochMs: 602_000
    }]
};

describe('complete authoritative party record decoding', () => {
    it('reads the complete record only in its expected scope and identity', () => {
        expect(decodePartyRecord(JSON.parse(JSON.stringify(record)), ref)).toEqual(record);
        for (
            const wrong of [
                { ...ref, applicationId: 'another-game' },
                { ...ref, workspaceId: 'another-workspace' },
                { ...ref, partyId: 'another-party' }
            ]
        ) {
            expect(() => decodePartyRecord(record, wrong)).toThrow(/identity|scope/i);
        }
    });

    it('rejects missing fields and impossible leadership instead of inferring defaults', () => {
        const { rosterRevision: _revision, ...missing } = record;
        for (
            const corrupt of [
                missing,
                { ...record, leaderPrincipalId: 'outsider' },
                { ...record, leaderPrincipalId: null },
                { ...record, members: [] },
                { ...record, status: 'closed' },
                { ...record, rosterRevision: -1 },
                { ...record, retiredVersion: 1 }
            ]
        ) {
            expect(() => decodePartyRecord(corrupt, ref)).toThrow();
        }
        expect(decodePartyRecord({
            ...record,
            status: 'closed',
            leaderPrincipalId: null,
            members: [],
            invitations: []
        }, ref)).toMatchObject({ status: 'closed', members: [] });
    });

    it('rejects duplicate, noncanonical or impossible membership rather than silently sorting storage', () => {
        for (
            const members of [
                [record.members[0], record.members[0]],
                [record.members[1], record.members[0]],
                [{ ...record.members[0], joinedAtEpochMs: 999 }],
                [{ ...record.members[0], principalId: '' }]
            ]
        ) {
            expect(() => decodePartyRecord({ ...record, members }, ref)).toThrow();
        }
    });

    it('validates expired invitation content before its caller considers expiry', () => {
        const invite = record.invitations[0];
        for (
            const invitations of [
                [invite, invite],
                [{ ...invite, principalId: 'bob' }],
                [{ ...invite, senderPrincipalId: 'outsider' }],
                [{ ...invite, expiresAtEpochMs: 1 }],
                [{ ...invite, createdAtEpochMs: 999 }],
                [{ ...invite, invitationId: '' }],
                [invite, { ...invite, invitationId: 'other-invite' }]
            ]
        ) {
            expect(() => decodePartyRecord({ ...record, invitations }, ref)).toThrow();
        }
    });
});
