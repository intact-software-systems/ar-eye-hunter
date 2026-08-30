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
            expect(toGroupMutationDescriptor(testCase.enqueue as AuthenticatedGroupMutationEnqueue), testCase.name).toEqual(testCase.descriptor);
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
    readonly enqueue: DescriptorEnqueue;
    readonly descriptor: GroupMutationDescriptor;
}

interface DescriptorEnqueue {
    readonly type: AppInboxType;
    readonly resourceId: string;
    readonly contextId: string;
    readonly senderId: string;
    readonly data: AuthenticatedGroupMutationEnqueue['data'];
}

function descriptorCase(...input: DescriptorCaseArguments): DescriptorCase {
    const [name, type, data, operation, request, targetPrincipalId = null, sessionId = null] = input;
    return {
        name,
        enqueue: {
            type,
            resourceId: `${name}-resource`,
            contextId: 'descriptor-contract',
            senderId: 'owner',
            data
        },
        descriptor: { operation, scope: SCOPE, groupId, targetPrincipalId, sessionId, request }
    };
}

type DescriptorCaseArguments = readonly [
    name: string,
    type: AppInboxType,
    data: AuthenticatedGroupMutationEnqueue['data'],
    operation: GroupMutationDescriptor['operation'],
    request: AuthenticatedGroupMutationEnqueue['data']['request'],
    targetPrincipalId?: string | null,
    sessionId?: string | null
];

const descriptorCases: readonly DescriptorCase[] = [
    descriptorCase(
        'create',
        AppInboxType.GROUP_CREATE,
        {
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
        },
        'createGroup',
        {
            groupId,
            displayName: 'Descriptor room',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: 'owner',
            ...actor,
            requestId: 'create'
        }
    ),
    descriptorCase(
        'update',
        AppInboxType.GROUP_UPDATE,
        { scope: SCOPE, groupId, request: { description: 'Updated', ...actor, requestId: 'update' } },
        'updateGroup',
        { description: 'Updated', ...actor, requestId: 'update' }
    ),
    descriptorCase(
        'appoint-director',
        AppInboxType.GROUP_DIRECTOR_APPOINT,
        {
            scope: SCOPE,
            groupId,
            request: { ...actor, requestId: 'appoint-director' }
        },
        'appointDirector',
        { ...actor, requestId: 'appoint-director' }
    ),
    descriptorCase(
        'plan',
        AppInboxType.GROUP_PLAN,
        { scope: SCOPE, groupId, request: { ...actor, requestId: 'plan' } },
        'planGroupLayout',
        { ...actor, requestId: 'plan' }
    ),
    // `connect` alone names the layout it means to dial, so its causal fence
    // must survive the descriptor untouched.
    descriptorCase(
        'connect',
        AppInboxType.GROUP_CONNECT,
        {
            scope: SCOPE,
            groupId,
            request: {
                expectedFormationEpoch: 4,
                expectedLayout: connectLayout,
                ...actor,
                requestId: 'connect'
            }
        },
        'connectGroup',
        {
            expectedFormationEpoch: 4,
            expectedLayout: connectLayout,
            ...actor,
            requestId: 'connect'
        }
    ),
    descriptorCase(
        'activate',
        AppInboxType.GROUP_ACTIVATE,
        { scope: SCOPE, groupId, request: { ...actor, requestId: 'activate' } },
        'activateGroup',
        { ...actor, requestId: 'activate' }
    ),
    descriptorCase(
        'reconfigure',
        AppInboxType.GROUP_RECONFIGURE,
        { scope: SCOPE, groupId, request: { ...actor, requestId: 'reconfigure' } },
        'reconfigureGroup',
        { ...actor, requestId: 'reconfigure' }
    ),
    descriptorCase('join', AppInboxType.GROUP_JOIN, { scope: SCOPE, groupId, request: { ...actor, requestId: 'join' } }, 'joinGroup', {
        ...actor,
        requestId: 'join'
    }),
    descriptorCase(
        'invite-create',
        AppInboxType.GROUP_INVITE_CREATE,
        {
            scope: SCOPE,
            groupId,
            principalId: 'member',
            request: { invitationExpiresAtEpochMs: 9_000, ...actor, requestId: 'invite-create' }
        },
        'createGroupInvite',
        { invitationExpiresAtEpochMs: 9_000, ...actor, requestId: 'invite-create' },
        'member'
    ),
    descriptorCase(
        'invite-revoke',
        AppInboxType.GROUP_INVITE_REVOKE,
        {
            scope: SCOPE,
            groupId,
            principalId: 'member',
            request: { ...actor, requestId: 'invite-revoke' }
        },
        'revokeGroupInvite',
        { ...actor, requestId: 'invite-revoke' },
        'member'
    ),
    descriptorCase(
        'invite-accept',
        AppInboxType.GROUP_INVITE_ACCEPT,
        {
            scope: SCOPE,
            groupId,
            request: { ...actor, requestId: 'invite-accept' }
        },
        'acceptGroupInvite',
        { ...actor, requestId: 'invite-accept' }
    ),
    descriptorCase(
        'admission-grant',
        AppInboxType.GROUP_ADMISSION_GRANT,
        {
            scope: SCOPE,
            groupId,
            principalId: 'member',
            request: { ...actor, requestId: 'admission-grant' }
        },
        'grantGroupAdmission',
        { ...actor, requestId: 'admission-grant' },
        'member'
    ),
    descriptorCase(
        'admission-decline',
        AppInboxType.GROUP_ADMISSION_DECLINE,
        {
            scope: SCOPE,
            groupId,
            principalId: 'member',
            request: { ...actor, requestId: 'admission-decline' }
        },
        'declineGroupAdmission',
        { ...actor, requestId: 'admission-decline' },
        'member'
    ),
    descriptorCase(
        'rotate-join-code',
        AppInboxType.GROUP_JOIN_CODE_ROTATE,
        { scope: SCOPE, groupId, request: { ...actor, requestId: 'rotate-join-code' } },
        'rotateGroupJoinCode',
        { ...actor, requestId: 'rotate-join-code' }
    ),
    descriptorCase(
        'member-remove',
        AppInboxType.GROUP_MEMBER_REMOVE,
        {
            scope: SCOPE,
            groupId,
            principalId: 'member',
            request: { ...actor, requestId: 'member-remove' }
        },
        'removeGroupMember',
        { ...actor, requestId: 'member-remove' },
        'member'
    ),
    descriptorCase(
        'member-ban',
        AppInboxType.GROUP_MEMBER_BAN,
        {
            scope: SCOPE,
            groupId,
            principalId: 'member',
            request: { ...actor, requestId: 'member-ban' }
        },
        'banGroupMember',
        { ...actor, requestId: 'member-ban' },
        'member'
    ),
    descriptorCase(
        'member-unban',
        AppInboxType.GROUP_MEMBER_UNBAN,
        {
            scope: SCOPE,
            groupId,
            principalId: 'member',
            request: { ...actor, requestId: 'member-unban' }
        },
        'unbanGroupMember',
        { ...actor, requestId: 'member-unban' },
        'member'
    ),
    descriptorCase(
        'member-role-set',
        AppInboxType.GROUP_MEMBER_ROLE_SET,
        {
            scope: SCOPE,
            groupId,
            principalId: 'member',
            request: { role: 'admin', ...actor, requestId: 'member-role-set' }
        },
        'setGroupMemberRole',
        { role: 'admin', ...actor, requestId: 'member-role-set' },
        'member'
    ),
    descriptorCase(
        'ownership-transfer',
        AppInboxType.GROUP_OWNERSHIP_TRANSFER,
        {
            scope: SCOPE,
            groupId,
            request: { newOwnerPrincipalId: 'member', ...actor, requestId: 'ownership-transfer' }
        },
        'transferGroupOwnership',
        { newOwnerPrincipalId: 'member', ...actor, requestId: 'ownership-transfer' },
        'member'
    ),
    descriptorCase(
        'member-upsert',
        AppInboxType.GROUP_MEMBER_UPSERT,
        {
            scope: SCOPE,
            groupId,
            principalId: 'member',
            request: { role: 'member', ...actor, requestId: 'member-upsert' }
        },
        'upsertMember',
        { role: 'member', ...actor, requestId: 'member-upsert' },
        'member'
    ),
    descriptorCase(
        'presence-connect',
        AppInboxType.GROUP_PRESENCE_CONNECT,
        {
            scope: SCOPE,
            groupId,
            sessionId: 'presence-session',
            request: {
                principalId: 'member',
                expiresAtEpochMs: 9_000,
                ...actor,
                requestId: 'presence-connect'
            }
        },
        'connectPresence',
        { principalId: 'member', expiresAtEpochMs: 9_000, ...actor, requestId: 'presence-connect' },
        'member',
        'presence-session'
    ),
    descriptorCase(
        'presence-heartbeat',
        AppInboxType.GROUP_PRESENCE_HEARTBEAT,
        {
            scope: SCOPE,
            groupId,
            sessionId: 'presence-session',
            request: { ...actor, requestId: 'presence-heartbeat' }
        },
        'heartbeatPresence',
        { ...actor, requestId: 'presence-heartbeat' },
        null,
        'presence-session'
    ),
    descriptorCase(
        'presence-disconnect',
        AppInboxType.GROUP_PRESENCE_DISCONNECT,
        {
            scope: SCOPE,
            groupId,
            sessionId: 'presence-session',
            request: { ...actor, requestId: 'presence-disconnect' }
        },
        'disconnectPresence',
        { ...actor, requestId: 'presence-disconnect' },
        null,
        'presence-session'
    ),
    descriptorCase(
        'formation-start',
        AppInboxType.GROUP_FORMATION_START,
        { scope: SCOPE, groupId, request: { ...actor, requestId: 'formation-start' } },
        'startGroupFormation',
        { ...actor, requestId: 'formation-start' }
    ),
    descriptorCase(
        'formation-reset',
        AppInboxType.GROUP_FORMATION_RESET,
        { scope: SCOPE, groupId, request: { ...actor, requestId: 'formation-reset' } },
        'resetGroupFormation',
        { ...actor, requestId: 'formation-reset' }
    ),
    descriptorCase(
        'transport-pause',
        AppInboxType.GROUP_TRANSPORT_PAUSE,
        { scope: SCOPE, groupId, request: { ...actor, requestId: 'transport-pause' } },
        'pauseGroupTransport',
        { ...actor, requestId: 'transport-pause' }
    ),
    descriptorCase(
        'transport-resume',
        AppInboxType.GROUP_TRANSPORT_RESUME,
        { scope: SCOPE, groupId, request: { ...actor, requestId: 'transport-resume' } },
        'resumeGroupTransport',
        { ...actor, requestId: 'transport-resume' }
    )
];
