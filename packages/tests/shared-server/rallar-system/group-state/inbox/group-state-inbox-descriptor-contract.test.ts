import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { type GroupMutationDescriptor } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import {
    AUTHENTICATED_GROUP_INBOX_TYPES,
    type AuthenticatedGroupMutationEnqueue
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import { toGroupMutationDescriptor } from '@shared-server/rallar-system/group-state/inbox/to-group-mutation-descriptor.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { SCOPE } from './group-state-inbox-test-runtime.ts';

const groupId = 'descriptor-room';
const actor = { actorPrincipalId: 'owner', actorSessionId: 'owner-session' };
const connectLayout: GroupLayoutIdentity = {
    groupRevision: 3,
    presenceRevision: 2,
    version: 1,
    state: 'active'
};

describe('GroupStateInboxService authenticated mutation descriptors', () => {
    it('maps every authenticated GROUP_* AppInbox variant to one exact descriptor', () => {
        // Totality first: a variant with no case would otherwise pass this
        // suite by never being exercised.
        const covered = new Set<AppInboxType>(descriptorCases.map((testCase) => testCase.enqueue.type));
        expect([...covered].sort()).toEqual([...AUTHENTICATED_GROUP_INBOX_TYPES].sort());

        for (const testCase of descriptorCases) {
            expect(toGroupMutationDescriptor(testCase.enqueue), testCase.name).toEqual(testCase.descriptor);
        }
    });

    it('rejects an AppInbox type outside the authenticated group family', () => {
        expect(() =>
            toGroupMutationDescriptor({
                type: AppInboxType.RTC_RTT_SUBMIT,
                resourceId: 'not-a-group-mutation',
                contextId: 'descriptor-contract',
                senderId: 'owner',
                data: {}
            } as never)
        ).toThrow('App inbox type is not an authenticated group mutation.');
    });
});

interface DescriptorCase {
    readonly name: string;
    readonly enqueue: AuthenticatedGroupMutationEnqueue;
    readonly descriptor: GroupMutationDescriptor;
}

const descriptorCases: readonly DescriptorCase[] = [
    {
        name: 'create',
        enqueue: {
            type: AppInboxType.GROUP_CREATE,
            topicId: AppInboxType.GROUP_CREATE,
            resourceId: 'create-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                request: {
                    groupId,
                    displayName: 'Descriptor room',
                    kind: 'room',
                    joinMode: 'open',
                    createdByPrincipalId: 'owner',
                    ...actor,
                    requestId: 'create'
                }
            }
        },
        descriptor: {
            operation: 'createGroup',
            scope: SCOPE,
            groupId,
            targetPrincipalId: null,
            sessionId: null,
            request: {
                groupId,
                displayName: 'Descriptor room',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'owner',
                ...actor,
                requestId: 'create'
            }
        }
    },
    {
        name: 'update',
        enqueue: {
            type: AppInboxType.GROUP_UPDATE,
            topicId: AppInboxType.GROUP_UPDATE,
            resourceId: 'update-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: { scope: SCOPE, groupId, request: { description: 'Updated', ...actor, requestId: 'update' } }
        },
        descriptor: {
            operation: 'updateGroup',
            scope: SCOPE,
            groupId,
            targetPrincipalId: null,
            sessionId: null,
            request: { description: 'Updated', ...actor, requestId: 'update' }
        }
    },
    {
        name: 'appoint-director',
        enqueue: {
            type: AppInboxType.GROUP_DIRECTOR_APPOINT,
            topicId: AppInboxType.GROUP_DIRECTOR_APPOINT,
            resourceId: 'appoint-director-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId,
                request: { ...actor, requestId: 'appoint-director' }
            }
        },
        descriptor: {
            operation: 'appointDirector',
            scope: SCOPE,
            groupId,
            targetPrincipalId: null,
            sessionId: null,
            request: { ...actor, requestId: 'appoint-director' }
        }
    },
    {
        name: 'plan',
        enqueue: {
            type: AppInboxType.GROUP_PLAN,
            topicId: AppInboxType.GROUP_PLAN,
            resourceId: 'plan-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: { scope: SCOPE, groupId, request: { ...actor, requestId: 'plan' } }
        },
        descriptor: { operation: 'planGroupLayout', scope: SCOPE, groupId, targetPrincipalId: null, sessionId: null, request: { ...actor, requestId: 'plan' } }
    },
    {
        name: 'connect',
        enqueue: {
            type: AppInboxType.GROUP_CONNECT,
            topicId: AppInboxType.GROUP_CONNECT,
            resourceId: 'connect-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId,
                request: {
                    expectedFormationEpoch: 4,
                    expectedLayout: connectLayout,
                    ...actor,
                    requestId: 'connect'
                }
            }
        },
        descriptor: {
            operation: 'connectGroup',
            scope: SCOPE,
            groupId,
            targetPrincipalId: null,
            sessionId: null,
            request: {
                expectedFormationEpoch: 4,
                expectedLayout: connectLayout,
                ...actor,
                requestId: 'connect'
            }
        }
    },
    {
        name: 'activate',
        enqueue: {
            type: AppInboxType.GROUP_ACTIVATE,
            topicId: AppInboxType.GROUP_ACTIVATE,
            resourceId: 'activate-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: { scope: SCOPE, groupId, request: { ...actor, requestId: 'activate' } }
        },
        descriptor: {
            operation: 'activateGroup',
            scope: SCOPE,
            groupId,
            targetPrincipalId: null,
            sessionId: null,
            request: { ...actor, requestId: 'activate' }
        }
    },
    {
        name: 'reconfigure',
        enqueue: {
            type: AppInboxType.GROUP_RECONFIGURE,
            topicId: AppInboxType.GROUP_RECONFIGURE,
            resourceId: 'reconfigure-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: { scope: SCOPE, groupId, request: { expectedFormationEpoch: null, landing: null, ...actor, requestId: 'reconfigure' } }
        },
        descriptor: {
            operation: 'reconfigureGroup',
            scope: SCOPE,
            groupId,
            targetPrincipalId: null,
            sessionId: null,
            request: { expectedFormationEpoch: null, landing: null, ...actor, requestId: 'reconfigure' }
        }
    },
    {
        name: 'join',
        enqueue: {
            type: AppInboxType.GROUP_JOIN,
            topicId: AppInboxType.GROUP_JOIN,
            resourceId: 'join-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: { scope: SCOPE, groupId, request: { ...actor, requestId: 'join' } }
        },
        descriptor: {
            operation: 'joinGroup',
            scope: SCOPE,
            groupId,
            targetPrincipalId: null,
            sessionId: null,
            request: {
                ...actor,
                requestId: 'join'
            }
        }
    },
    {
        name: 'invite-create',
        enqueue: {
            type: AppInboxType.GROUP_INVITE_CREATE,
            topicId: AppInboxType.GROUP_INVITE_CREATE,
            resourceId: 'invite-create-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId,
                principalId: 'member',
                request: { invitationExpiresAtEpochMs: 9_000, ...actor, requestId: 'invite-create' }
            }
        },
        descriptor: {
            operation: 'createGroupInvite',
            scope: SCOPE,
            groupId,
            targetPrincipalId: 'member',
            sessionId: null,
            request: { invitationExpiresAtEpochMs: 9_000, ...actor, requestId: 'invite-create' }
        }
    },
    {
        name: 'invite-revoke',
        enqueue: {
            type: AppInboxType.GROUP_INVITE_REVOKE,
            topicId: AppInboxType.GROUP_INVITE_REVOKE,
            resourceId: 'invite-revoke-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId,
                principalId: 'member',
                request: { ...actor, requestId: 'invite-revoke' }
            }
        },
        descriptor: {
            operation: 'revokeGroupInvite',
            scope: SCOPE,
            groupId,
            targetPrincipalId: 'member',
            sessionId: null,
            request: { ...actor, requestId: 'invite-revoke' }
        }
    },
    {
        name: 'invite-accept',
        enqueue: {
            type: AppInboxType.GROUP_INVITE_ACCEPT,
            topicId: AppInboxType.GROUP_INVITE_ACCEPT,
            resourceId: 'invite-accept-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId,
                request: { ...actor, requestId: 'invite-accept' }
            }
        },
        descriptor: {
            operation: 'acceptGroupInvite',
            scope: SCOPE,
            groupId,
            targetPrincipalId: null,
            sessionId: null,
            request: { ...actor, requestId: 'invite-accept' }
        }
    },
    {
        name: 'admission-grant',
        enqueue: {
            type: AppInboxType.GROUP_ADMISSION_GRANT,
            topicId: AppInboxType.GROUP_ADMISSION_GRANT,
            resourceId: 'admission-grant-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId,
                principalId: 'member',
                request: { ...actor, requestId: 'admission-grant' }
            }
        },
        descriptor: {
            operation: 'grantGroupAdmission',
            scope: SCOPE,
            groupId,
            targetPrincipalId: 'member',
            sessionId: null,
            request: { ...actor, requestId: 'admission-grant' }
        }
    },
    {
        name: 'admission-decline',
        enqueue: {
            type: AppInboxType.GROUP_ADMISSION_DECLINE,
            topicId: AppInboxType.GROUP_ADMISSION_DECLINE,
            resourceId: 'admission-decline-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId,
                principalId: 'member',
                request: { ...actor, requestId: 'admission-decline' }
            }
        },
        descriptor: {
            operation: 'declineGroupAdmission',
            scope: SCOPE,
            groupId,
            targetPrincipalId: 'member',
            sessionId: null,
            request: { ...actor, requestId: 'admission-decline' }
        }
    },
    {
        name: 'rotate-join-code',
        enqueue: {
            type: AppInboxType.GROUP_JOIN_CODE_ROTATE,
            topicId: AppInboxType.GROUP_JOIN_CODE_ROTATE,
            resourceId: 'rotate-join-code-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: { scope: SCOPE, groupId, request: { ...actor, requestId: 'rotate-join-code' } }
        },
        descriptor: {
            operation: 'rotateGroupJoinCode',
            scope: SCOPE,
            groupId,
            targetPrincipalId: null,
            sessionId: null,
            request: { ...actor, requestId: 'rotate-join-code' }
        }
    },
    {
        name: 'member-remove',
        enqueue: {
            type: AppInboxType.GROUP_MEMBER_REMOVE,
            topicId: AppInboxType.GROUP_MEMBER_REMOVE,
            resourceId: 'member-remove-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId,
                principalId: 'member',
                request: { ...actor, requestId: 'member-remove' }
            }
        },
        descriptor: {
            operation: 'removeGroupMember',
            scope: SCOPE,
            groupId,
            targetPrincipalId: 'member',
            sessionId: null,
            request: { ...actor, requestId: 'member-remove' }
        }
    },
    {
        name: 'member-ban',
        enqueue: {
            type: AppInboxType.GROUP_MEMBER_BAN,
            topicId: AppInboxType.GROUP_MEMBER_BAN,
            resourceId: 'member-ban-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId,
                principalId: 'member',
                request: { ...actor, requestId: 'member-ban' }
            }
        },
        descriptor: {
            operation: 'banGroupMember',
            scope: SCOPE,
            groupId,
            targetPrincipalId: 'member',
            sessionId: null,
            request: { ...actor, requestId: 'member-ban' }
        }
    },
    {
        name: 'member-unban',
        enqueue: {
            type: AppInboxType.GROUP_MEMBER_UNBAN,
            topicId: AppInboxType.GROUP_MEMBER_UNBAN,
            resourceId: 'member-unban-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId,
                principalId: 'member',
                request: { ...actor, requestId: 'member-unban' }
            }
        },
        descriptor: {
            operation: 'unbanGroupMember',
            scope: SCOPE,
            groupId,
            targetPrincipalId: 'member',
            sessionId: null,
            request: { ...actor, requestId: 'member-unban' }
        }
    },
    {
        name: 'member-role-set',
        enqueue: {
            type: AppInboxType.GROUP_MEMBER_ROLE_SET,
            topicId: AppInboxType.GROUP_MEMBER_ROLE_SET,
            resourceId: 'member-role-set-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId,
                principalId: 'member',
                request: { role: 'admin', ...actor, requestId: 'member-role-set' }
            }
        },
        descriptor: {
            operation: 'setGroupMemberRole',
            scope: SCOPE,
            groupId,
            targetPrincipalId: 'member',
            sessionId: null,
            request: { role: 'admin', ...actor, requestId: 'member-role-set' }
        }
    },
    {
        name: 'ownership-transfer',
        enqueue: {
            type: AppInboxType.GROUP_OWNERSHIP_TRANSFER,
            topicId: AppInboxType.GROUP_OWNERSHIP_TRANSFER,
            resourceId: 'ownership-transfer-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId,
                request: { newOwnerPrincipalId: 'member', ...actor, requestId: 'ownership-transfer' }
            }
        },
        descriptor: {
            operation: 'transferGroupOwnership',
            scope: SCOPE,
            groupId,
            targetPrincipalId: 'member',
            sessionId: null,
            request: { newOwnerPrincipalId: 'member', ...actor, requestId: 'ownership-transfer' }
        }
    },
    {
        name: 'member-upsert',
        enqueue: {
            type: AppInboxType.GROUP_MEMBER_UPSERT,
            topicId: AppInboxType.GROUP_MEMBER_UPSERT,
            resourceId: 'member-upsert-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId,
                principalId: 'member',
                request: { status: 'active', role: 'member', ...actor, requestId: 'member-upsert' }
            }
        },
        descriptor: {
            operation: 'upsertMember',
            scope: SCOPE,
            groupId,
            targetPrincipalId: 'member',
            sessionId: null,
            request: { status: 'active', role: 'member', ...actor, requestId: 'member-upsert' }
        }
    },
    {
        name: 'presence-connect',
        enqueue: {
            type: AppInboxType.GROUP_PRESENCE_CONNECT,
            topicId: AppInboxType.GROUP_PRESENCE_CONNECT,
            resourceId: 'presence-connect-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId,
                sessionId: 'presence-session',
                request: { generationId: 'generation-1', principalId: 'member', expiresAtEpochMs: 9_000, ...actor, requestId: 'presence-connect' }
            }
        },
        descriptor: {
            operation: 'connectPresence',
            scope: SCOPE,
            groupId,
            targetPrincipalId: 'member',
            sessionId: 'presence-session',
            request: { generationId: 'generation-1', principalId: 'member', expiresAtEpochMs: 9_000, ...actor, requestId: 'presence-connect' }
        }
    },
    {
        name: 'presence-heartbeat',
        enqueue: {
            type: AppInboxType.GROUP_PRESENCE_HEARTBEAT,
            topicId: AppInboxType.GROUP_PRESENCE_HEARTBEAT,
            resourceId: 'presence-heartbeat-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId,
                sessionId: 'presence-session',
                request: { generationId: 'generation-1', ...actor, requestId: 'presence-heartbeat' }
            }
        },
        descriptor: {
            operation: 'heartbeatPresence',
            scope: SCOPE,
            groupId,
            targetPrincipalId: null,
            sessionId: 'presence-session',
            request: { generationId: 'generation-1', ...actor, requestId: 'presence-heartbeat' }
        }
    },
    {
        name: 'presence-disconnect',
        enqueue: {
            type: AppInboxType.GROUP_PRESENCE_DISCONNECT,
            topicId: AppInboxType.GROUP_PRESENCE_DISCONNECT,
            resourceId: 'presence-disconnect-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                groupId,
                sessionId: 'presence-session',
                request: { generationId: 'generation-1', ...actor, requestId: 'presence-disconnect' }
            }
        },
        descriptor: {
            operation: 'disconnectPresence',
            scope: SCOPE,
            groupId,
            targetPrincipalId: null,
            sessionId: 'presence-session',
            request: { generationId: 'generation-1', ...actor, requestId: 'presence-disconnect' }
        }
    },
    {
        name: 'formation-start',
        enqueue: {
            type: AppInboxType.GROUP_FORMATION_START,
            topicId: AppInboxType.GROUP_FORMATION_START,
            resourceId: 'formation-start-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: { scope: SCOPE, groupId, request: { ...actor, requestId: 'formation-start' } }
        },
        descriptor: {
            operation: 'startGroupFormation',
            scope: SCOPE,
            groupId,
            targetPrincipalId: null,
            sessionId: null,
            request: { ...actor, requestId: 'formation-start' }
        }
    },
    {
        name: 'formation-reset',
        enqueue: {
            type: AppInboxType.GROUP_FORMATION_RESET,
            topicId: AppInboxType.GROUP_FORMATION_RESET,
            resourceId: 'formation-reset-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: { scope: SCOPE, groupId, request: { ...actor, requestId: 'formation-reset' } }
        },
        descriptor: {
            operation: 'resetGroupFormation',
            scope: SCOPE,
            groupId,
            targetPrincipalId: null,
            sessionId: null,
            request: { ...actor, requestId: 'formation-reset' }
        }
    },
    {
        name: 'transport-pause',
        enqueue: {
            type: AppInboxType.GROUP_TRANSPORT_PAUSE,
            topicId: AppInboxType.GROUP_TRANSPORT_PAUSE,
            resourceId: 'transport-pause-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: { scope: SCOPE, groupId, request: { ...actor, requestId: 'transport-pause' } }
        },
        descriptor: {
            operation: 'pauseGroupTransport',
            scope: SCOPE,
            groupId,
            targetPrincipalId: null,
            sessionId: null,
            request: { ...actor, requestId: 'transport-pause' }
        }
    },
    {
        name: 'transport-resume',
        enqueue: {
            type: AppInboxType.GROUP_TRANSPORT_RESUME,
            topicId: AppInboxType.GROUP_TRANSPORT_RESUME,
            resourceId: 'transport-resume-resource',
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data: { scope: SCOPE, groupId, request: { ...actor, requestId: 'transport-resume' } }
        },
        descriptor: {
            operation: 'resumeGroupTransport',
            scope: SCOPE,
            groupId,
            targetPrincipalId: null,
            sessionId: null,
            request: { ...actor, requestId: 'transport-resume' }
        }
    }
];
