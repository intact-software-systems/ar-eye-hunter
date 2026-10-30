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
import {
    canChangeGroupPublicationGrant,
    canHoldGroupPublicationTopics
} from '@shared-server/rallar-system/group-state/policy/group-publication-grant-policy.ts';
import { canReadGroupSnapshot, readGroupVisibility } from '@shared-server/rallar-system/group-state/policy/group-snapshot-visibility-policy.ts';
import {
    canSubscribeGroupTopic,
    type CanSubscribeGroupTopicInput
} from '@shared-server/rallar-system/group-state/policy/group-topic-subscription-policy.ts';
import { computeGroupAdmissionDecision } from '@shared/api/group-lifecycle/compute-group-admission-decision.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import { denyExhaustedFormationSeries } from '@shared/api/group-lifecycle/group-lifecycle-transitions.ts';
import type { GroupPolicyReasonCode } from '@shared/api/group-policy-types.ts';
import { GROUP_POLICY_REASON_CODES } from '@shared/api/group-policy-types.ts';
import type { GroupPublicationTopicGrants } from '@shared/api/group-publication/group-publication-grants.ts';
import type { AuditStamp, Group, GroupMember, GroupPresenceSession, GroupSnapshot } from '@shared/api/group-types.ts';
import { describe, expect, it } from 'vitest';
import { createTestGroup } from '../../../../create-test-group.ts';
import { createActiveClientSessionFixture } from '../../../../shared-web/authoritative-group-fixtures.ts';

const NOW = 1_000;
const ACTOR: GroupPolicyActor = {
    principalId: 'alice',
    sessionId: 'alice-session'
};

const SUBSCRIBE_SESSION = createActiveClientSessionFixture({
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    principalId: 'bob',
    clientInstanceId: 'bob-instance',
    sessionId: 'bob-session'
});

const SUBSCRIBE: CanSubscribeGroupTopicInput = {
    member: member('bob'),
    grant: {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1',
        principalId: 'bob',
        topics: { 'room.feed': { publish: false, subscribe: true } },
        updated: { atEpochMs: 1, actor: { kind: 'principal', principalId: 'alice' }, reason: null, traceId: null, requestId: null }
    },
    topicId: 'room.feed',
    clientSession: SUBSCRIBE_SESSION,
    connectionGenerationId: SUBSCRIBE_SESSION.generationId,
    nowEpochMs: NOW
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
                joinCodeVerifier: 'wrong-verifier',
                expectedJoinCodeVerifier: 'right-verifier'
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
        for (const lifecycleState of ['reconfiguring', 'reconnecting'] as const) {
            expect(
                canSendGroupMessage({
                    snapshot: snapshot({
                        lifecycleState,
                        activeSessions: [session('alice-session', 'alice')]
                    }),
                    actor: ACTOR,
                    senderSessionId: 'alice-session',
                    preActivationAppData: 'blocked-until-active'
                })
            ).toEqual({ allowed: true });
        }
        // Plan decision 5.4: blocked-until-active gates only before activation,
        // and an absent value leaves application data ungated.
        expect(
            canSendGroupMessage({
                snapshot: snapshot({
                    lifecycleState: 'connecting',
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
                    lifecycleState: 'connecting',
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
                    joinCodeVerifier: 'wrong-verifier',
                    expectedJoinCodeVerifier: 'right-verifier'
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
                    transition: 'plan',
                    activeMemberPrincipalIds: [ACTOR.principalId ?? '']
                })
            ),
            expectCode(
                // The budget is a precondition of the `start` transition, not
                // a clause of the initiator policy, so it answers from the
                // transitions module. The optimistic preset allows one attempt
                // and this group has spent it (product decision 37).
                denyExhaustedFormationSeries({
                    transition: 'start',
                    activation: resolveGroupLifecyclePolicyPreset('optimistic').activation,
                    formationAttemptCount: 1
                }) ?? { allowed: true }
            ),
            expectCode(
                canCommandGroupLifecycleTransition({
                    // An empty electorate resolves zero managers, covering the
                    // lifecycle-manager-unavailable reason code.
                    snapshot: snapshot({ lifecycleState: 'forming', formationElectorate: [] }),
                    actor: ACTOR,
                    policy: resolveGroupLifecyclePolicyPreset('match'),
                    transition: 'plan',
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
                        lifecycleState: 'connecting',
                        activeSessions: [session('alice-session', 'alice')]
                    }),
                    actor: ACTOR,
                    senderSessionId: 'alice-session',
                    preActivationAppData: 'blocked-until-active'
                })
            ),
            expectCode(canHoldGroupPublicationTopics(topicGrants(65))),
            expectCode(canSubscribeGroupTopic({ ...SUBSCRIBE, clientSession: null })),
            expectCode(canSubscribeGroupTopic({ ...SUBSCRIBE, connectionGenerationId: 'bob-ws-generation-0' })),
            expectCode(canSubscribeGroupTopic({ ...SUBSCRIBE, grant: null }))
        ]);

        expect([...GROUP_POLICY_REASON_CODES].filter((code) => !coveredCodes.has(code))).toEqual([]);
    });

    it('changes publication grants for active members only and never grants a spectator publish', () => {
        expect(canChangeGroupPublicationGrant({ target: member('bob'), grantsPublish: true })).toEqual({ allowed: true });
        expect(canChangeGroupPublicationGrant({ target: member('sam', { role: 'spectator' }), grantsPublish: false }))
            .toEqual({ allowed: true });
        expect(expectCode(canChangeGroupPublicationGrant({ target: member('sam', { role: 'spectator' }), grantsPublish: true })))
            .toBe('forbidden-role');
        expect(expectCode(canChangeGroupPublicationGrant({ target: undefined, grantsPublish: false }))).toBe('member-not-active');
        expect(expectCode(canChangeGroupPublicationGrant({ target: member('lee', { status: 'left' }), grantsPublish: false })))
            .toBe('member-not-active');
    });

    it('subscribes an active member\'s live session at its live generation to a topic it may subscribe', () => {
        expect(canSubscribeGroupTopic(SUBSCRIBE)).toEqual({ allowed: true });
        expect(canSubscribeGroupTopic({ ...SUBSCRIBE, member: member('bob', { role: 'spectator' }) })).toEqual({ allowed: true });
        expect(expectCode(canSubscribeGroupTopic({ ...SUBSCRIBE, member: member('bob', { status: 'left' }) })))
            .toBe('member-not-active');
        expect(expectCode(canSubscribeGroupTopic({ ...SUBSCRIBE, member: null }))).toBe('member-not-active');
        expect(expectCode(canSubscribeGroupTopic({ ...SUBSCRIBE, nowEpochMs: SUBSCRIBE_SESSION.expiresAtEpochMs })))
            .toBe('no-live-session');
        expect(expectCode(canSubscribeGroupTopic({ ...SUBSCRIBE, topicId: 'room.other' }))).toBe('no-subscribe-grant');
    });

    it('bounds one principal at 64 granted topics with a named capacity limit', () => {
        expect(canHoldGroupPublicationTopics(topicGrants(64))).toEqual({ allowed: true });
        expect(canHoldGroupPublicationTopics(topicGrants(65))).toMatchObject({
            allowed: false,
            code: 'capacity',
            details: { limit: 'topics-per-principal', max: 64 }
        });
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

type SnapshotOptions = Partial<Group> & Partial<Pick<GroupSnapshot, 'members' | 'activeSessions'>>;

function topicGrants(count: number): GroupPublicationTopicGrants {
    return Object.fromEntries(
        Array.from({ length: count }, (_, index) => [`room.topic-${index}`, { publish: true, subscribe: false }])
    );
}

function snapshot(options: SnapshotOptions = {}): GroupSnapshot {
    const { members: memberOverrides, activeSessions: sessionOverrides, ...groupOverrides } = options;
    const members = memberOverrides ?? [member('alice', { role: 'owner' })];
    const activeSessions = sessionOverrides ?? [];
    const common = createTestGroup({
        presenceVersion: 1,
        created: audit(1),
        updated: audit(1),
        activeMemberCount: members.filter((entry) => entry.status === 'active').length,
        ownerPrincipalId: members.find((entry) => entry.status === 'active' && entry.role === 'owner')?.principalId ??
            'alice',
        ...groupOverrides
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
        onlineMemberCount: new Set(activeSessions.map((entry) => entry.principalId)).size,
        publicationGrants: []
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
        return { ...common, status: 'left', left: options.left ?? audit(1), removed: null, banned: null };
    }
    if (options.status === 'removed') {
        return { ...common, status: 'removed', left: null, removed: options.removed ?? audit(1), banned: null };
    }
    if (options.status === 'banned') {
        return { ...common, status: 'banned', left: null, removed: null, banned: options.banned ?? audit(1) };
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
        connectionGenerationId: options.connectionGenerationId ?? `${sessionId}-generation`,
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
