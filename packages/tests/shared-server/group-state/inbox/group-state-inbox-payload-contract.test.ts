import { describe, expectTypeOf, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
import {
  type AuthenticatedGroupMutationEnqueue,
  type AuthenticatedGroupMutationPayloadByType,
  type GroupCreateAppInboxPayload,
  type GroupMemberBanAppInboxPayload,
  type GroupMemberRemoveAppInboxPayload,
  type GroupMemberUnbanAppInboxPayload,
  type GroupUpdateAppInboxPayload,
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import { toGroupMutationDescriptor } from '@shared-server/rallar-system/group-state/inbox/to-group-mutation-descriptor.ts';

describe('authenticated group mutation enqueue payload contract', () => {
  it('maps each membership inbox discriminator to its declared payload type', () => {
    expectTypeOf<
      AuthenticatedGroupMutationPayloadByType[typeof AppInboxType.GROUP_MEMBER_REMOVE]
    >().toEqualTypeOf<GroupMemberRemoveAppInboxPayload>();
    expectTypeOf<
      AuthenticatedGroupMutationPayloadByType[typeof AppInboxType.GROUP_MEMBER_BAN]
    >().toEqualTypeOf<GroupMemberBanAppInboxPayload>();
    expectTypeOf<
      AuthenticatedGroupMutationPayloadByType[typeof AppInboxType.GROUP_MEMBER_UNBAN]
    >().toEqualTypeOf<GroupMemberUnbanAppInboxPayload>();
  });
});

function assertAuthenticatedGroupMutationEnqueueTypes(): void {
  const groupCreatePayload: GroupCreateAppInboxPayload = {
    scope: { applicationId: 'app', workspaceId: 'workspace' },
    request: {
      groupId: 'group',
      displayName: 'Payload contract',
      kind: 'room',
      createdByPrincipalId: 'owner',
    },
  };
  const groupUpdatePayload: GroupUpdateAppInboxPayload = {
    scope: { applicationId: 'app', workspaceId: 'workspace' },
    groupId: 'group',
    request: { displayName: 'Updated' },
  };
  const removePayload: GroupMemberRemoveAppInboxPayload = {
    scope: { applicationId: 'app', workspaceId: 'workspace' },
    groupId: 'group',
    principalId: 'member',
    request: {},
  };
  const banPayload: GroupMemberBanAppInboxPayload = {
    scope: { applicationId: 'app', workspaceId: 'workspace' },
    groupId: 'group',
    principalId: 'member',
    request: {},
  };
  const unbanPayload: GroupMemberUnbanAppInboxPayload = {
    scope: { applicationId: 'app', workspaceId: 'workspace' },
    groupId: 'group',
    principalId: 'member',
    request: {},
  };
  const removeEnqueue = {
    type: AppInboxType.GROUP_MEMBER_REMOVE,
    data: removePayload,
  } satisfies AuthenticatedGroupMutationEnqueue;
  const banEnqueue = {
    type: AppInboxType.GROUP_MEMBER_BAN,
    data: banPayload,
  } satisfies AuthenticatedGroupMutationEnqueue;
  const unbanEnqueue = {
    type: AppInboxType.GROUP_MEMBER_UNBAN,
    data: unbanPayload,
  } satisfies AuthenticatedGroupMutationEnqueue;

  toGroupMutationDescriptor(removeEnqueue);
  toGroupMutationDescriptor(banEnqueue);
  toGroupMutationDescriptor(unbanEnqueue);

  // @ts-expect-error GROUP_UPDATE requires the payload selected by its discriminator.
  toGroupMutationDescriptor({ type: AppInboxType.GROUP_UPDATE, data: groupCreatePayload });
  // @ts-expect-error GROUP_CREATE requires the payload selected by its discriminator.
  toGroupMutationDescriptor({ type: AppInboxType.GROUP_CREATE, data: groupUpdatePayload });
  assertRemoveEnqueue(removeEnqueue);
  // @ts-expect-error A ban enqueue cannot cross the remove operation boundary.
  assertRemoveEnqueue(banEnqueue);
  // @ts-expect-error An unban enqueue cannot cross the remove operation boundary.
  assertRemoveEnqueue(unbanEnqueue);
}

function assertRemoveEnqueue(
  enqueue: Extract<
    AuthenticatedGroupMutationEnqueue,
    { readonly type: typeof AppInboxType.GROUP_MEMBER_REMOVE }
  >,
): void {
  void enqueue;
}

void assertAuthenticatedGroupMutationEnqueueTypes;
