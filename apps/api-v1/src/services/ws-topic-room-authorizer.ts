import { type CachedGroupStateService } from '@shared-server/rallar-system/group-state/snapshot/cached-group-state-service.ts';
import { createGroupRoomWsAuthorizer } from '@shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts';

import type {
    GroupLifecyclePolicyRead
} from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

export interface ApiV1RoomWsAuthorizerDependencies {
    readonly readLifecyclePolicy: (ref: GroupRef) => Promise<GroupLifecyclePolicyRead>;
}

export function createApiV1RoomWsAuthorizer(
    groupStateService: Pick<CachedGroupStateService, 'readCurrentSnapshot'>,
    dependencies: ApiV1RoomWsAuthorizerDependencies
) {
    return createGroupRoomWsAuthorizer({
        readGroupSnapshot: async (ref) => await groupStateService.readCurrentSnapshot(ref),
        readPreActivationAppData: async (ref) => {
            const read = await dependencies.readLifecyclePolicy(ref);
            // Absent preserves the workstream invariant: a group with no policy
            // document behaves exactly as it does on main. Corrupt fails closed --
            // an unreadable stored policy must not read as permissive, and this
            // value is only consulted before activation.
            if (read.status === 'absent') {
                return 'allowed';
            }
            if (read.status === 'corrupt') {
                return 'blocked-until-active';
            }
            return read.policy.data.preActivationAppData;
        },
        nowEpochMs: Date.now
    });
}
