import { describe, expect, expectTypeOf, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { decodeGroupStateAppInboxCommand } from '@shared-server/rallar-system/group-state/inbox/decode-group-state-app-inbox-command.ts';
import {
    type AuthenticatedGroupMutationEnqueue,
    type AuthenticatedGroupMutationPayloadByType,
    type GroupCreateAppInboxPayload,
    type GroupMemberBanAppInboxPayload,
    type GroupMemberRemoveAppInboxPayload,
    type GroupMemberUnbanAppInboxPayload,
    type GroupPublicationGrantAppInboxPayload,
    type GroupPublicationRevokeAppInboxPayload,
    type GroupTopicSubscribeAppInboxPayload,
    type GroupTopicUnsubscribeAppInboxPayload,
    type GroupUpdateAppInboxPayload
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import { toGroupMutationDescriptor } from '@shared-server/rallar-system/group-state/inbox/to-group-mutation-descriptor.ts';

describe('authenticated group mutation enqueue payload contract', () => {
    it('maps each membership inbox discriminator to its declared payload type', () => {
        expectTypeOf<AuthenticatedGroupMutationPayloadByType[typeof AppInboxType.GROUP_MEMBER_REMOVE]>().toEqualTypeOf<GroupMemberRemoveAppInboxPayload>();
        expectTypeOf<AuthenticatedGroupMutationPayloadByType[typeof AppInboxType.GROUP_MEMBER_BAN]>().toEqualTypeOf<GroupMemberBanAppInboxPayload>();
        expectTypeOf<AuthenticatedGroupMutationPayloadByType[typeof AppInboxType.GROUP_MEMBER_UNBAN]>().toEqualTypeOf<GroupMemberUnbanAppInboxPayload>();
        expectTypeOf<AuthenticatedGroupMutationPayloadByType[typeof AppInboxType.GROUP_PUBLICATION_GRANT]>().toEqualTypeOf<
            GroupPublicationGrantAppInboxPayload
        >();
        expectTypeOf<AuthenticatedGroupMutationPayloadByType[typeof AppInboxType.GROUP_PUBLICATION_REVOKE]>().toEqualTypeOf<
            GroupPublicationRevokeAppInboxPayload
        >();
        expectTypeOf<AuthenticatedGroupMutationPayloadByType[typeof AppInboxType.GROUP_TOPIC_SUBSCRIBE]>().toEqualTypeOf<GroupTopicSubscribeAppInboxPayload>();
        expectTypeOf<AuthenticatedGroupMutationPayloadByType[typeof AppInboxType.GROUP_TOPIC_UNSUBSCRIBE]>().toEqualTypeOf<
            GroupTopicUnsubscribeAppInboxPayload
        >();
    });

    it('decodes a persisted topic subscribe or unsubscribe and refuses an empty generation or a reserved topic', () => {
        for (const type of [AppInboxType.GROUP_TOPIC_SUBSCRIBE, AppInboxType.GROUP_TOPIC_UNSUBSCRIBE] as const) {
            const command = {
                scope: { applicationId: 'app', workspaceId: 'workspace' },
                groupId: 'group',
                sessionId: 'session-1',
                request: { requestId: 'request-1', topicId: 'room.feed', connectionGenerationId: 'ws-generation-1' }
            } as const;

            expect(decodeGroupStateAppInboxCommand(type, command)).toEqual(command);
            expect(() => decodeGroupStateAppInboxCommand(type, { ...command, principalId: 'member' })).toThrow();
            expect(() =>
                decodeGroupStateAppInboxCommand(type, {
                    ...command,
                    request: { ...command.request, connectionGenerationId: '' }
                })
            ).toThrow('connectionGenerationId');
            expect(() => decodeGroupStateAppInboxCommand(type, { ...command, request: { ...command.request, topicId: 'rallar.state' } })).toThrow('topicId');
        }
    });

    it('decodes a persisted publication grant or revoke and refuses one naming neither permission', () => {
        for (const type of [AppInboxType.GROUP_PUBLICATION_GRANT, AppInboxType.GROUP_PUBLICATION_REVOKE] as const) {
            const command = {
                scope: { applicationId: 'app', workspaceId: 'workspace' },
                groupId: 'group',
                principalId: 'member',
                request: { requestId: 'request-1', topicId: 'room.feed', publish: true, subscribe: false }
            } as const;

            expect(decodeGroupStateAppInboxCommand(type, command)).toEqual(command);
            expect(() =>
                decodeGroupStateAppInboxCommand(type, {
                    ...command,
                    request: { ...command.request, publish: false }
                })
            ).toThrow('publish or subscribe');
        }
    });

    it('rejects malformed persisted payloads before group mutation handling', () => {
        const command = {
            scope: { applicationId: 'app', workspaceId: 'workspace' },
            request: {
                requestId: 'request-1',
                actorPrincipalId: 'owner',
                actorSessionId: 'session-1',
                groupId: 'group',
                displayName: 'Payload contract',
                kind: 'room',
                createdByPrincipalId: 'owner'
            }
        } as const;

        expect(decodeGroupStateAppInboxCommand(AppInboxType.GROUP_CREATE, command)).toEqual(
            command
        );
        expect(() =>
            decodeGroupStateAppInboxCommand(AppInboxType.GROUP_CREATE, {
                ...command,
                unexpectedField: true
            })
        ).toThrow('fields are invalid');
    });

    it('accepts current package payloads whose actor identity is owned by authority', () => {
        const command = {
            scope: { applicationId: 'app', workspaceId: 'workspace' },
            groupId: 'group',
            principalId: 'member',
            request: {
                requestId: 'request-1',
                status: 'active'
            }
        } as const;

        expect(decodeGroupStateAppInboxCommand(AppInboxType.GROUP_MEMBER_UPSERT, command)).toEqual(
            command
        );
        expect(() =>
            decodeGroupStateAppInboxCommand(AppInboxType.GROUP_MEMBER_UPSERT, {
                ...command,
                request: { ...command.request, actorSessionId: '' }
            })
        ).toThrow('actorSessionId must be a non-empty string');
    });
});

function assertAuthenticatedGroupMutationEnqueueTypes(): void {
    const groupCreatePayload: GroupCreateAppInboxPayload = {
        scope: { applicationId: 'app', workspaceId: 'workspace' },
        request: {
            groupId: 'group',
            displayName: 'Payload contract',
            kind: 'room',
            createdByPrincipalId: 'owner'
        }
    };
    const groupUpdatePayload: GroupUpdateAppInboxPayload = {
        scope: { applicationId: 'app', workspaceId: 'workspace' },
        groupId: 'group',
        request: { displayName: 'Updated' }
    };
    const removePayload: GroupMemberRemoveAppInboxPayload = {
        scope: { applicationId: 'app', workspaceId: 'workspace' },
        groupId: 'group',
        principalId: 'member',
        request: {}
    };
    const banPayload: GroupMemberBanAppInboxPayload = {
        scope: { applicationId: 'app', workspaceId: 'workspace' },
        groupId: 'group',
        principalId: 'member',
        request: {}
    };
    const unbanPayload: GroupMemberUnbanAppInboxPayload = {
        scope: { applicationId: 'app', workspaceId: 'workspace' },
        groupId: 'group',
        principalId: 'member',
        request: {}
    };
    const removeEnqueue = {
        type: AppInboxType.GROUP_MEMBER_REMOVE,
        contextId: 'test-context',
        traceId: 'trace-test-fixture',
        data: removePayload
    } satisfies AuthenticatedGroupMutationEnqueue;
    const banEnqueue = {
        type: AppInboxType.GROUP_MEMBER_BAN,
        contextId: 'test-context',
        traceId: 'trace-test-fixture',
        data: banPayload
    } satisfies AuthenticatedGroupMutationEnqueue;
    const unbanEnqueue = {
        type: AppInboxType.GROUP_MEMBER_UNBAN,
        contextId: 'test-context',
        traceId: 'trace-test-fixture',
        data: unbanPayload
    } satisfies AuthenticatedGroupMutationEnqueue;

    toGroupMutationDescriptor(removeEnqueue);
    toGroupMutationDescriptor(banEnqueue);
    toGroupMutationDescriptor(unbanEnqueue);

    // @ts-expect-error GROUP_UPDATE requires the payload selected by its discriminator.
    toGroupMutationDescriptor({ type: AppInboxType.GROUP_UPDATE, contextId: 'test-context', data: groupCreatePayload });
    // @ts-expect-error GROUP_CREATE requires the payload selected by its discriminator.
    toGroupMutationDescriptor({ type: AppInboxType.GROUP_CREATE, data: groupUpdatePayload });
    assertRemoveEnqueue(removeEnqueue);
    // @ts-expect-error A ban enqueue cannot cross the remove operation boundary.
    assertRemoveEnqueue(banEnqueue);
    // @ts-expect-error An unban enqueue cannot cross the remove operation boundary.
    assertRemoveEnqueue(unbanEnqueue);
}

function assertRemoveEnqueue(
    enqueue: Extract<AuthenticatedGroupMutationEnqueue, { readonly type: typeof AppInboxType.GROUP_MEMBER_REMOVE; }>
): void {
    void enqueue;
}

void assertAuthenticatedGroupMutationEnqueueTypes;
