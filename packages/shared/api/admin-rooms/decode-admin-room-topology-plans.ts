import { getOwnCount, getOwnField } from '../../encoding/get-own-field.ts';
import { Either } from '../../resilience/Either.ts';
import { decodePlainRecord, hasExactKeys } from '../exact-object-decoding.ts';
import { isGroupLayoutIdentity } from '../group-lifecycle/group-layout-identity.ts';
import { RALLAR_RTC_TOPOLOGY_KINDS } from '../overlay-topology.ts';
import { decodeRtcTopologyPlanRecord } from '../topology-plan/decode-rtc-topology-plan-record.ts';
import type { RtcTopologyPlanRecord } from '../topology-plan/rtc-topology-plan-record.ts';
import {
    ADMIN_ROOM_TOPOLOGY_PLANS_MAX_LIMIT,
    type AdminRoomTopologyPlan,
    type AdminRoomTopologyPlansResponse
} from './admin-room-topology-plans.ts';
import { decodeAdminRoomRef } from './decode-admin-room-ref.ts';
import { isAdminTopologyOutboxId } from './decode-admin-room-topology-work.ts';

const RESPONSE_KEYS = ['roomRef', 'observedAtEpochMs', 'plans', 'nextAfterPublicationId'] as const;
const PLAN_KEYS = [
    'publicationId',
    'requestedAtEpochMs',
    'layout',
    'topology',
    'memberCount',
    'degreeLimit',
    'plan'
] as const;

export function decodeAdminRoomTopologyPlans(value: unknown): Either<string, AdminRoomTopologyPlansResponse> {
    const fields = decodePlainRecord(value).right;
    if (fields === undefined || !hasExactKeys(fields, RESPONSE_KEYS)) {
        return Either.ofLeft('Room topology plans must be an exact object with its own fields');
    }
    const roomRef = decodeAdminRoomRef(getOwnField(fields, 'roomRef')).right;
    const observedAtEpochMs = getOwnCount(fields, 'observedAtEpochMs');
    const nextAfterPublicationId = getOwnField(fields, 'nextAfterPublicationId');
    const entries = getOwnField(fields, 'plans');
    if (
        roomRef === undefined || observedAtEpochMs === null ||
        (nextAfterPublicationId !== null && !isAdminTopologyOutboxId(nextAfterPublicationId)) ||
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
    const requestedAtEpochMs = getOwnCount(fields, 'requestedAtEpochMs');
    const layout = getOwnField(fields, 'layout');
    const topology = RALLAR_RTC_TOPOLOGY_KINDS.find((kind) => kind === getOwnField(fields, 'topology'));
    const memberCount = getOwnCount(fields, 'memberCount');
    const degreeLimit = getOwnCount(fields, 'degreeLimit');
    if (
        !isAdminTopologyOutboxId(publicationId) || requestedAtEpochMs === null || !isGroupLayoutIdentity(layout) ||
        topology === undefined || memberCount === null || degreeLimit === null
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
