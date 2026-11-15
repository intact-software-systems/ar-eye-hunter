import { Either } from '../../resilience/Either.ts';
import { decodePlainRecord, getOwnNumber, hasExactKeys } from '../exact-object-decoding.ts';
import { isGroupLayoutIdentity } from '../group-lifecycle/group-layout-identity.ts';
import {
    TOPOLOGY_REPLAN_CAUSES,
    type ReplacedTopologyLayout,
    type RtcTopologyPlanRecord,
    type TopologyLayoutDelta,
    type TopologyReplanCause
} from './rtc-topology-plan-record.ts';

const RECORD_KEYS = ['plannedAtEpochMs', 'replaced', 'causes', 'delta', 'longestPathHops'] as const;
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
    const plannedAtEpochMs = getCount(fields, 'plannedAtEpochMs');
    const longestPathHops = getCount(fields, 'longestPathHops');
    if (plannedAtEpochMs === null || longestPathHops === null) {
        return Either.ofLeft('Topology plan record plannedAtEpochMs and longestPathHops must be non-negative integers');
    }
    const replaced: Either<string, ReplacedTopologyLayout | null> = getOwnField(fields, 'replaced') === null
        ? Either.ofRight(null)
        : decodeReplacedTopologyLayout(getOwnField(fields, 'replaced'));
    const causes = decodeTopologyReplanCauses(getOwnField(fields, 'causes'));
    const delta = decodeTopologyLayoutDelta(getOwnField(fields, 'delta'));
    if (replaced.right === undefined || causes.right === undefined || delta.right === undefined) {
        return Either.ofLeft(replaced.left ?? causes.left ?? delta.left ?? 'Topology plan record is invalid');
    }
    return Either.ofRight({
        plannedAtEpochMs,
        replaced: replaced.right,
        causes: causes.right,
        delta: delta.right,
        longestPathHops
    });
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
    const ageMs = getCount(fields, 'ageMs');
    if (ageMs === null) {
        return Either.ofLeft('Replaced topology layout ageMs must be a non-negative integer');
    }
    return Either.ofRight({ layout, ageMs });
}

function decodeTopologyReplanCauses(value: unknown): Either<string, readonly TopologyReplanCause[]> {
    if (!Array.isArray(value)) {
        return Either.ofLeft('Topology plan record causes must be an array');
    }
    const causes = TOPOLOGY_REPLAN_CAUSES.filter((cause) => value.includes(cause));
    if (causes.length !== value.length || causes.some((cause, index) => cause !== value[index])) {
        return Either.ofLeft('Topology plan record causes must be known, unique and in canonical order');
    }
    return Either.ofRight(causes);
}

function decodeTopologyLayoutDelta(value: unknown): Either<string, TopologyLayoutDelta> {
    const fields = decodePlainRecord(value).right;
    if (fields === undefined || !hasExactKeys(fields, DELTA_KEYS)) {
        return Either.ofLeft('Topology layout delta must be an exact object with its own fields');
    }
    const badField = DELTA_KEYS.find((key) => getCount(fields, key) === null);
    if (badField !== undefined) {
        return Either.ofLeft(`Topology layout delta ${badField} must be a non-negative integer`);
    }
    return Either.ofRight({
        joinedSessionCount: getOwnNumber(fields, ['joinedSessionCount'], Number.NaN),
        leftSessionCount: getOwnNumber(fields, ['leftSessionCount'], Number.NaN),
        changedSessionCount: getOwnNumber(fields, ['changedSessionCount'], Number.NaN),
        reroutedSessionCount: getOwnNumber(fields, ['reroutedSessionCount'], Number.NaN),
        acceptingSessionCount: getOwnNumber(fields, ['acceptingSessionCount'], Number.NaN),
        maxJoinerEdgesPerSession: getOwnNumber(fields, ['maxJoinerEdgesPerSession'], Number.NaN)
    });
}

function getCount(record: object, key: string): number | null {
    const count = getOwnNumber(record, [key], Number.NaN);
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function getOwnField(record: object, key: string) {
    return Object.getOwnPropertyDescriptor(record, key)?.value;
}
