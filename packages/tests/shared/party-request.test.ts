import { decodePartyMutationResult, decodePartyRequest } from '@shared/api/parties/party-request.ts';
import { describe, expect, it } from 'vitest';

const ref = { applicationId: 'game', workspaceId: 'default', partyId: 'party-one' };

describe('party wire contracts', () => {
    it('requires exact action data and a roster revision for member commands', () => {
        const create = { ref, expectedRosterRevision: null, intent: { action: 'create' } };
        expect(decodePartyRequest(create)).toEqual(create);
        expect(() => decodePartyRequest({ ...create, intent: { action: 'leave' } })).toThrow();
        expect(() => decodePartyRequest({ ...create, intent: { action: 'create', principalId: 'other' } })).toThrow();
        expect(() => decodePartyRequest({ ...create, ref: { ...ref, workspaceId: '../other' } })).toThrow();
        expect(() => decodePartyRequest({ ref, intent: { action: 'create' } })).toThrow();
        const invite = { ref, expectedRosterRevision: 4, intent: { action: 'invite', principalId: 'bob', invitationId: 'invite-bob' } };
        expect(decodePartyRequest(invite)).toEqual(invite);
        expect(() => decodePartyRequest({ ...invite, expectedRosterRevision: -1 })).toThrow();
        expect(() => decodePartyRequest({ ...invite, intent: { ...invite.intent, invitationId: 'x'.repeat(129) } })).toThrow();
    });

    it('binds result status to refusal and requires every field', () => {
        const result = { ref, principalId: 'alice', requestId: 'request', status: 'applied', code: null };
        expect(decodePartyMutationResult(result)).toEqual(result);
        expect(() => decodePartyMutationResult({ ...result, status: 'refused' })).toThrow();
        expect(() => decodePartyMutationResult({ ...result, code: 'party-full' })).toThrow();
        expect(() => decodePartyMutationResult({ ...result, status: 'refused', code: 'unknown' })).toThrow();
        expect(decodePartyMutationResult({ ...result, status: 'refused', code: 'party-full' }).code).toBe('party-full');
    });
});
