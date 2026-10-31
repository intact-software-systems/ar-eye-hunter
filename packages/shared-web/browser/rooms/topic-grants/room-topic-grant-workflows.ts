import type { GroupPublicationTopicPermissions } from '@shared/api/group-publication/group-publication-grants.ts';

import type { RallarRoomTopicMember } from '../rallar-room-contracts.ts';
import { roomGroupStateHttpApi } from '../room-group-state-http-api.ts';
import { toRoomTopicGrantGroupStateRequest, type GroupSnapshot } from '../room-group-state-translation.ts';
import { runGroupSnapshotCommand } from '../room-membership-group-state-workflows.ts';
import { runRoomTargetMutation, type RunRoomTargetMutationInput } from '../update-room.ts';

export interface RoomTopicGrantInput
    extends Omit<RunRoomTargetMutationInput, 'room' | 'options' | 'execute'>, RallarRoomTopicMember {
    readonly topicId: string;
    /** Each true permission is the one the change adds or removes. */
    readonly permissions: GroupPublicationTopicPermissions;
}

type RoomTopicGrantChange = 'grant' | 'revoke';

export async function grantRoomTopic(input: RoomTopicGrantInput): Promise<GroupSnapshot> {
    return await changeRoomTopicGrant(input, 'grant');
}

export async function revokeRoomTopic(input: RoomTopicGrantInput): Promise<GroupSnapshot> {
    return await changeRoomTopicGrant(input, 'revoke');
}

async function changeRoomTopicGrant(input: RoomTopicGrantInput, change: RoomTopicGrantChange): Promise<GroupSnapshot> {
    const options = input.options ?? {};
    const writeGrant = change === 'grant'
        ? roomGroupStateHttpApi.grantPublication
        : roomGroupStateHttpApi.revokePublication;
    return await runRoomTargetMutation({
        ...input,
        options,
        execute: async ({ roomId, session, scope, policies, assertCurrent }) => {
            const request = toRoomTopicGrantGroupStateRequest({
                request: {
                    topicId: input.topicId,
                    publish: input.permissions.publish,
                    subscribe: input.permissions.subscribe,
                    ...(options.reason === undefined ? {} : { reason: options.reason })
                },
                actorPrincipalId: session.clientId,
                actorSessionId: session.sessionId
            });
            return await runGroupSnapshotCommand({ policies, assertCurrent }, (requestId, signal) =>
                writeGrant({
                    groupId: roomId,
                    principalId: input.principalId,
                    request,
                    options: { requestId, signal },
                    scope
                }));
        }
    });
}
