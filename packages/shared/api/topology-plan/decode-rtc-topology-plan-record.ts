import { getOwnCount, getOwnField } from '../../encoding/get-own-field.ts';
import { Either } from '../../resilience/Either.ts';
import { decodePlainRecord, hasExactKeys } from '../exact-object-decoding.ts';
import { isGroupLayoutIdentity } from '../group-lifecycle/group-layout-identity.ts';
import { decodeCanonicalSubset } from './decode-canonical-subset.ts';
import { isEmptyTopologyLayoutDelta } from './is-empty-topology-layout-delta.ts';
import {
    TOPOLOGY_REPLAN_CAUSES,
    type ReplacedTopologyLayout,
    type RtcTopologyPlanRecord,
    type TopologyLayoutDelta
} from './rtc-topology-plan-record.ts';
import { TOPOLOGY_RESHAPE_REASONS, type TopologyPlanChange } from './topology-plan-change.ts';
import { HELD_TOPOLOGY_RESHAPE_REASONS } from './topology-reshape-gate.ts';

const RECORD_KEYS = [
    'plannedAtEpochMs',
    'replaced',
    'causes',
    'delta',
    'longestPathHops',
    'change',
    'heldReshapeReasons'
] as const;
const REPLACED_KEYS = ['layout', 'ageMs'] as const;
const DELTA_KEYS = [
    'joinedSessionCount',
    'leftSessionCount',
    'changedSessionCount',
    'reroutedSessionCount',
    'acceptingSessionCount',
    'maxJoinerEdgesPerSession'
] as const satisfies readonly (keyof TopologyLayoutDelta)[];

export function decodeRtcTopologyPlanRecord(value: unknown): Either<string, RtcTopologyPlanRecord> {
    const fields = decodePlainRecord(value).right;
    if (fields === undefined || !hasExactKeys(fields, RECORD_KEYS)) {
        return Either.ofLeft('Topology plan record must be an exact object with its own fields');
    }
    const plannedAtEpochMs = getOwnCount(fields, 'plannedAtEpochMs');
    const longestPathHops = getOwnCount(fields, 'longestPathHops');
    if (plannedAtEpochMs === null || longestPathHops === null) {
        return Either.ofLeft('Topology plan record plannedAtEpochMs and longestPathHops must be non-negative integers');
    }
    const replaced: Either<string, ReplacedTopologyLayout | null> = getOwnField(fields, 'replaced') === null
        ? Either.ofRight(null)
        : decodeReplacedTopologyLayout(getOwnField(fields, 'replaced'));
    const causes = decodeCanonicalSubset(
        getOwnField(fields, 'causes'),
        TOPOLOGY_REPLAN_CAUSES,
        'Topology plan record causes'
    );
    const delta = decodeTopologyLayoutDelta(getOwnField(fields, 'delta'));
    const change = decodeTopologyPlanChange(getOwnField(fields, 'change'));
    const heldReshapeReasons = decodeCanonicalSubset(
        getOwnField(fields, 'heldReshapeReasons'),
        HELD_TOPOLOGY_RESHAPE_REASONS,
        'Topology plan record heldReshapeReasons'
    );
    if (
        replaced.right === undefined || causes.right === undefined || delta.right === undefined ||
        change.right === undefined || heldReshapeReasons.right === undefined
    ) {
        return Either.ofLeft(
            replaced.left ?? causes.left ?? delta.left ?? change.left ?? heldReshapeReasons.left ??
                'Topology plan record is invalid'
        );
    }
    if ((change.right === null) !== isEmptyTopologyLayoutDelta(delta.right)) {
        return Either.ofLeft('Topology plan record change must be null exactly when its delta is empty');
    }
    return Either.ofRight({
        plannedAtEpochMs,
        replaced: replaced.right,
        causes: causes.right,
        delta: delta.right,
        longestPathHops,
        change: change.right,
        heldReshapeReasons: heldReshapeReasons.right
    });
}

function decodeTopologyPlanChange(value: unknown): Either<string, TopologyPlanChange | null> {
    if (value === null) {
        return Either.ofRight(null);
    }
    const fields = decodePlainRecord(value).right ?? {};
    const kind = getOwnField(fields, 'kind');
    if ((kind === 'attach' || kind === 'repair') && hasExactKeys(fields, ['kind'])) {
        return Either.ofRight({ kind });
    }
    const reason = TOPOLOGY_RESHAPE_REASONS.find((known) => known === getOwnField(fields, 'reason'));
    if (kind === 'reshape' && reason !== undefined && hasExactKeys(fields, ['kind', 'reason'])) {
        return Either.ofRight({ kind, reason });
    }
    return Either.ofLeft('Topology plan change must be null, an attach, a repair, or a reshape with a known reason');
}

function decodeReplacedTopologyLayout(value: unknown): Either<string, ReplacedTopologyLayout> {
    const fields = decodePlainRecord(value).right;
    if (fields === undefined || !hasExactKeys(fields, REPLACED_KEYS)) {
        return Either.ofLeft('Replaced topology layout must be an exact object with layout and ageMs');
    }
    const layout = getOwnField(fields, 'layout');
    if (!isGroupLayoutIdentity(layout)) {
        return Either.ofLeft('Replaced topology layout layout is not a layout identity');
    }
    const ageMs = getOwnCount(fields, 'ageMs');
    if (ageMs === null) {
        return Either.ofLeft('Replaced topology layout ageMs must be a non-negative integer');
    }
    return Either.ofRight({ layout, ageMs });
}

function decodeTopologyLayoutDelta(value: unknown): Either<string, TopologyLayoutDelta> {
    const fields = decodePlainRecord(value).right;
    if (fields === undefined || !hasExactKeys(fields, DELTA_KEYS)) {
        return Either.ofLeft('Topology layout delta must be an exact object with its own fields');
    }
    const delta = {
        joinedSessionCount: getOwnCount(fields, 'joinedSessionCount'),
        leftSessionCount: getOwnCount(fields, 'leftSessionCount'),
        changedSessionCount: getOwnCount(fields, 'changedSessionCount'),
        reroutedSessionCount: getOwnCount(fields, 'reroutedSessionCount'),
        acceptingSessionCount: getOwnCount(fields, 'acceptingSessionCount'),
        maxJoinerEdgesPerSession: getOwnCount(fields, 'maxJoinerEdgesPerSession')
    };
    if (!isCountedTopologyLayoutDelta(delta)) {
        const badField = DELTA_KEYS.find((key) => delta[key] === null);
        return Either.ofLeft(`Topology layout delta ${badField} must be a non-negative integer`);
    }
    return Either.ofRight(delta);
}

function isCountedTopologyLayoutDelta(
    delta: Readonly<Record<keyof TopologyLayoutDelta, number | null>>
): delta is TopologyLayoutDelta {
    return DELTA_KEYS.every((key) => delta[key] !== null);
}
