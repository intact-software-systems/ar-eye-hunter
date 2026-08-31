import {
    blocksGroupPreActivationData,
    canSendGroupMessage
} from '@shared-server/rallar-system/group-state/policy/group-message-policy.ts';
import { denyGroupPolicy } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
import { readALTargetGroupRef, type ALTargets } from '@shared/al-contracts/al-contract.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { readGroupVersion } from '@shared/api/group-client-views.ts';
import type { GroupPreActivationAppData } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupPolicyDenied } from '@shared/api/group-policy-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { RALLAR_CRDT_APP_TOPIC_ID, RALLAR_CRDT_ROOM_TOPIC_ID } from '@shared/crdt/crdt-types.ts';

import type { RallarSnapshotPresenceClock } from '../presence/snapshot-presence.ts';
import { isGroupSnapshotSessionLive } from '../presence/snapshot-presence.ts';
import type {
    RallarServerWsRoomAudience,
    RallarServerWsRoomAuthorizationDenied,
    RallarServerWsRoomAuthorizationInput
} from './router/rallar-server-ws-router-contracts.ts';

type MaybePromise<T> = T | Promise<T>;

export interface GroupRoomWsAuthorizationAllowed {
    readonly authorized: true;
    readonly audience: RallarServerWsRoomAudience;
}

export type GroupRoomWsAuthorizationDecision =
    | GroupRoomWsAuthorizationAllowed
    | RallarServerWsRoomAuthorizationDenied
    | false;

export type GroupRoomWsAuthorizer = (
    input: RallarServerWsRoomAuthorizationInput
) => Promise<GroupRoomWsAuthorizationDecision>;

type ReadRoomAuthorizationSnapshotResult =
    | {
        readonly kind: 'ready';
        readonly snapshot: GroupSnapshot;
        readonly serverSnapshotVersion: number;
    }
    | {
        readonly kind: 'denied';
        readonly decision: RallarServerWsRoomAuthorizationDenied | false;
    };

export interface GroupRoomWsAuthorizerDependencies {
    readonly readGroupSnapshot: (
        ref: GroupRef,
        input: RallarServerWsRoomAuthorizationInput
    ) => MaybePromise<GroupSnapshot | undefined>;
    readonly readPreActivationAppData: (
        ref: GroupRef
    ) => MaybePromise<GroupPreActivationAppData>;
    readonly nowEpochMs: RallarSnapshotPresenceClock;
}

export function createGroupRoomWsAuthorizer(
    dependencies: GroupRoomWsAuthorizerDependencies
): GroupRoomWsAuthorizer {
    return (input) => authorizeGroupRoomMessage(dependencies, input);
}

async function authorizeGroupRoomMessage(
    dependencies: GroupRoomWsAuthorizerDependencies,
    input: RallarServerWsRoomAuthorizationInput
): Promise<GroupRoomWsAuthorizationDecision> {
    const targets = input.message.targets && structuredClone(input.message.targets);
    if (!targets) {
        return false;
    }
    const snapshotRead = await readRoomAuthorizationSnapshot(dependencies, input);
    if (snapshotRead.kind === 'denied') {
        return snapshotRead.decision;
    }

    const { snapshot, serverSnapshotVersion } = snapshotRead;
    const isCrdtTopic = input.topicId === RALLAR_CRDT_ROOM_TOPIC_ID ||
        input.topicId === RALLAR_CRDT_APP_TOPIC_ID;
    const preActivationAppData = await readRoomMessagePreActivationAppData(
        dependencies,
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
        nowEpochMs: dependencies.nowEpochMs(),
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

    return {
        authorized: true,
        audience: toAuthorizedRoomAudience(snapshot, targets, dependencies.nowEpochMs())
    };
}

function toAuthorizedRoomAudience(
    snapshot: GroupSnapshot,
    targets: ALTargets,
    nowEpochMs: number
): RallarServerWsRoomAudience {
    const activePrincipals = new Set(
        snapshot.members.filter((member) => member.status === 'active').map((member) => member.principalId)
    );
    return {
        targets,
        sessions: snapshot.activeSessions.filter((session) =>
            activePrincipals.has(session.principalId) && isGroupSnapshotSessionLive(session, nowEpochMs)
        )
    };
}

async function readRoomAuthorizationSnapshot(
    dependencies: GroupRoomWsAuthorizerDependencies,
    input: RallarServerWsRoomAuthorizationInput
): Promise<ReadRoomAuthorizationSnapshotResult> {
    const groupRef = input.roomRef ??
        readALTargetGroupRef(input.message);
    const snapshot = groupRef
        ? await dependencies.readGroupSnapshot(groupRef, input)
        : undefined;
    if (groupRef && snapshot && !isSameGroupRef(snapshot.group, groupRef)) {
        return {
            kind: 'denied',
            decision: {
                authorized: false,
                reason: 'unauthorized',
                logMessage: `Rejected room message for ${input.roomId}: group scope mismatch.`,
                serverSnapshotVersion: readGroupVersion(snapshot)
            }
        };
    }
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
async function readRoomMessagePreActivationAppData(
    dependencies: GroupRoomWsAuthorizerDependencies,
    snapshot: GroupSnapshot,
    isCrdtTopic: boolean
): Promise<GroupPreActivationAppData | undefined> {
    if (isCrdtTopic || snapshot.group.transportState === 'halted') {
        return undefined;
    }
    if (!blocksGroupPreActivationData(snapshot.group.lifecycleState)) {
        return undefined;
    }
    return await dependencies.readPreActivationAppData({
        applicationId: snapshot.group.applicationId,
        workspaceId: snapshot.group.workspaceId,
        groupId: snapshot.group.groupId
    });
}

function toPolicyDeniedDecision(
    roomId: string,
    denial: GroupPolicyDenied,
    serverSnapshotVersion?: number
): RallarServerWsRoomAuthorizationDenied {
    return {
        authorized: false,
        reason: 'unauthorized',
        logMessage: `Rejected room message for ${roomId}: ${denial.code}: ${denial.message}`,
        serverSnapshotVersion
    };
}
