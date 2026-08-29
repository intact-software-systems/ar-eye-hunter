import {
    blocksGroupPreActivationData,
    canSendGroupMessage
} from '@shared-server/rallar-system/group-state/policy/group-message-policy.ts';
import { denyGroupPolicy } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
import { readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import { isSameGroupScope } from '@shared/api/api-type-utils.ts';
import { readGroupVersion } from '@shared/api/group-client-views.ts';
import type { GroupPreActivationAppData } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupPolicyDenied } from '@shared/api/group-policy-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { RALLAR_CRDT_APP_TOPIC_ID, RALLAR_CRDT_ROOM_TOPIC_ID } from '@shared/crdt/crdt-types.ts';

import type { RallarSnapshotPresenceClock } from '../presence/snapshot-presence.ts';
import type {
    RallarServerWsRoomAuthorizationDecision,
    RallarServerWsRoomAuthorizer
} from './router/rallar-server-ws-router-contracts.ts';

type MaybePromise<T> = T | Promise<T>;

type ReadRoomAuthorizationSnapshotResult =
    | {
        readonly kind: 'ready';
        readonly snapshot: GroupSnapshot;
        readonly serverSnapshotVersion: number;
    }
    | {
        readonly kind: 'denied';
        readonly decision: RallarServerWsRoomAuthorizationDecision | false;
    };

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
        const snapshotRead = await readRoomAuthorizationSnapshot(options, input);
        if (snapshotRead.kind === 'denied') {
            return snapshotRead.decision;
        }

        const { snapshot, serverSnapshotVersion } = snapshotRead;
        const isCrdtTopic = input.topicId === RALLAR_CRDT_ROOM_TOPIC_ID ||
            input.topicId === RALLAR_CRDT_APP_TOPIC_ID;
        const preActivationAppData = await resolvePreActivationAppData(
            options,
            snapshot,
            isCrdtTopic
        );
        const policyResult = canSendGroupMessage({
            snapshot,
            actor: {
                sessionId: input.senderId
            },
            senderSessionId: input.senderId,
            minSnapshotVersion: input.minSnapshotVersion,
            nowEpochMs: options.now?.() ?? Date.now(),
            ...(preActivationAppData === undefined ? {} : { preActivationAppData })
        });
        if (!policyResult.allowed) {
            return toPolicyDeniedDecision(input.roomId, policyResult, serverSnapshotVersion);
        }
        if (!isCrdtTopic && snapshot.group.transportState === 'halted') {
            return toPolicyDeniedDecision(
                input.roomId,
                denyGroupPolicy(
                    'group-policy-denied',
                    'Group transport is halted for room application data.'
                ),
                serverSnapshotVersion
            );
        }

        return true;
    };
}

async function readRoomAuthorizationSnapshot(
    options: CreateGroupRoomWsAuthorizerOptions,
    input: Parameters<RallarServerWsRoomAuthorizer>[0]
): Promise<ReadRoomAuthorizationSnapshotResult> {
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
            kind: 'denied',
            decision: {
                authorized: false,
                reason: 'unauthorized',
                logMessage: `Rejected room message for ${input.roomId}: group scope mismatch.`,
                serverSnapshotVersion: readGroupVersion(byIdSnapshot)
            }
        };
    }
    const snapshot = scopedSnapshot ?? byIdSnapshot;
    if (!snapshot) {
        return {
            kind: 'denied',
            decision: input.minSnapshotVersion === undefined
                ? false
                : {
                    authorized: false,
                    reason: 'not-yet-in-sync',
                    logMessage:
                        `Room ${input.roomId} cache is missing; requires snapshot version ${input.minSnapshotVersion}`
                }
        };
    }

    const serverSnapshotVersion = readGroupVersion(snapshot);
    if (
        input.minSnapshotVersion !== undefined &&
        serverSnapshotVersion < input.minSnapshotVersion
    ) {
        return {
            kind: 'denied',
            decision: {
                authorized: false,
                reason: 'not-yet-in-sync',
                logMessage:
                    `Room ${input.roomId} cache version ${serverSnapshotVersion} is older than required version ${input.minSnapshotVersion}`,
                serverSnapshotVersion
            }
        };
    }

    return { kind: 'ready', snapshot, serverSnapshotVersion };
}

/**
 * The data-policy gate covers plain WS-relayed application data only. The
 * CRDT live topics share this choke point but are exempt by name: CRDT
 * authority is the AppInbox append path, the topic only fans out committed
 * updates, and collaborative documents stay alive while the group forms.
 * Stages where an accepted layout keeps carrying data pay no policy read.
 */
async function resolvePreActivationAppData(
    options: CreateGroupRoomWsAuthorizerOptions,
    snapshot: GroupSnapshot,
    isCrdtTopic: boolean
): Promise<GroupPreActivationAppData | undefined> {
    if (isCrdtTopic || snapshot.group.transportState === 'halted') {
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
