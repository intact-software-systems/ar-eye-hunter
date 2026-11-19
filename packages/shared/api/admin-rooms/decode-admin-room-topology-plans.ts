import { getOwnCount, getOwnField } from '../../encoding/get-own-field.ts';
import { Either } from '../../resilience/Either.ts';
import type { ApiJsonValue } from '../api-json-value.ts';
import { decodePlainRecord, hasExactKeys } from '../exact-object-decoding.ts';
import { isGroupLayoutIdentity } from '../group-lifecycle/group-layout-identity.ts';
import { RALLAR_RTC_TOPOLOGY_KINDS } from '../overlay-topology.ts';
import { decodeRtcTopologyPlanRecord } from '../topology-plan/decode-rtc-topology-plan-record.ts';
import { decodeTopologyReshapeGateState } from '../topology-plan/decode-topology-reshape-gate-state.ts';
import type { RtcTopologyPlanRecord } from '../topology-plan/rtc-topology-plan-record.ts';
import {
    ADMIN_ROOM_TOPOLOGY_PLANS_MAX_LIMIT,
    type AdminRoomReshapeGate,
    type AdminRoomTopologyPlan,
    type AdminRoomTopologyPlansResponse
} from './admin-room-topology-plans.ts';
import { decodeAdminRoomRef } from './decode-admin-room-ref.ts';
import { isAdminTopologyOutboxId } from './decode-admin-room-topology-work.ts';

const RESPONSE_KEYS = [
    'roomRef',
    'observedAtEpochMs',
    'plans',
    'nextAfterPublicationId',
    'reshapeGate'
] as const satisfies readonly (keyof AdminRoomTopologyPlansResponse)[];
const RESHAPE_GATE_KEYS = [
    'gate',
    'wantedReasons',
    'intervalMs',
    'opensAtEpochMs'
] as const satisfies readonly (keyof AdminRoomReshapeGate)[];
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
    const plans = decodeAdminRoomTopologyPlanPage(entries);
    const reshapeGate: Either<string, AdminRoomReshapeGate | null> = getOwnField(fields, 'reshapeGate') === null
        ? Either.ofRight(null)
        : decodeAdminRoomReshapeGate(getOwnField(fields, 'reshapeGate'));
    if (plans.right === undefined || reshapeGate.right === undefined) {
        return Either.ofLeft(plans.left ?? reshapeGate.left ?? 'Room topology plans are invalid');
    }
    return Either.ofRight({
        roomRef,
        observedAtEpochMs,
        plans: plans.right,
        nextAfterPublicationId,
        reshapeGate: reshapeGate.right
    });
}

function decodeAdminRoomTopologyPlanPage(entries: readonly ApiJsonValue[]): Either<string, AdminRoomTopologyPlan[]> {
    const plans: AdminRoomTopologyPlan[] = [];
    for (const entry of entries) {
        const plan = decodeAdminRoomTopologyPlan(entry);
        if (plan.right === undefined) {
            return Either.ofLeft(plan.left ?? 'Room topology plan is invalid');
        }
        plans.push(plan.right);
    }
    return Either.ofRight(plans);
}

/** The opening must be the one the gate and its wait imply, so a reader never sees two answers. */
function decodeAdminRoomReshapeGate(value: unknown): Either<string, AdminRoomReshapeGate> {
    const fields = decodePlainRecord(value).right;
    if (fields === undefined || !hasExactKeys(fields, RESHAPE_GATE_KEYS)) {
        return Either.ofLeft('Room reshape gate must be an exact object with its own fields');
    }
    const state = decodeTopologyReshapeGateState({
        gate: getOwnField(fields, 'gate'),
        wantedReasons: getOwnField(fields, 'wantedReasons')
    });
    const intervalMs = getOwnCount(fields, 'intervalMs');
    if (state.right === undefined || intervalMs === null) {
        return Either.ofLeft(state.left ?? 'Room reshape gate intervalMs must be a non-negative integer');
    }
    const { lastPassAtEpochMs } = state.right.gate;
    const opensAtEpochMs = lastPassAtEpochMs === null ? null : lastPassAtEpochMs + intervalMs;
    if (getOwnField(fields, 'opensAtEpochMs') !== opensAtEpochMs) {
        return Either.ofLeft('Room reshape gate opensAtEpochMs must be its last reshape plus intervalMs, or null');
    }
    return Either.ofRight({ ...state.right, intervalMs, opensAtEpochMs });
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
