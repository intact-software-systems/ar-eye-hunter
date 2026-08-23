import { describe, expect, it } from 'vitest';

import { canCommandGroupLifecycleTransition } from '@shared-server/rallar-system/group-state/policy/group-lifecycle-policy.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupLifecycleTransition } from '@shared/api/group-lifecycle/group-lifecycle-transitions.ts';
import type { Group, GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';
import { createTestGroup } from '../../create-test-group.ts';

function member(principalId: string, role: GroupMember['role']): GroupMember {
    const audit = {
        atEpochMs: 1,
        actor: { kind: 'principal' as const, principalId },
        reason: null,
        traceId: null,
        requestId: null
    };
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1',
        principalId,
        role,
        status: 'active',
        joined: audit,
        updated: audit,
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null
    };
}

function snapshot(overrides: Partial<Group>, members: readonly GroupMember[]): GroupSnapshot {
    const group = createTestGroup(overrides);
    return {
        causalRevision: { groupRevision: 1, presenceRevision: 0 },
        group,
        members,
        activeSessions: [],
        memberCount: members.length,
        onlineMemberCount: 0
    };
}

interface CommandCase {
    readonly overrides: Partial<Group>;
    readonly members: readonly GroupMember[];
    readonly actorPrincipalId: string;
    readonly policy: GroupLifecyclePolicy;
    readonly transition?: GroupLifecycleTransition;
    /** Defaults to every active member of `members`; override to model departures. */
    readonly activeMemberPrincipalIds?: readonly string[];
}

function command(commandCase: CommandCase) {
    return canCommandGroupLifecycleTransition({
        snapshot: snapshot(commandCase.overrides, commandCase.members),
        actor: { principalId: commandCase.actorPrincipalId },
        policy: commandCase.policy,
        transition: commandCase.transition ?? 'start-establishment',
        activeMemberPrincipalIds: commandCase.activeMemberPrincipalIds ??
            commandCase.members.filter((candidate) => candidate.status === 'active').map((candidate) => candidate.principalId)
    });
}

function withManager(policy: GroupLifecyclePolicy, manager: Partial<GroupLifecyclePolicy['manager']>): GroupLifecyclePolicy {
    return { ...policy, manager: { ...policy.manager, ...manager } };
}

const OPTIMISTIC = resolveGroupLifecyclePolicyPreset('optimistic');
const MANAGED = resolveGroupLifecyclePolicyPreset('managed');
const MATCH = resolveGroupLifecyclePolicyPreset('match');
const DROP_IN = resolveGroupLifecyclePolicyPreset('drop-in-social');

describe('canCommandGroupLifecycleTransition', () => {
    it('lets any active member start establishment under any-member', () => {
        const result = command({
            overrides: { lifecycleState: 'forming' },
            members: [member('alice', 'owner'), member('bob', 'member')],
            actorPrincipalId: 'bob',
            policy: OPTIMISTIC
        });
        expect(result).toEqual({ allowed: true });
    });

    it('requires an active membership before any policy question', () => {
        const result = command({
            overrides: { lifecycleState: 'forming' },
            members: [member('alice', 'owner')],
            actorPrincipalId: 'mallory',
            policy: OPTIMISTIC
        });
        expect(result).toMatchObject({ allowed: false, code: 'member-not-active' });
    });

    it('resolves the manager to the creator under managed', () => {
        const members = [member('alice', 'owner'), member('bob', 'admin')];
        const forming: Partial<Group> = { lifecycleState: 'forming', ownerPrincipalId: 'alice' };
        expect(command({ overrides: forming, members, actorPrincipalId: 'alice', policy: MANAGED })).toEqual({ allowed: true });
        expect(command({ overrides: forming, members, actorPrincipalId: 'bob', policy: MANAGED })).toMatchObject({
            allowed: false,
            code: 'forbidden-role'
        });
    });

    it('honours assigned order and count: only the first count are managers', () => {
        const policy = withManager(MANAGED, {
            selection: 'assigned',
            assignedPrincipalIds: ['bob', 'carol'],
            count: 1
        });
        const members = [member('alice', 'owner'), member('bob', 'member'), member('carol', 'member')];
        const forming: Partial<Group> = { lifecycleState: 'forming' };
        expect(command({ overrides: forming, members, actorPrincipalId: 'bob', policy })).toEqual({
            allowed: true
        });
        expect(command({ overrides: forming, members, actorPrincipalId: 'carol', policy })).toMatchObject({
            allowed: false,
            code: 'forbidden-role'
        });
    });

    it('passes manager duty to the next assigned member when the first departs', () => {
        const policy = withManager(MANAGED, {
            selection: 'assigned',
            assignedPrincipalIds: ['bob', 'carol'],
            count: 1
        });
        const members = [member('alice', 'owner'), member('carol', 'member')];
        const result = command({
            overrides: { lifecycleState: 'forming' },
            members,
            actorPrincipalId: 'carol',
            policy,
            activeMemberPrincipalIds: ['alice', 'carol']
        });
        expect(result).toEqual({ allowed: true });
    });

    it('elects deterministically from the pinned electorate under match', () => {
        // Epoch 0 pins the creator alone, so the sole electable manager is alice.
        const members = [member('alice', 'owner'), member('bob', 'member')];
        const forming: Partial<Group> = { lifecycleState: 'forming', formationElectorate: ['alice'] };
        expect(command({ overrides: forming, members, actorPrincipalId: 'alice', policy: MATCH })).toEqual({ allowed: true });
        expect(command({ overrides: forming, members, actorPrincipalId: 'bob', policy: MATCH })).toMatchObject({
            allowed: false,
            code: 'forbidden-role'
        });
    });

    it('keeps the zero-manager fallback typed when nothing resolves', () => {
        // A corrupt empty electorate resolves nobody until the next epoch
        // advance re-pins it.
        expect(
            command({
                overrides: { lifecycleState: 'forming', formationElectorate: [] },
                members: [member('alice', 'owner')],
                actorPrincipalId: 'alice',
                policy: MATCH
            })
        ).toMatchObject({ allowed: false, code: 'lifecycle-manager-unavailable' });
        // A departed creator with no succession leaves a hole, never a stand-in.
        expect(
            command({
                overrides: { lifecycleState: 'forming', ownerPrincipalId: 'dana' },
                members: [member('alice', 'admin')],
                actorPrincipalId: 'alice',
                policy: withManager(MANAGED, { succession: 'none' })
            })
        ).toMatchObject({ allowed: false, code: 'lifecycle-manager-unavailable' });
    });

    it('reports elected-by-rank as unavailable while no rank source exists', () => {
        const result = command({
            overrides: { lifecycleState: 'forming' },
            members: [member('alice', 'owner')],
            actorPrincipalId: 'alice',
            policy: withManager(MATCH, { selection: 'elected-by-rank' })
        });
        expect(result).toMatchObject({ allowed: false, code: 'lifecycle-manager-unavailable' });
    });

    it('denies principal commands under server-auto', () => {
        const result = command({
            overrides: { lifecycleState: 'forming' },
            members: [member('alice', 'owner')],
            actorPrincipalId: 'alice',
            policy: DROP_IN
        });
        expect(result).toMatchObject({ allowed: false, code: 'forbidden-role' });
    });

    it('folds state validity into the same decision', () => {
        const result = command({
            overrides: { lifecycleState: 'active' },
            members: [member('alice', 'owner')],
            actorPrincipalId: 'alice',
            policy: OPTIMISTIC
        });
        expect(result).toMatchObject({ allowed: false, code: 'lifecycle-transition-invalid' });
    });

    it('authorizes activate and reopen-establishment against their own source states', () => {
        const members = [member('alice', 'owner')];
        expect(
            command({
                overrides: { lifecycleState: 'establishing' },
                members,
                actorPrincipalId: 'alice',
                policy: OPTIMISTIC,
                transition: 'activate'
            })
        ).toEqual({ allowed: true });
        expect(
            command({
                overrides: { lifecycleState: 'active' },
                members,
                actorPrincipalId: 'alice',
                policy: OPTIMISTIC,
                transition: 'reopen-establishment'
            })
        ).toEqual({ allowed: true });
    });
});
