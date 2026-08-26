import {
    groupMemberEventType,
    transitionGroupMemberLifecycle
} from '@shared-server/rallar-system/group-state/mutation/membership/transition-group-member-lifecycle.ts';
import type { AuditStamp } from '@shared/api/group-types.ts';
import { describe, expect, it } from 'vitest';

const STAMP: AuditStamp = {
    atEpochMs: 1_700_000_000_000,
    actor: { kind: 'principal', principalId: 'alice' },
    reason: null,
    traceId: null,
    requestId: null
};

const BASE = {
    applicationId: 'app',
    workspaceId: 'ws',
    groupId: 'room-1',
    principalId: 'alice',
    role: 'member' as const,
    joined: null,
    updated: STAMP,
    left: null,
    removed: null,
    banned: null,
    invitedByPrincipalId: null,
    invitationExpiresAtEpochMs: null
};

describe('group member lifecycle transitions for pending admission', () => {
    // The park: a pending member carries no joined stamp and no terminal
    // stamps, exactly like an invited member (plan decision 5.1).
    it('parks with cleared stamps', () => {
        const member = transitionGroupMemberLifecycle(BASE, 'pending', STAMP);

        expect(member.status).toBe('pending');
        expect(member.joined).toBeNull();
        expect(member.left).toBeNull();
        expect(member.removed).toBeNull();
        expect(member.banned).toBeNull();
    });

    it('grant stamps joined exactly like invite acceptance', () => {
        const pending = transitionGroupMemberLifecycle(BASE, 'pending', STAMP);
        const granted = transitionGroupMemberLifecycle(pending, 'active', STAMP);

        expect(granted.status).toBe('active');
        expect(granted.joined).toEqual(STAMP);
    });

    it('decline mirrors invite revoke into left', () => {
        const pending = transitionGroupMemberLifecycle(BASE, 'pending', STAMP);
        const declined = transitionGroupMemberLifecycle(pending, 'left', STAMP);

        expect(declined.status).toBe('left');
        expect(declined.left).toEqual(STAMP);
        expect(declined.banned).toBeNull();
    });

    it('maps the park to its own event type', () => {
        expect(groupMemberEventType('pending')).toBe('member-admission-requested');
    });
});
