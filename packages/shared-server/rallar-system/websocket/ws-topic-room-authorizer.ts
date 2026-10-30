import {
    blocksGroupPreActivationData,
    canSendGroupMessage
} from '@shared-server/rallar-system/group-state/policy/group-message-policy.ts';
import { denyGroupPolicy } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
import { readALTargetGroupRef, type ALMessage, type ALTargets } from '@shared/al-contracts/al-contract.ts';
import type { ALNackReason } from '@shared/al-contracts/al-control.ts';
import { resolveALAdmittedRoomAudience } from '@shared/al-contracts/al-frozen-multicast-audience.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { readGroupVersion } from '@shared/api/group-client-views.ts';
import type { GroupPreActivationAppData } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupPolicyDenied, GroupPolicyReasonCode } from '@shared/api/group-policy-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { RALLAR_CRDT_APP_TOPIC_ID, RALLAR_CRDT_ROOM_TOPIC_ID } from '@shared/crdt/crdt-types.ts';
import { isRallarGameSnapshotRequest } from '@shared/rallar-game/snapshot-request.ts';
import type { Either } from '@shared/resilience/Either.ts';

import type { GroupPublicationAuthority } from '../group-state/persistence/subscription/read-group-topic-subscriptions.ts';
import type { RallarSnapshotPresenceClock } from '../presence/snapshot-presence.ts';
import { filterLiveWsRoomRecipientSessionIds } from '../queue-pubsub/live-ws-audience.ts';
import {
    computeRoomPublicationAdmission,
    toMembersTopicPublicationAuthority,
    type RoomPublicationAdmission
} from './room-publication/compute-room-publication-admission.ts';
import type {
    RallarServerWsPublishAudienceInputDto,
    RallarServerWsRoomAudience,
    RallarServerWsRoomAuthorizationDecision,
    RallarServerWsRoomAuthorizationDenied,
    RallarServerWsRoomAuthorizationInput,
    RallarServerWsRoomAuthorizer,
    RallarServerWsTopicAccess
} from './router/rallar-server-ws-router-contracts.ts';

type MaybePromise<T> = T | Promise<T>;

type ReadRoomAuthorizationSnapshotResult =
    | {
        readonly kind: 'ready';
        readonly authority: GroupPublicationAuthority;
    }
    | {
        readonly kind: 'denied';
        readonly decision: RallarServerWsRoomAuthorizationDecision;
    };

export interface GroupRoomWsAuthorizerDependencies {
    readonly readGroupSnapshot: (
        ref: GroupRef,
        input: RallarServerWsRoomAuthorizationInput
    ) => MaybePromise<GroupSnapshot | undefined>;
    /** A granted topic's probed snapshot with its fresh subscription rows and live generations, in place of the snapshot. */
    readonly readPublicationAuthority: (
        ref: GroupRef,
        topicId: string
    ) => MaybePromise<GroupPublicationAuthority | undefined>;
    readonly readPreActivationAppData: (
        ref: GroupRef
    ) => MaybePromise<GroupPreActivationAppData>;
    readonly nowEpochMs: RallarSnapshotPresenceClock;
}

export function createGroupRoomWsAuthorizer(
    dependencies: GroupRoomWsAuthorizerDependencies
): RallarServerWsRoomAuthorizer {
    return (input) => authorizeGroupRoomMessage(dependencies, input);
}

export interface ComputeServerRoomPublicationAudienceInput extends RallarServerWsPublishAudienceInputDto {
    readonly authority: GroupPublicationAuthority | undefined;
    readonly nowEpochMs: number;
}

/** A server producer's room audience, or its topic's refusal of the producer; undefined when the room is not live. */
export function computeServerRoomPublicationAudience(
    input: ComputeServerRoomPublicationAudienceInput
): Either<RoomPublicationAdmission.Refusal, RallarServerWsRoomAudience> | undefined {
    const { authority, message, nowEpochMs } = input;
    const groupRef = readALTargetGroupRef(message);
    if (
        !authority || !groupRef || !message.targets ||
        !isSameGroupRef(authority.snapshot.group, groupRef) ||
        authority.snapshot.group.status !== 'active' || authority.snapshot.group.transportState === 'halted' ||
        (authority.snapshot.group.expiresAtEpochMs !== null && authority.snapshot.group.expiresAtEpochMs <= nowEpochMs)
    ) {
        return undefined;
    }
    return computeRoomPublicationAdmission({
        ...authority,
        topic: { ...input.topic, topicId: message.route.topicId },
        publisher: { kind: 'server-producer', producerId: input.producerId },
        message: { ...message, targets: message.targets },
        nowEpochMs
    });
}

async function authorizeGroupRoomMessage(
    dependencies: GroupRoomWsAuthorizerDependencies,
    input: RallarServerWsRoomAuthorizationInput
): Promise<RallarServerWsRoomAuthorizationDecision> {
    const targets = input.message.targets && structuredClone(input.message.targets);
    if (!targets) {
        return false;
    }
    const snapshotRead = await readRoomAuthorizationSnapshot(dependencies, input);
    if (snapshotRead.kind === 'denied') {
        return snapshotRead.decision;
    }
    const { authority } = snapshotRead;
    const policyDenial = await readRoomPolicyDenial(dependencies, input, authority.snapshot);
    if (policyDenial) {
        return policyDenial;
    }
    return toRoomAuthorizationDecision({ input, targets, authority, nowEpochMs: dependencies.nowEpochMs() });
}

async function readRoomPolicyDenial(
    dependencies: GroupRoomWsAuthorizerDependencies,
    input: RallarServerWsRoomAuthorizationInput,
    snapshot: GroupSnapshot
): Promise<RallarServerWsRoomAuthorizationDenied | undefined> {
    const serverSnapshotVersion = readGroupVersion(snapshot);
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
        readOnlyRequest: input.senderId === input.message.id.senderId && isRallarGameSnapshotRequest(input.message),
        minSnapshotVersion: input.minSnapshotVersion,
        nowEpochMs: dependencies.nowEpochMs(),
        ...(preActivationAppData === undefined ? {} : { preActivationAppData })
    });
    if (!policyResult.allowed) {
        return toPolicyDeniedDecision(input, policyResult, serverSnapshotVersion);
    }
    if (!isCrdtTopic && snapshot.group.transportState === 'halted') {
        return toPolicyDeniedDecision(
            input,
            denyGroupPolicy(
                'group-policy-denied',
                'Group transport is halted for room application data.'
            ),
            serverSnapshotVersion
        );
    }
    return undefined;
}

interface ToRoomAuthorizationDecisionInput {
    readonly input: RallarServerWsRoomAuthorizationInput;
    readonly targets: ALTargets;
    readonly authority: GroupPublicationAuthority;
    readonly nowEpochMs: number;
}

/** The sender passed the room's policy, so its session is live in the snapshot; its topic's admission decides the rest. */
function toRoomAuthorizationDecision(
    { input, targets, authority, nowEpochMs }: ToRoomAuthorizationDecisionInput
): RallarServerWsRoomAuthorizationDecision {
    const { snapshot } = authority;
    const sender = snapshot.activeSessions.find((session) => session.sessionId === input.senderId);
    if (!sender) {
        return false;
    }
    const admission = computeRoomPublicationAdmission({
        ...authority,
        topic: { ...input.topic, topicId: input.topicId },
        publisher: { kind: 'session', sessionId: sender.sessionId, principalId: sender.principalId },
        message: { ...input.message, targets },
        nowEpochMs
    });
    if (admission.left) {
        return {
            authorized: false,
            reason: toRoomPublicationNackReason(admission.left.code),
            logMessage: `Rejected room message for ${input.roomId}: ${admission.left.logMessage}`,
            serverSnapshotVersion: readGroupVersion(snapshot)
        };
    }
    const audience = admission.right!;
    if (isLeaderlessRoomAudience(input.message, audience)) {
        return {
            authorized: false,
            reason: 'no-leader',
            logMessage:
                `Rejected room message for ${input.roomId}: no-leader: the room has no active leader inside the audience the send names.`,
            serverSnapshotVersion: audience.snapshotVersion
        };
    }
    return { authorized: true, audience };
}

function toRoomPublicationNackReason(code: RoomPublicationAdmission.RefusalCode): ALNackReason {
    return code === 'topic-not-granted' ? 'unauthorized' : code;
}

/**
 * A `group-leader` send whose authorized audience delivers to no leader has nobody to confirm it: the room has no
 * director live in it, the sender is the director, or the sender's exclusions or list leave the director out.
 */
function isLeaderlessRoomAudience(message: ALMessage, audience: RallarServerWsRoomAudience): boolean {
    if (message.delivery?.ack !== 'group-leader') {
        return false;
    }
    const sessionIds = resolveALAdmittedRoomAudience(message, audience.sessions.map((session) => session.sessionId));
    return filterLiveWsRoomRecipientSessionIds(audience.targets, message.id.senderId, sessionIds)
        .every((sessionId) => sessionId === message.id.senderId);
}

async function readRoomAuthorizationSnapshot(
    dependencies: GroupRoomWsAuthorizerDependencies,
    input: RallarServerWsRoomAuthorizationInput
): Promise<ReadRoomAuthorizationSnapshotResult> {
    const groupRef = input.roomRef ??
        readALTargetGroupRef(input.message);
    const authority = groupRef ? await readRoomAuthority(dependencies, groupRef, input) : undefined;
    const snapshot = authority?.snapshot;
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
    if (!authority) {
        return { kind: 'denied', decision: toMissingRoomCacheDecision(input) };
    }
    const floorDenial = resolveRoomFloorDenial(input, authority.snapshot);
    if (floorDenial) {
        return { kind: 'denied', decision: floorDenial };
    }
    return { kind: 'ready', authority };
}

/** One read per pass: a granted topic's snapshot comes with its subscription authority, a members topic's alone. */
async function readRoomAuthority(
    dependencies: GroupRoomWsAuthorizerDependencies,
    groupRef: GroupRef,
    input: RallarServerWsRoomAuthorizationInput
): Promise<GroupPublicationAuthority | undefined> {
    if (input.topic.participation === 'granted') {
        return await dependencies.readPublicationAuthority(groupRef, input.topicId);
    }
    const snapshot = await dependencies.readGroupSnapshot(groupRef, input);
    return snapshot === undefined ? undefined : toMembersTopicPublicationAuthority(snapshot);
}

function toMissingRoomCacheDecision(
    input: RallarServerWsRoomAuthorizationInput
): RallarServerWsRoomAuthorizationDecision {
    const floors = [
        input.minSnapshotVersion === undefined ? undefined : `snapshot version ${input.minSnapshotVersion}`,
        input.rosterVersion === undefined ? undefined : `roster version ${input.rosterVersion}`
    ].filter((floor) => floor !== undefined);
    if (floors.length === 0) {
        return false;
    }
    return {
        authorized: false,
        reason: 'not-yet-in-sync',
        logMessage: `Room ${input.roomId} cache is missing; requires ${floors.join(' and ')}`
    };
}

function resolveRoomFloorDenial(
    input: RallarServerWsRoomAuthorizationInput,
    snapshot: GroupSnapshot
): RallarServerWsRoomAuthorizationDenied | undefined {
    const serverSnapshotVersion = readGroupVersion(snapshot);
    if (input.minSnapshotVersion !== undefined && serverSnapshotVersion < input.minSnapshotVersion) {
        return {
            authorized: false,
            reason: 'not-yet-in-sync',
            logMessage:
                `Room ${input.roomId} cache version ${serverSnapshotVersion} is older than required version ${input.minSnapshotVersion}`,
            serverSnapshotVersion
        };
    }
    if (input.rosterVersion !== undefined && snapshot.group.rosterVersion < input.rosterVersion) {
        return {
            authorized: false,
            reason: 'not-yet-in-sync',
            logMessage:
                `Room ${input.roomId} cache roster version ${snapshot.group.rosterVersion} is older than required roster version ${input.rosterVersion}`,
            serverSnapshotVersion
        };
    }
    return undefined;
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
    input: RallarServerWsRoomAuthorizationInput,
    denial: GroupPolicyDenied,
    serverSnapshotVersion?: number
): RallarServerWsRoomAuthorizationDenied {
    const reason = resolveRoomPolicyDenialReason(denial.code, input.topic);
    return {
        authorized: false,
        reason,
        logMessage: `Rejected room message for ${input.roomId}: ${reason}: ${denial.code}: ${denial.message}`,
        serverSnapshotVersion
    };
}

/** The only `forbidden-role` a sender meets here is the spectator's, and a spectator never publishes a granted topic. */
function resolveRoomPolicyDenialReason(
    code: GroupPolicyReasonCode,
    topic: RallarServerWsTopicAccess
): 'membership-fenced' | 'unauthorized' | 'no-publish-grant' {
    if (code === 'forbidden-role' && topic.participation === 'granted') {
        return 'no-publish-grant';
    }
    return code === 'member-not-active' || code === 'member-removed' || code === 'member-banned'
        ? 'membership-fenced'
        : 'unauthorized';
}
