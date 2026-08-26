import { canGovernGroupMember, canUpdateGroupSnapshot } from '@shared-server/rallar-system/group-state/policy/group-governance-policy.ts';
import {
    canChangeGroupLifecycle,
    canCommandGroupLifecycleTransition,
    canMutateActiveGroup,
    shouldPlanGroupPurge
} from '@shared-server/rallar-system/group-state/policy/group-lifecycle-policy.ts';
import {
    canActivateGroupMember,
    canConnectGroupPresenceSession,
    canJoinGroup
} from '@shared-server/rallar-system/group-state/policy/group-membership-admission-policy.ts';
import { canSendGroupMessage } from '@shared-server/rallar-system/group-state/policy/group-message-policy.ts';
import type { GroupPolicyActor } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
import { canReadGroupSnapshot, readGroupVisibility } from '@shared-server/rallar-system/group-state/policy/group-snapshot-visibility-policy.ts';
import { computeGroupAdmissionDecision } from '@shared/api/group-lifecycle/compute-group-admission-decision.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupPolicyReasonCode } from '@shared/api/group-policy-types.ts';
import { GROUP_POLICY_REASON_CODES } from '@shared/api/group-policy-types.ts';
import type { AuditStamp, Group, GroupMember, GroupPresenceSession, GroupSnapshot } from '@shared/api/group-types.ts';
import { describe, expect, it } from 'vitest';
import { createTestGroup } from '../../../create-test-group.ts';

const NOW = 1_000;
const ACTOR: GroupPolicyActor = {
    principalId: 'alice',
    sessionId: 'alice-session'
};

describe('group policy helpers', () => {
    it('evaluates join policy from group lifecycle, join mode, member status, and capacity inputs', () => {
        expect(canJoinGroup({ snapshot: snapshot(), actor: actor('carol') })).toEqual({
            allowed: true
        });
        expect(
            canJoinGroup({
                snapshot: snapshot({ joinMode: 'invite-only' }),
                actor: actor('carol')
            })
        ).toMatchObject(denied('group-invite-required'));
        expect(
            canJoinGroup({
                snapshot: snapshot({
                    joinMode: 'invite-only',
                    members: [member('carol', { status: 'invited', invitationExpiresAtEpochMs: NOW - 1 })]
                }),
                actor: actor('carol'),
                nowEpochMs: NOW
            })
        ).toMatchObject(denied('group-invite-expired'));
        expect(
            canJoinGroup({
                snapshot: snapshot({
                    joinMode: 'invite-only',
                    members: [member('carol', { status: 'invited', invitationExpiresAtEpochMs: NOW + 1 })]
                }),
                actor: actor('carol'),
                nowEpochMs: NOW
            })
        ).toEqual({ allowed: true });
        expect(
            canJoinGroup({
                snapshot: snapshot({ joinMode: 'code' }),
                actor: actor('carol')
            })
        ).toMatchObject(denied('group-code-required'));
        expect(
            canJoinGroup({
                snapshot: snapshot({ joinMode: 'code' }),
                actor: actor('carol'),
                joinCode: 'wrong',
                expectedJoinCode: 'right'
            })
        ).toMatchObject(denied('group-code-invalid'));
        expect(
            canJoinGroup({
                snapshot: snapshot({
                    members: [member('alice'), member('carol', { status: 'removed' })]
                }),
                actor: actor('carol')
            })
        ).toMatchObject(denied('member-removed'));
        expect(
            canJoinGroup({
                snapshot: snapshot({
                    members: [member('alice'), member('carol', { status: 'banned' })]
                }),
                actor: actor('carol')
            })
        ).toMatchObject(denied('member-banned'));
        expect(
            canJoinGroup({
                snapshot: snapshot({
                    maxMembers: 1,
                    members: [member('alice')]
                }),
                actor: actor('carol')
            })
        ).toMatchObject(denied('group-full'));
    });

    it('evaluates presence policy from active membership, lifecycle, and session caps', () => {
        expect(
            canConnectGroupPresenceSession({
                snapshot: snapshot({ activeSessions: [session('alice-session', 'alice')] }),
                actor: ACTOR,
                sessionId: 'alice-session',
                nowEpochMs: NOW
            })
        ).toEqual({ allowed: true });
        expect(
            canConnectGroupPresenceSession({
                snapshot: snapshot({ status: 'archived' }),
                actor: ACTOR,
                sessionId: 'alice-session'
            })
        ).toMatchObject(denied('group-archived'));
        expect(
            canConnectGroupPresenceSession({
                snapshot: snapshot({ status: 'deleted' }),
                actor: ACTOR,
                sessionId: 'alice-session'
            })
        ).toMatchObject(denied('group-deleted'));
        expect(
            canConnectGroupPresenceSession({
                snapshot: snapshot({
                    members: [member('alice', { status: 'left' })]
                }),
                actor: ACTOR,
                sessionId: 'alice-session'
            })
        ).toMatchObject(denied('member-not-active'));
        expect(
            canConnectGroupPresenceSession({
                snapshot: snapshot({
                    maxSessionsPerMember: 1,
                    activeSessions: [session('alice-session-1', 'alice')]
                }),
                actor: ACTOR,
                sessionId: 'alice-session-2',
                nowEpochMs: NOW
            })
        ).toMatchObject(denied('member-session-limit-reached'));
    });

    it('evaluates active-member capacity without applying admission mode', () => {
        expect(
            canActivateGroupMember({
                snapshot: snapshot({
                    joinMode: 'invite-only',
                    maxMembers: 2,
                    members: [member('alice'), member('bob', { status: 'invited' })]
                }),
                targetPrincipalId: 'carol',
                nowEpochMs: NOW
            })
        ).toEqual({ allowed: true });
        expect(
            canActivateGroupMember({
                snapshot: snapshot({
                    joinMode: 'invite-only',
                    maxMembers: 1,
                    members: [member('alice')]
                }),
                targetPrincipalId: 'carol',
                nowEpochMs: NOW
            })
        ).toMatchObject(denied('group-full'));
    });

    it('evaluates lifecycle-only mutation policy without admission or capacity checks', () => {
        expect(canMutateActiveGroup({ group: snapshot({ maxMembers: 1 }).group })).toEqual({
            allowed: true
        });
        expect(
            canMutateActiveGroup({
                group: snapshot({ expiresAtEpochMs: NOW - 1 }).group,
                nowEpochMs: NOW
            })
        ).toMatchObject(denied('group-not-active'));
        expect(canMutateActiveGroup({ group: snapshot({ status: 'archived' }).group })).toMatchObject(denied('group-archived'));
        expect(canMutateActiveGroup({ group: snapshot({ status: 'deleted' }).group })).toMatchObject(denied('group-deleted'));
    });

    it('plans purge eligibility from purgeAfterEpochMs without mutating state', () => {
        expect(
            shouldPlanGroupPurge({
                group: snapshot({ purgeAfterEpochMs: NOW - 1 }).group,
                nowEpochMs: NOW
            })
        ).toBe(true);
        expect(
            shouldPlanGroupPurge({
                group: snapshot({ purgeAfterEpochMs: NOW + 1 }).group,
                nowEpochMs: NOW
            })
        ).toBe(false);
        expect(
            shouldPlanGroupPurge({
                group: snapshot().group,
                nowEpochMs: NOW
            })
        ).toBe(false);
    });

    it('classifies read visibility for full state, invite metadata, directory metadata, and hidden groups', () => {
        expect(readGroupVisibility({ snapshot: snapshot(), actor: ACTOR })).toBe('full');
        expect(
            readGroupVisibility({
                snapshot: snapshot({
                    members: [member('alice', { status: 'invited' })]
                }),
                actor: ACTOR
            })
        ).toBe('invite');
        expect(
            readGroupVisibility({
                snapshot: snapshot({
                    members: [member('alice', { status: 'pending' })]
                }),
                actor: ACTOR
            })
        ).toBe('invite');
        expect(
            readGroupVisibility({
                snapshot: snapshot({ joinMode: 'open' }),
                actor: actor('carol')
            })
        ).toBe('directory');
        expect(
            readGroupVisibility({
                snapshot: snapshot({ joinMode: 'invite-only' }),
                actor: actor('carol')
            })
        ).toBe('none');
        expect(
            readGroupVisibility({
                snapshot: snapshot({ members: [member('alice', { status: 'removed' })] }),
                actor: ACTOR
            })
        ).toBe('none');
        expect(
            readGroupVisibility({
                snapshot: snapshot({ members: [member('alice', { status: 'banned' })] }),
                actor: ACTOR
            })
        ).toBe('none');
        expect(
            readGroupVisibility({
                snapshot: snapshot({ status: 'deleted' }),
                actor: ACTOR
            })
        ).toBe('none');
    });

    it('evaluates full snapshot reads for active, invited, non-member, removed, banned, and deleted cases', () => {
        expect(canReadGroupSnapshot({ snapshot: snapshot(), actor: ACTOR })).toEqual({ allowed: true });
        expect(
            canReadGroupSnapshot({
                snapshot: snapshot({
                    members: [member('alice', { status: 'invited' })]
                }),
                actor: ACTOR
            })
        ).toMatchObject(denied('group-policy-denied'));
        expect(
            canReadGroupSnapshot({
                snapshot: snapshot(),
                actor: actor('carol')
            })
        ).toMatchObject(denied('group-policy-denied'));
        expect(
            canReadGroupSnapshot({
                snapshot: snapshot({ members: [member('alice', { status: 'removed' })] }),
                actor: ACTOR
            })
        ).toMatchObject(denied('member-removed'));
        expect(
            canReadGroupSnapshot({
                snapshot: snapshot({ members: [member('alice', { status: 'banned' })] }),
                actor: ACTOR
            })
        ).toMatchObject(denied('member-banned'));
        expect(
            canReadGroupSnapshot({
                snapshot: snapshot({ status: 'deleted' }),
                actor: ACTOR
            })
        ).toMatchObject(denied('group-deleted'));
    });

    it('evaluates lifecycle changes for owner/admin/member actors', () => {
        expect(
            canChangeGroupLifecycle({
                snapshot: snapshot(),
                actor: ACTOR,
                targetStatus: 'archived'
            })
        ).toEqual({ allowed: true });
        expect(
            canChangeGroupLifecycle({
                snapshot: snapshot({
                    members: [member('alice', { role: 'member' })]
                }),
                actor: ACTOR,
                targetStatus: 'archived'
            })
        ).toMatchObject(denied('forbidden-role'));
    });

    it('evaluates group update policy for active owners/admins only', () => {
        expect(
            canUpdateGroupSnapshot({
                snapshot: snapshot(),
                actor: ACTOR
            })
        ).toEqual({ allowed: true });
        expect(
            canUpdateGroupSnapshot({
                snapshot: snapshot({
                    members: [member('alice', { role: 'admin' })]
                }),
                actor: ACTOR
            })
        ).toEqual({ allowed: true });
        expect(
            canUpdateGroupSnapshot({
                snapshot: snapshot({
                    members: [member('alice', { role: 'member' })]
                }),
                actor: ACTOR
            })
        ).toMatchObject(denied('forbidden-role'));
        expect(
            canUpdateGroupSnapshot({
                snapshot: snapshot({
                    members: [member('alice', { role: 'owner', status: 'left' })]
                }),
                actor: ACTOR
            })
        ).toMatchObject(denied('member-not-active'));
        expect(
            canUpdateGroupSnapshot({
                snapshot: snapshot({ status: 'archived' }),
                actor: ACTOR
            })
        ).toMatchObject(denied('group-archived'));
    });

    it('evaluates governance actions and protects the last owner', () => {
        expect(
            canGovernGroupMember({
                snapshot: snapshot(),
                actor: ACTOR,
                targetPrincipalId: 'bob',
                action: 'ban'
            })
        ).toEqual({ allowed: true });
        expect(
            canGovernGroupMember({
                snapshot: snapshot({
                    members: [member('alice', { role: 'admin' }), member('bob', { role: 'owner' })]
                }),
                actor: ACTOR,
                targetPrincipalId: 'bob',
                action: 'remove'
            })
        ).toMatchObject(denied('forbidden-role'));
        expect(
            canGovernGroupMember({
                snapshot: snapshot({
                    members: [member('alice', { role: 'admin' }), member('bob')]
                }),
                actor: ACTOR,
                targetPrincipalId: 'bob',
                action: 'transfer-ownership'
            })
        ).toMatchObject(denied('forbidden-role'));
        expect(
            canGovernGroupMember({
                snapshot: snapshot(),
                actor: ACTOR,
                targetPrincipalId: 'alice',
                action: 'demote'
            })
        ).toMatchObject(denied('last-owner'));
    });

    it('evaluates room message sends for stale snapshots, live sessions, lifecycle, and member status', () => {
        expect(
            canSendGroupMessage({
                snapshot: snapshot({ activeSessions: [session('alice-session', 'alice')] }),
                actor: ACTOR,
                senderSessionId: 'alice-session',
                nowEpochMs: NOW
            })
        ).toEqual({ allowed: true });
        // Plan decision 5.4: blocked-until-active gates only before activation,
        // and an absent value leaves application data ungated.
        expect(
            canSendGroupMessage({
                snapshot: snapshot({
                    lifecycleState: 'establishing',
                    activeSessions: [session('alice-session', 'alice')]
                }),
                actor: ACTOR,
                senderSessionId: 'alice-session',
                preActivationAppData: 'blocked-until-active'
            })
        ).toMatchObject(denied('group-data-blocked-until-active'));
        expect(
            canSendGroupMessage({
                snapshot: snapshot({ activeSessions: [session('alice-session', 'alice')] }),
                actor: ACTOR,
                senderSessionId: 'alice-session',
                preActivationAppData: 'blocked-until-active'
            })
        ).toEqual({ allowed: true });
        expect(
            canSendGroupMessage({
                snapshot: snapshot({
                    lifecycleState: 'establishing',
                    activeSessions: [session('alice-session', 'alice')]
                }),
                actor: ACTOR,
                senderSessionId: 'alice-session'
            })
        ).toEqual({ allowed: true });
        expect(
            canSendGroupMessage({
                snapshot: snapshot({
                    snapshotVersion: 1,
                    activeSessions: [session('alice-session', 'alice')]
                }),
                actor: ACTOR,
                senderSessionId: 'alice-session',
                minSnapshotVersion: 2
            })
        ).toMatchObject(denied('group-policy-denied'));
        expect(
            canSendGroupMessage({
                snapshot: snapshot({
                    status: 'archived',
                    activeSessions: [session('alice-session', 'alice')]
                }),
                actor: ACTOR,
                senderSessionId: 'alice-session'
            })
        ).toMatchObject(denied('group-archived'));
        expect(
            canSendGroupMessage({
                snapshot: snapshot({ activeSessions: [] }),
                actor: ACTOR,
                senderSessionId: 'alice-session'
            })
        ).toMatchObject(denied('member-not-active'));
        expect(
            canSendGroupMessage({
                snapshot: snapshot({
                    members: [member('alice', { status: 'banned' })],
                    activeSessions: [session('alice-session', 'alice')]
                }),
                actor: ACTOR,
                senderSessionId: 'alice-session'
            })
        ).toMatchObject(denied('member-banned'));
    });

    it('covers every initial policy reason code with pure helper scenarios', () => {
        const coveredCodes = new Set<GroupPolicyReasonCode>([
            expectCode(canReadGroupSnapshot({ snapshot: snapshot(), actor: actor('carol') })),
            expectCode(canJoinGroup({ snapshot: snapshot({ joinMode: 'invite-only' }), actor: actor('carol') })),
            expectCode(canJoinGroup({ snapshot: snapshot({ joinMode: 'code' }), actor: actor('carol') })),
            expectCode(
                canJoinGroup({
                    snapshot: snapshot({ joinMode: 'code' }),
                    actor: actor('carol'),
                    joinCode: 'wrong',
                    expectedJoinCode: 'right'
                })
            ),
            expectCode(
                canJoinGroup({
                    snapshot: snapshot({
                        joinMode: 'invite-only',
                        members: [member('carol', { status: 'invited', invitationExpiresAtEpochMs: NOW - 1 })]
                    }),
                    actor: actor('carol'),
                    nowEpochMs: NOW
                })
            ),
            expectCode(canJoinGroup({ snapshot: snapshot({ status: 'archived' }), actor: actor('carol') })),
            expectCode(canJoinGroup({ snapshot: snapshot({ status: 'deleted' }), actor: actor('carol') })),
            expectCode(
                canJoinGroup({
                    snapshot: snapshot({ expiresAtEpochMs: NOW - 1 }),
                    actor: actor('carol'),
                    nowEpochMs: NOW
                })
            ),
            expectCode(canJoinGroup({ snapshot: snapshot({ maxMembers: 1 }), actor: actor('carol') })),
            expectCode(
                canConnectGroupPresenceSession({
                    snapshot: snapshot({
                        maxSessionsPerMember: 1,
                        activeSessions: [session('alice-session-1', 'alice')]
                    }),
                    actor: ACTOR,
                    sessionId: 'alice-session-2',
                    nowEpochMs: NOW
                })
            ),
            expectCode(
                canConnectGroupPresenceSession({
                    snapshot: snapshot({ members: [member('alice', { status: 'left' })] }),
                    actor: ACTOR,
                    sessionId: 'alice-session'
                })
            ),
            expectCode(
                canJoinGroup({
                    snapshot: snapshot({
                        members: [member('alice'), member('carol', { status: 'removed' })]
                    }),
                    actor: actor('carol')
                })
            ),
            expectCode(
                canJoinGroup({
                    snapshot: snapshot({ members: [member('alice'), member('carol', { status: 'banned' })] }),
                    actor: actor('carol')
                })
            ),
            expectCode(
                canChangeGroupLifecycle({
                    snapshot: snapshot({ members: [member('alice', { role: 'member' })] }),
                    actor: ACTOR,
                    targetStatus: 'archived'
                })
            ),
            expectCode(
                canGovernGroupMember({
                    snapshot: snapshot(),
                    actor: ACTOR,
                    targetPrincipalId: 'alice',
                    action: 'demote'
                })
            ),
            expectCode(
                canCommandGroupLifecycleTransition({
                    snapshot: snapshot({ lifecycleState: 'active' }),
                    actor: ACTOR,
                    policy: resolveGroupLifecyclePolicyPreset('optimistic'),
                    transition: 'start-establishment',
                    activeMemberPrincipalIds: [ACTOR.principalId ?? '']
                })
            ),
            expectCode(
                canCommandGroupLifecycleTransition({
                    // An empty electorate resolves zero managers, covering the
                    // lifecycle-manager-unavailable reason code.
                    snapshot: snapshot({ lifecycleState: 'forming', formationElectorate: [] }),
                    actor: ACTOR,
                    policy: resolveGroupLifecyclePolicyPreset('match'),
                    transition: 'start-establishment',
                    activeMemberPrincipalIds: [ACTOR.principalId ?? '']
                })
            ),
            expectCode(
                toAdmissionResult(
                    computeGroupAdmissionDecision({
                        admission: { mode: 'closed', untilEpochMs: null, untilMemberCount: null },
                        lifecycleState: 'active',
                        activeMemberCount: 1,
                        invited: false,
                        nowEpochMs: NOW
                    })
                )
            ),
            expectCode(
                toAdmissionResult(
                    computeGroupAdmissionDecision({
                        admission: { mode: 'open', untilEpochMs: NOW, untilMemberCount: null },
                        lifecycleState: 'forming',
                        activeMemberCount: 1,
                        invited: false,
                        nowEpochMs: NOW
                    })
                )
            ),
            expectCode(
                toAdmissionResult(
                    computeGroupAdmissionDecision({
                        admission: { mode: 'open', untilEpochMs: null, untilMemberCount: 1 },
                        lifecycleState: 'forming',
                        activeMemberCount: 1,
                        invited: false,
                        nowEpochMs: NOW
                    })
                )
            ),
            expectCode(
                canSendGroupMessage({
                    snapshot: snapshot({
                        lifecycleState: 'establishing',
                        activeSessions: [session('alice-session', 'alice')]
                    }),
                    actor: ACTOR,
                    senderSessionId: 'alice-session',
                    preActivationAppData: 'blocked-until-active'
                })
            )
        ]);

        expect([...GROUP_POLICY_REASON_CODES].filter((code) => !coveredCodes.has(code))).toEqual([]);
    });

    it('applies the configured default member cap only when the stored cap is null', () => {
        const capacity = { defaultMaxMembers: 256 };
        expect(
            canJoinGroup({
                snapshot: snapshot({ activeMemberCount: 256 }),
                actor: actor('carol'),
                capacity
            })
        ).toMatchObject(denied('group-full'));
        expect(
            canJoinGroup({
                snapshot: snapshot({ activeMemberCount: 255 }),
                actor: actor('carol'),
                capacity
            })
        ).toEqual({ allowed: true });
        expect(
            canActivateGroupMember({
                snapshot: snapshot({ activeMemberCount: 256 }),
                targetPrincipalId: 'carol',
                nowEpochMs: NOW,
                capacity
            })
        ).toMatchObject(denied('group-full'));
        expect(
            canJoinGroup({
                snapshot: snapshot({ activeMemberCount: 256 }),
                actor: ACTOR,
                capacity
            })
        ).toEqual({ allowed: true });
    });

    it('keeps null-cap groups uncapped when the default member cap is disabled or absent', () => {
        expect(
            canJoinGroup({
                snapshot: snapshot({ activeMemberCount: 100_000 }),
                actor: actor('carol'),
                capacity: { defaultMaxMembers: null }
            })
        ).toEqual({ allowed: true });
        expect(
            canJoinGroup({
                snapshot: snapshot({ activeMemberCount: 100_000 }),
                actor: actor('carol')
            })
        ).toEqual({ allowed: true });
    });

    it('lets an explicit stored member cap win over the configured default', () => {
        expect(
            canJoinGroup({
                snapshot: snapshot({ maxMembers: 1, activeMemberCount: 1 }),
                actor: actor('carol'),
                capacity: { defaultMaxMembers: 256 }
            })
        ).toMatchObject(denied('group-full'));
        expect(
            canJoinGroup({
                snapshot: snapshot({ maxMembers: 500, activeMemberCount: 256 }),
                actor: actor('carol'),
                capacity: { defaultMaxMembers: 256 }
            })
        ).toEqual({ allowed: true });
    });
});

function denied(code: GroupPolicyReasonCode) {
    return {
        allowed: false,
        code
    };
}

function toAdmissionResult(decision: ReturnType<typeof computeGroupAdmissionDecision>): ReturnType<typeof canJoinGroup> {
    return decision.kind === 'deny' ? decision.denial : { allowed: true };
}

function expectCode(result: ReturnType<typeof canJoinGroup>): GroupPolicyReasonCode {
    expect(result.allowed).toBe(false);
    if (result.allowed) {
        throw new Error('Expected denied group policy result.');
    }
    return result.code;
}

function actor(principalId: string): GroupPolicyActor {
    return {
        principalId,
        sessionId: `${principalId}-session`
    };
}

function snapshot(
    options:
        & Partial<Group>
        & Readonly<{
            members?: readonly GroupMember[];
            activeSessions?: readonly GroupPresenceSession[];
        }> = {}
): GroupSnapshot {
    const members = options.members ?? [member('alice', { role: 'owner' })];
    const activeSessions = options.activeSessions ?? [];
    const common = createTestGroup({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1',
        slug: options.slug ?? null,
        displayName: options.displayName ?? 'Room 1',
        description: options.description ?? null,
        kind: options.kind ?? 'room',
        joinMode: options.joinMode ?? 'open',
        maxMembers: options.maxMembers ?? null,
        maxSessionsPerMember: options.maxSessionsPerMember ?? null,
        metadata: options.metadata ?? {},
        snapshotVersion: options.snapshotVersion ?? 1,
        metadataVersion: options.metadataVersion ?? 1,
        rosterVersion: options.rosterVersion ?? 1,
        presenceVersion: options.presenceVersion ?? 1,
        created: options.created ?? audit(1),
        updated: options.updated ?? audit(1),
        expiresAtEpochMs: options.expiresAtEpochMs ?? null,
        emptySinceEpochMs: options.emptySinceEpochMs ?? null,
        purgeAfterEpochMs: options.purgeAfterEpochMs ?? null,
        activeMemberCount: options.activeMemberCount ?? members.filter((entry) => entry.status === 'active').length,
        ownerPrincipalId: options.ownerPrincipalId ?? members.find((entry) => entry.status === 'active' && entry.role === 'owner')?.principalId ?? 'alice',
        ...(options.lifecycleState === undefined ? {} : { lifecycleState: options.lifecycleState }),
        ...(options.formationElectorate === undefined ? {} : { formationElectorate: options.formationElectorate })
    });
    const group: Group = options.status === 'archived'
        ? {
            ...common,
            status: 'archived',
            archived: options.archived ?? audit(1),
            deleted: null
        }
        : options.status === 'deleted'
        ? {
            ...common,
            status: 'deleted',
            archived: options.archived ?? null,
            deleted: options.deleted ?? audit(1)
        }
        : {
            ...common,
            status: 'active',
            archived: null,
            deleted: null
        };

    return {
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        group,
        members,
        activeSessions,
        memberCount: members.filter((entry) => entry.status === 'active').length,
        onlineMemberCount: new Set(activeSessions.map((entry) => entry.principalId)).size
    };
}

function member(principalId: string, options: Partial<GroupMember> = {}): GroupMember {
    const common = {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1',
        principalId,
        role: options.role ?? 'member',
        joined: options.joined ?? audit(1),
        updated: options.updated ?? audit(1),
        invitedByPrincipalId: options.invitedByPrincipalId ?? null,
        invitationExpiresAtEpochMs: options.invitationExpiresAtEpochMs ?? null
    };
    if (options.status === 'left') {
        return {
            ...common,
            status: 'left',
            left: options.left ?? audit(1),
            removed: null,
            banned: null
        };
    }
    if (options.status === 'removed') {
        return {
            ...common,
            status: 'removed',
            left: null,
            removed: options.removed ?? audit(1),
            banned: null
        };
    }
    if (options.status === 'banned') {
        return {
            ...common,
            status: 'banned',
            left: null,
            removed: null,
            banned: options.banned ?? audit(1)
        };
    }
    if (options.status === 'invited' || options.status === 'pending') {
        return {
            ...common,
            status: options.status,
            joined: null,
            left: null,
            removed: null,
            banned: null
        };
    }
    return {
        ...common,
        status: 'active',
        left: null,
        removed: null,
        banned: null
    };
}

function session(sessionId: string, principalId: string, options: Partial<GroupPresenceSession> = {}): GroupPresenceSession {
    const common = {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1',
        sessionId,
        principalId,
        generationId: options.generationId ?? `${sessionId}-generation`,
        generationVersion: options.generationVersion ?? 1,
        connectedAtEpochMs: options.connectedAtEpochMs ?? 1,
        lastHeartbeatAtEpochMs: options.lastHeartbeatAtEpochMs ?? NOW,
        expiresAtEpochMs: options.expiresAtEpochMs ?? NOW + 1_000
    };
    if (options.status === 'disconnected') {
        return {
            ...common,
            status: 'disconnected',
            disconnectedAtEpochMs: options.disconnectedAtEpochMs ?? NOW,
            disconnectReason: options.disconnectReason ?? 'disconnected'
        };
    }
    return {
        ...common,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

function audit(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
}
