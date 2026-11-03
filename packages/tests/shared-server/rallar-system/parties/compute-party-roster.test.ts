import { describe, expect, it } from 'vitest';

import { computePartyRoster } from '../../../../shared-server/rallar-system/parties/compute-party-roster.ts';
import type { PartyRosterInput } from '../../../../shared-server/rallar-system/parties/compute-party-roster.ts';
import type { PartyRecord } from '../../../../shared-server/rallar-system/parties/persistence/party-record.ts';

const ref = { applicationId: 'game', workspaceId: 'default', partyId: 'party-one' };
const policy = { maxMembers: 2, maxInvitations: 16, invitationLifetimeMs: 600_000 };

function input(overrides: Partial<PartyRosterInput> = {}): PartyRosterInput {
    return {
        ref,
        actorPrincipalId: 'alice',
        actorPartyId: null,
        targetPartyId: null,
        targetInvitationCount: 0,
        record: null,
        expectedRosterRevision: null,
        intent: { action: 'create' },
        friendship: null,
        presentPrincipalIds: ['alice', 'bob'],
        capturedAtEpochMs: 1000,
        nowEpochMs: 1000,
        policy,
        ...overrides
    };
}

function party(overrides: Partial<PartyRecord> = {}): PartyRecord {
    return {
        ref,
        status: 'active',
        leaderPrincipalId: 'alice',
        rosterRevision: 0,
        createdAtEpochMs: 1000,
        members: [{ principalId: 'alice', joinedAtEpochMs: 1000 }],
        invitations: [],
        ...overrides
    };
}

function memberInput(overrides: Partial<PartyRosterInput> = {}): PartyRosterInput {
    return input({ record: party(), actorPartyId: 'party-one', expectedRosterRevision: 0, ...overrides });
}

const invitation = {
    invitationId: 'invite-bob',
    senderPrincipalId: 'alice',
    principalId: 'bob',
    createdAtEpochMs: 1000,
    expiresAtEpochMs: 601_000
};
const friendship = { sender: 'friend', recipient: 'friend' } as const;

describe('party roster consent and leadership', () => {
    it('creates only the actor membership and refuses a second party', () => {
        const created = computePartyRoster(input());
        expect(created.right?.party).toEqual(party());
        expect(created.right?.rosterChanged).toBe(true);
        expect(computePartyRoster(input({ actorPartyId: 'another-party' })).left).toBe('already-in-party');
    });

    it('invites a mutual friend without adding a member or reserving a seat', () => {
        const invited = computePartyRoster(memberInput({
            intent: { action: 'invite', principalId: 'bob', invitationId: 'invite-bob' },
            friendship
        }));
        expect(invited.right?.party.members).toEqual([{ principalId: 'alice', joinedAtEpochMs: 1000 }]);
        expect(invited.right?.party.invitations).toEqual([invitation]);
        expect(invited.right?.rosterChanged).toBe(false);
        expect(
            computePartyRoster(memberInput({
                intent: { action: 'invite', principalId: 'bob', invitationId: 'invite-bob' },
                friendship: { sender: 'friend', recipient: 'blocked' }
            })).left
        ).toBe('person-unavailable');
    });

    it('bounds incoming invitations and rejects reuse of another recipient invitation identity', () => {
        const command = memberInput({
            intent: { action: 'invite', principalId: 'bob', invitationId: 'invite-bob' },
            friendship
        });
        expect(computePartyRoster({ ...command, targetInvitationCount: policy.maxInvitations }).left)
            .toBe('invitation-capacity');
        expect(
            computePartyRoster({
                ...command,
                record: party({
                    invitations: [{ ...invitation, principalId: 'charlie' }]
                })
            }).left
        ).toBe('invitation-unavailable');
    });

    it('transfers leadership only to a current member and preserves the roster on self-transfer', () => {
        const record = party({
            members: [
                { principalId: 'alice', joinedAtEpochMs: 1000 },
                { principalId: 'bob', joinedAtEpochMs: 1500 }
            ]
        });
        const command = memberInput({ record, intent: { action: 'transfer', principalId: 'bob' } });
        expect(computePartyRoster(command).right?.party).toMatchObject({ leaderPrincipalId: 'bob', rosterRevision: 1 });
        expect(computePartyRoster({ ...command, actorPrincipalId: 'bob' }).left).toBe('leader-required');
        expect(computePartyRoster({ ...command, intent: { action: 'transfer', principalId: 'mallory' } }).left)
            .toBe('member-required');
        expect(computePartyRoster({ ...command, intent: { action: 'transfer', principalId: 'alice' } }).right)
            .toEqual({ party: record, rosterChanged: false });
    });

    it('requires the invited account and current mutual consent at acceptance', () => {
        const acceptance = input({
            record: party({ invitations: [invitation] }),
            actorPrincipalId: 'bob',
            intent: { action: 'accept', invitationId: 'invite-bob' },
            friendship,
            nowEpochMs: 2000,
            capturedAtEpochMs: 2000
        });
        expect(computePartyRoster(acceptance).right?.party).toMatchObject({
            rosterRevision: 1,
            members: [{ principalId: 'alice', joinedAtEpochMs: 1000 }, { principalId: 'bob', joinedAtEpochMs: 2000 }],
            invitations: []
        });
        expect(computePartyRoster({ ...acceptance, actorPrincipalId: 'mallory' }).left).toBe('invitation-unavailable');
        expect(computePartyRoster({ ...acceptance, friendship: { sender: null, recipient: null } }).left)
            .toBe('person-unavailable');
        expect(computePartyRoster({ ...acceptance, actorPartyId: 'other-party' }).left).toBe('already-in-party');
    });

    it('refuses an expired invitation at its exact deadline and a full party', () => {
        const acceptance = input({
            record: party({ invitations: [invitation] }),
            actorPrincipalId: 'bob',
            intent: { action: 'accept', invitationId: 'invite-bob' },
            friendship
        });
        expect(computePartyRoster({ ...acceptance, nowEpochMs: 601_000 }).left).toBe('invitation-unavailable');
        expect(
            computePartyRoster({
                ...acceptance,
                record: party({
                    invitations: [invitation],
                    members: [
                        { principalId: 'alice', joinedAtEpochMs: 1000 },
                        { principalId: 'charlie', joinedAtEpochMs: 1000 }
                    ]
                })
            }).left
        ).toBe('party-full');
    });

    it('allows only the recipient to decline and the leader to revoke an invitation', () => {
        const record = party({ invitations: [invitation] });
        expect(
            computePartyRoster(input({
                record,
                actorPrincipalId: 'bob',
                intent: { action: 'decline', invitationId: 'invite-bob' }
            })).right?.party.invitations
        ).toEqual([]);
        expect(
            computePartyRoster(memberInput({
                record,
                intent: { action: 'revoke', invitationId: 'invite-bob' }
            })).right?.party.invitations
        ).toEqual([]);
        expect(
            computePartyRoster(input({
                record,
                actorPrincipalId: 'mallory',
                intent: { action: 'decline', invitationId: 'invite-bob' }
            })).left
        ).toBe('invitation-unavailable');
    });

    it('transfers departure leadership deterministically and invalidates the roster consent', () => {
        const result = computePartyRoster(memberInput({
            record: party({
                invitations: [{ ...invitation, principalId: 'charlie' }],
                members: [
                    { principalId: 'alice', joinedAtEpochMs: 1000 },
                    { principalId: 'bob', joinedAtEpochMs: 1500 },
                    { principalId: 'zoe', joinedAtEpochMs: 1500 }
                ]
            }),
            policy: { ...policy, maxMembers: 4 },
            intent: { action: 'leave' }
        }));
        expect(result.right?.party).toMatchObject({
            leaderPrincipalId: 'bob',
            rosterRevision: 1,
            invitations: [],
            members: [{ principalId: 'bob' }, { principalId: 'zoe' }]
        });
        expect(result.right?.rosterChanged).toBe(true);
    });

    it('allows explicit takeover only after the previous leader is away and fences former-leader commands', () => {
        const record = party({
            members: [
                { principalId: 'alice', joinedAtEpochMs: 1000 },
                { principalId: 'bob', joinedAtEpochMs: 2000 }
            ]
        });
        const takeover = memberInput({ record, actorPrincipalId: 'bob', intent: { action: 'take-leadership' } });
        expect(computePartyRoster(takeover).left).toBe('leader-present');
        const accepted = computePartyRoster({ ...takeover, presentPrincipalIds: ['bob'] });
        expect(accepted.right?.party).toMatchObject({ leaderPrincipalId: 'bob', rosterRevision: 1 });
        expect(
            computePartyRoster(memberInput({
                record: accepted.right!.party,
                intent: { action: 'disband' }
            })).left
        ).toBe('party-changed');
        expect(
            computePartyRoster(memberInput({
                record: accepted.right!.party,
                expectedRosterRevision: 1,
                intent: { action: 'disband' }
            })).left
        ).toBe('leader-required');
    });

    it('closes the last member departure and never revives that party identity', () => {
        const departed = computePartyRoster(memberInput({ intent: { action: 'leave' } }));
        expect(departed.right?.party).toMatchObject({ status: 'closed', leaderPrincipalId: null, members: [], invitations: [] });
        expect(computePartyRoster(input({ record: departed.right!.party })).left).toBe('party-unavailable');
    });
});
