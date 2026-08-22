import { GROUP_POLICY_REASON_CODES } from '@shared/api/group-policy-types.ts';
import type { GroupPolicyDenied, GroupPolicyReasonCode, GroupPolicyResult } from '@shared/api/group-policy-types.ts';
import type { StateErrorResponse } from '@shared/api/state-types.ts';
import { describe, expect, expectTypeOf, it } from 'vitest';

describe('group policy shared error types', () => {
    it('exports stable policy reason codes for browser-safe error handling', () => {
        expect(GROUP_POLICY_REASON_CODES).toContain('group-invite-required');
    });

    it('keeps legacy state error responses valid while allowing policy codes', () => {
        const legacy: StateErrorResponse = {
            error: 'Forbidden: legacy message'
        };
        const policy: StateErrorResponse = {
            error: 'Forbidden: invite required',
            code: 'group-invite-required',
            message: 'Invite required.',
            details: {
                groupId: 'room-1'
            }
        };

        expect(legacy.error).toBe('Forbidden: legacy message');
        expect(policy).toMatchObject({
            error: 'Forbidden: invite required',
            code: 'group-invite-required',
            message: 'Invite required.'
        });
    });

    it('models allowed and denied group policy results as a discriminated union', () => {
        const reason: GroupPolicyReasonCode = 'group-invite-required';
        const denied: GroupPolicyDenied = {
            allowed: false,
            code: reason,
            message: 'Invite required.'
        };
        const result: GroupPolicyResult = denied;

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.code).toBe('group-invite-required');
        }

        expectTypeOf<GroupPolicyResult>().toEqualTypeOf<
            | Readonly<{ allowed: true; }>
            | GroupPolicyDenied
        >();
    });
});
