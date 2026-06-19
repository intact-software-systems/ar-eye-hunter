import { readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { readGroupVersion, } from '@shared/api/group-client-views.ts';
import type {
    RallarServerWsRoomAuthorizationDecision,
    RallarServerWsRoomAuthorizer,
} from '../../rallar-facade/ws-topic-router.ts';
import { isSameGroupScope } from '@shared/api/api-type-utils.ts';
import type { RallarSnapshotPresenceClock } from '../snapshot-presence.ts';
import { canSendRoomMessage } from '../group-policy.ts';
import type { GroupPolicyDenied } from '@shared/api/group-policy-types.ts';

type MaybePromise<T> = T | Promise<T>;

export type CreateGroupRoomWsAuthorizerOptions = Readonly<{
    findGroupSnapshotByRef?: (
        ref: GroupRef,
        input: Parameters<RallarServerWsRoomAuthorizer>[0],
    ) => MaybePromise<GroupSnapshot | undefined>;
    findGroupSnapshotById?: (
        groupId: string,
    ) => MaybePromise<GroupSnapshot | undefined>;
    resolveGroupRef?: (
        input: Parameters<RallarServerWsRoomAuthorizer>[0],
    ) => MaybePromise<GroupRef | undefined>;
    now?: RallarSnapshotPresenceClock;
}>;

export function createGroupRoomWsAuthorizer(
    options: CreateGroupRoomWsAuthorizerOptions,
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
                logMessage:
                    `Rejected room message for ${input.roomId}: group scope mismatch.`,
                serverSnapshotVersion: readGroupVersion(byIdSnapshot),
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
                    logMessage:
                        `Room ${input.roomId} cache is missing; requires snapshot version ${minSnapshotVersion}`,
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
                serverSnapshotVersion,
            };
        }

        const policyResult = canSendRoomMessage({
            snapshot,
            actor: {
                sessionId: input.senderId,
            },
            senderSessionId: input.senderId,
            minSnapshotVersion,
            nowEpochMs: options.now?.() ?? Date.now(),
        });
        if (!policyResult.allowed) {
            return toPolicyDeniedDecision(input.roomId, policyResult, serverSnapshotVersion);
        }

        return true;
    };
}

function toPolicyDeniedDecision(
    roomId: string,
    denial: GroupPolicyDenied,
    serverSnapshotVersion?: number,
): RallarServerWsRoomAuthorizationDecision {
    return {
        authorized: false,
        reason: 'unauthorized',
        logMessage:
            `Rejected room message for ${roomId}: ${denial.code}: ${denial.message}`,
        serverSnapshotVersion,
    };
}
