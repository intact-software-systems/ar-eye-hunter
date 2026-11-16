import { Either } from '../../resilience/Either.ts';
import { decodePlainRecord, hasExactKeys } from '../exact-object-decoding.ts';
import { isGroupLayoutIdentity } from '../group-lifecycle/group-layout-identity.ts';
import type { GroupRef } from '../group-types.ts';
import type { RallarRtcTopologyKind } from '../overlay-topology.ts';
import { decodeRtcTopologyPlanRecord } from '../topology-plan/decode-rtc-topology-plan-record.ts';
import type { RtcTopologyPlanRecord } from '../topology-plan/rtc-topology-plan-record.ts';
import {
    ADMIN_ROOM_TOPOLOGY_PLANS_MAX_LIMIT,
    type AdminRoomTopologyPlan,
    type AdminRoomTopologyPlansResponse
} from './admin-room-topology-plans.ts';

const RESPONSE_KEYS = ['roomRef', 'observedAtEpochMs', 'plans', 'nextAfterPublicationId'] as const;
const ROOM_REF_KEYS = ['applicationId', 'workspaceId', 'groupId'] as const;
const PLAN_KEYS = [
    'publicationId',
    'requestedAtEpochMs',
    'layout',
    'topology',
    'memberCount',
    'degreeLimit',
    'plan'
] as const;
const TOPOLOGY_KINDS = ['star', 'tree', 'mesh'] as const satisfies readonly RallarRtcTopologyKind[];
const MAX_PUBLICATION_ID_LENGTH = 256;

export function decodeAdminRoomTopologyPlans(value: unknown): Either<string, AdminRoomTopologyPlansResponse> {
    const fields = decodePlainRecord(value).right;
    if (fields === undefined || !hasExactKeys(fields, RESPONSE_KEYS)) {
        return Either.ofLeft('Room topology plans must be an exact object with its own fields');
    }
    const roomRef = decodeRoomRef(getOwnField(fields, 'roomRef'));
    const observedAtEpochMs = getOwnField(fields, 'observedAtEpochMs');
    const nextAfterPublicationId = getOwnField(fields, 'nextAfterPublicationId');
    const entries = getOwnField(fields, 'plans');
    if (
        roomRef === null || !isCount(observedAtEpochMs) ||
        (nextAfterPublicationId !== null && !isPublicationId(nextAfterPublicationId)) ||
        !Array.isArray(entries) || entries.length > ADMIN_ROOM_TOPOLOGY_PLANS_MAX_LIMIT
    ) {
        return Either.ofLeft('Room topology plans name no room, observation time, page of plans or cursor');
    }
    const plans: AdminRoomTopologyPlan[] = [];
    for (const entry of entries) {
        const plan = decodeAdminRoomTopologyPlan(entry);
        if (plan.right === undefined) {
            return Either.ofLeft(plan.left ?? 'Room topology plan is invalid');
        }
        plans.push(plan.right);
    }
    return Either.ofRight({ roomRef, observedAtEpochMs, plans, nextAfterPublicationId });
}

function decodeAdminRoomTopologyPlan(value: unknown): Either<string, AdminRoomTopologyPlan> {
    const fields = decodePlainRecord(value).right;
    if (fields === undefined || !hasExactKeys(fields, PLAN_KEYS)) {
        return Either.ofLeft('Room topology plan must be an exact object with its own fields');
    }
    const publicationId = getOwnField(fields, 'publicationId');
    const requestedAtEpochMs = getOwnField(fields, 'requestedAtEpochMs');
    const layout = getOwnField(fields, 'layout');
    const topology = TOPOLOGY_KINDS.find((kind) => kind === getOwnField(fields, 'topology'));
    const memberCount = getOwnField(fields, 'memberCount');
    const degreeLimit = getOwnField(fields, 'degreeLimit');
    if (
        !isPublicationId(publicationId) || !isCount(requestedAtEpochMs) || !isGroupLayoutIdentity(layout) ||
        topology === undefined || !isCount(memberCount) || !isCount(degreeLimit)
    ) {
        return Either.ofLeft('Room topology plan names no publication, request time, layout, kind or sizes');
    }
    const plan: Either<string, RtcTopologyPlanRecord | null> = getOwnField(fields, 'plan') === null
        ? Either.ofRight(null)
        : decodeRtcTopologyPlanRecord(getOwnField(fields, 'plan'));
    return plan.mapRight((record) => ({
        publicationId,
        requestedAtEpochMs,
        layout,
        topology,
        memberCount,
        degreeLimit,
        plan: record
    }));
}

function decodeRoomRef(value: unknown): GroupRef | null {
    const fields = decodePlainRecord(value).right;
    if (fields === undefined || !hasExactKeys(fields, ROOM_REF_KEYS)) {
        return null;
    }
    const applicationId = getOwnField(fields, 'applicationId');
    const workspaceId = getOwnField(fields, 'workspaceId');
    const groupId = getOwnField(fields, 'groupId');
    return isNonEmptyString(applicationId) && isNonEmptyString(workspaceId) && isNonEmptyString(groupId)
        ? { applicationId, workspaceId, groupId }
        : null;
}

function isCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPublicationId(value: unknown): value is string {
    return isNonEmptyString(value) && value.length <= MAX_PUBLICATION_ID_LENGTH;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function getOwnField(record: object, key: string) {
    return Object.getOwnPropertyDescriptor(record, key)?.value;
}
