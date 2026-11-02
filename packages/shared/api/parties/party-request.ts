import {
    requireEpoch,
    requireExactKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '../exact-object-decoding.ts';
import { assertValidRallarRouteId } from '../rallar-validation.ts';
import type { PartyPolicy, PartyRef, PartyRefusal, PartyRosterIntent } from './party.ts';

export interface PartyRequest {
    readonly ref: PartyRef;
    readonly expectedRosterRevision: number | null;
    readonly intent: PartyRosterIntent;
}

export interface PartyMutationResult {
    readonly ref: PartyRef;
    readonly principalId: string;
    readonly requestId: string;
    readonly status: 'applied' | 'refused';
    readonly code: PartyRefusal | null;
}

export function decodePartyRef(value: unknown): PartyRef {
    const ref = requireRecord(value, 'Party reference');
    requireExactKeys(ref, ['applicationId', 'workspaceId', 'partyId'], 'Party reference');
    return {
        applicationId: assertValidRallarRouteId(ref.applicationId),
        workspaceId: assertValidRallarRouteId(ref.workspaceId),
        partyId: assertValidRallarRouteId(ref.partyId)
    };
}

export function decodePartyRequest(value: unknown): PartyRequest {
    const request = requireRecord(value, 'Party request');
    requireExactKeys(request, ['ref', 'expectedRosterRevision', 'intent'], 'Party request');
    const intent = decodePartyRosterIntent(request.intent);
    const ref = decodePartyRef(request.ref);
    const independent = intent.action === 'create' || intent.action === 'accept' || intent.action === 'decline';
    const expectedRosterRevision = request.expectedRosterRevision;
    if (expectedRosterRevision !== null) {
        requireEpoch(expectedRosterRevision, 'Expected party roster revision');
    }
    if (independent !== (expectedRosterRevision === null)) {
        throw new TypeError('Party roster consent does not match the requested action');
    }
    return { ref, expectedRosterRevision, intent };
}

function decodePartyRosterIntent(value: unknown): PartyRosterIntent {
    const intent = requireRecord(value, 'Party intent');
    const action = requireOneOf(intent.action, [
        'create',
        'leave',
        'disband',
        'take-leadership',
        'invite',
        'accept',
        'decline',
        'revoke',
        'transfer'
    ], 'Party action');
    switch (action) {
        case 'invite':
            requireExactKeys(intent, ['action', 'principalId', 'invitationId'], 'Party invitation');
            requireString(intent.principalId, 'Party invitation recipient');
            return {
                action,
                principalId: intent.principalId,
                invitationId: decodePartyInvitationId(intent.invitationId)
            };
        case 'accept':
        case 'decline':
        case 'revoke':
            requireExactKeys(intent, ['action', 'invitationId'], 'Party invitation response');
            return { action, invitationId: decodePartyInvitationId(intent.invitationId) };
        case 'transfer':
            requireExactKeys(intent, ['action', 'principalId'], 'Party leadership transfer');
            requireString(intent.principalId, 'Next party leader');
            return { action, principalId: intent.principalId };
        default:
            requireExactKeys(intent, ['action'], 'Party roster action');
            return { action };
    }
}

export function decodePartyInvitationId(value: unknown): string {
    const identity = assertValidRallarRouteId(value, '$', 'Party invitation identity');
    if (identity.length > 128) {
        throw new TypeError('Party invitation identity is too long');
    }
    return identity;
}

export function decodePartyPolicy(value: unknown): PartyPolicy {
    const policy = requireRecord(value, 'Party policy');
    requireExactKeys(policy, ['maxMembers', 'maxInvitations', 'invitationLifetimeMs'], 'Party policy');
    requireEpoch(policy.maxMembers, 'Party member limit');
    requireEpoch(policy.maxInvitations, 'Party invitation limit');
    requireEpoch(policy.invitationLifetimeMs, 'Party invitation lifetime');
    if (
        policy.maxMembers < 2 || policy.maxMembers > 16 || policy.maxInvitations < 1 || policy.maxInvitations > 256 ||
        policy.invitationLifetimeMs < 1000 || policy.invitationLifetimeMs > 86_400_000
    ) {
        throw new TypeError('Party policy is outside supported bounds');
    }
    return {
        maxMembers: policy.maxMembers,
        maxInvitations: policy.maxInvitations,
        invitationLifetimeMs: policy.invitationLifetimeMs
    };
}

export function decodePartyMutationResult(value: unknown): PartyMutationResult {
    const result = requireRecord(value, 'Party result');
    requireExactKeys(result, ['ref', 'principalId', 'requestId', 'status', 'code'], 'Party result');
    requireString(result.principalId, 'Party result account');
    requireString(result.requestId, 'Party result request');
    const status = requireOneOf(result.status, ['applied', 'refused'], 'Party result status');
    const code = result.code === null ? null : requireOneOf(result.code, [
        'unauthorized',
        'already-in-party',
        'party-unavailable',
        'party-changed',
        'party-full',
        'invitation-capacity',
        'invitation-unavailable',
        'person-unavailable',
        'member-required',
        'leader-required',
        'leader-present',
        'member-away'
    ], 'Party refusal');
    if ((status === 'applied') !== (code === null)) {
        throw new TypeError('Party result and refusal disagree');
    }
    return {
        ref: decodePartyRef(result.ref),
        principalId: result.principalId,
        requestId: result.requestId,
        status,
        code
    };
}
