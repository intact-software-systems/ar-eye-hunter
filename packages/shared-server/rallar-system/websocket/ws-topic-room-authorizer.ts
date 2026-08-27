import { readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import { readGroupVersion } from '@shared/api/group-client-views.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import {
    blocksGroupPreActivationData,
    canSendGroupMessage
} from '@shared-server/rallar-system/group-state/policy/group-message-policy.ts';
import { isSameGroupScope } from '@shared/api/api-type-utils.ts';
import type { GroupPreActivationAppData } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupPolicyDenied } from '@shared/api/group-policy-types.ts';
import { RALLAR_CRDT_APP_TOPIC_ID, RALLAR_CRDT_ROOM_TOPIC_ID } from '@shared/crdt/crdt-types.ts';
import type { RallarSnapshotPresenceClock } from '../presence/snapshot-presence.ts';
import type {
    RallarServerWsRoomAuthorizationDecision,
    RallarServerWsRoomAuthorizer
} from './router/rallar-server-ws-router-contracts.ts';

type MaybePromise<T> = T | Promise<T>;

export interface CreateGroupRoomWsAuthorizerOptions {
    findGroupSnapshotByRef?: (
        ref: GroupRef,
        input: Parameters<RallarServerWsRoomAuthorizer>[0]
    ) => MaybePromise<GroupSnapshot | undefined>;
    findGroupSnapshotById?: (
        groupId: string
    ) => MaybePromise<GroupSnapshot | undefined>;
    resolveGroupRef?: (
        input: Parameters<RallarServerWsRoomAuthorizer>[0]
    ) => MaybePromise<GroupRef | undefined>;
    /**
     * Resolves the group's data-policy value for the pre-activation gate
     * (plan decision 5.4). Absent when the runtime supplies no policy
     * source, which leaves application data ungated -- today's behaviour.
     */
    readPreActivationAppData?: (
        ref: GroupRef
    ) => MaybePromise<GroupPreActivationAppData>;
    now?: RallarSnapshotPresenceClock;
}

export function createGroupRoomWsAuthorizer(
    options: CreateGroupRoomWsAuthorizerOptions
): RallarServerWsRoomAuthorizer {
    return async (input) => {
        const groupRef = input.roomRef ??
            readALTargetGroupRef(input.message) ??
            await options.resolveGroupRef?.(input);
        const scopedSnapshot = groupRef
            ? await options.findGroupSnapshotByRef?.(groupRef, input)
            : undefined;
        const byIdSnapshot = scopedSnapshot
            ? undefined
            : await options.findGroupSnapshotById?.(input.roomId);
        if (groupRef && byIdSnapshot && !isSameGroupScope(byIdSnapshot.group, groupRef)) {
            return {
                authorized: false,
                reason: 'unauthorized',
                logMessage: `Rejected room message for ${input.roomId}: group scope mismatch.`,
                serverSnapshotVersion: readGroupVersion(byIdSnapshot)
            };
        }
        const snapshot = scopedSnapshot ?? (
            byIdSnapshot && (!groupRef || isSameGroupScope(byIdSnapshot.group, groupRef))
                ? byIdSnapshot
                : undefined
        );
        const minSnapshotVersion = input.minSnapshotVersion;

        if (!snapshot) {
            if (minSnapshotVersion !== undefined) {
                return {
                    authorized: false,
                    reason: 'not-yet-in-sync',
                    logMessage: `Room ${input.roomId} cache is missing; requires snapshot version ${minSnapshotVersion}`
                };
            }

            return false;
        }

        const serverSnapshotVersion = readGroupVersion(snapshot);
        if (
            minSnapshotVersion !== undefined &&
            serverSnapshotVersion < minSnapshotVersion
        ) {
            return {
                authorized: false,
                reason: 'not-yet-in-sync',
                logMessage:
                    `Room ${input.roomId} cache version ${serverSnapshotVersion} is older than required version ${minSnapshotVersion}`,
                serverSnapshotVersion
            };
        }

        const preActivationAppData = await resolvePreActivationAppData(options, input, snapshot);
        const policyResult = canSendGroupMessage({
            snapshot,
            actor: {
                sessionId: input.senderId
            },
            senderSessionId: input.senderId,
            minSnapshotVersion,
            nowEpochMs: options.now?.() ?? Date.now(),
            ...(preActivationAppData === undefined ? {} : { preActivationAppData })
        });
        if (!policyResult.allowed) {
            return toPolicyDeniedDecision(input.roomId, policyResult, serverSnapshotVersion);
        }

        return true;
    };
}

/**
 * The data-policy gate covers plain WS-relayed application data only. The
 * CRDT live topics share this choke point but are exempt by name: CRDT
 * authority is the AppInbox append path, the topic only fans out committed
 * updates, and collaborative documents stay alive while the group forms
 * (plan decision 5.4). Active groups pay no policy read at all --
 * `blocked-until-active` can only bind before activation.
 */
async function resolvePreActivationAppData(
    options: CreateGroupRoomWsAuthorizerOptions,
    input: Parameters<RallarServerWsRoomAuthorizer>[0],
    snapshot: GroupSnapshot
): Promise<GroupPreActivationAppData | undefined> {
    if (
        input.topicId === RALLAR_CRDT_ROOM_TOPIC_ID ||
        input.topicId === RALLAR_CRDT_APP_TOPIC_ID
    ) {
        return undefined;
    }
    if (!blocksGroupPreActivationData(snapshot.group.lifecycleState) || !options.readPreActivationAppData) {
        return undefined;
    }
    return await options.readPreActivationAppData({
        applicationId: snapshot.group.applicationId,
        workspaceId: snapshot.group.workspaceId,
        groupId: snapshot.group.groupId
    });
}

function toPolicyDeniedDecision(
    roomId: string,
    denial: GroupPolicyDenied,
    serverSnapshotVersion?: number
): RallarServerWsRoomAuthorizationDecision {
    return {
        authorized: false,
        reason: 'unauthorized',
        logMessage: `Rejected room message for ${roomId}: ${denial.code}: ${denial.message}`,
        serverSnapshotVersion
    };
}
