import { Either } from '../../resilience/Either.ts';
import { requireEpoch, requireExactKeys, requireOneOf, requireRecord } from '../exact-object-decoding.ts';
import { isGroupLayoutIdentity } from '../group-lifecycle/group-layout-identity.ts';
import {
    TOPOLOGY_REPLAN_CAUSES,
    type ReplacedTopologyLayout,
    type RtcTopologyPlanRecord,
    type TopologyLayoutDelta,
    type TopologyReplanCause
} from './rtc-topology-plan-record.ts';

export function decodeRtcTopologyPlanRecord(value: unknown): Either<string, RtcTopologyPlanRecord> {
    try {
        const record = requireRecord(value, 'Topology plan record');
        requireExactKeys(
            record,
            ['plannedAtEpochMs', 'replaced', 'causes', 'delta', 'longestPathHops'],
            'Topology plan record'
        );
        requireEpoch(record.plannedAtEpochMs, 'Topology plan record plannedAtEpochMs');
        requireEpoch(record.longestPathHops, 'Topology plan record longestPathHops');
        return Either.ofRight({
            plannedAtEpochMs: record.plannedAtEpochMs,
            replaced: record.replaced === null ? null : decodeReplacedTopologyLayout(record.replaced),
            causes: decodeTopologyReplanCauses(record.causes),
            delta: decodeTopologyLayoutDelta(record.delta),
            longestPathHops: record.longestPathHops
        });
    }
    catch (error) {
        return Either.ofLeft(error instanceof Error ? error.message : String(error));
    }
}

function decodeReplacedTopologyLayout(value: unknown): ReplacedTopologyLayout {
    const replaced = requireRecord(value, 'Replaced topology layout');
    requireExactKeys(replaced, ['layout', 'ageMs'], 'Replaced topology layout');
    requireEpoch(replaced.ageMs, 'Replaced topology layout ageMs');
    if (!isGroupLayoutIdentity(replaced.layout)) {
        throw new TypeError('Replaced topology layout layout is invalid');
    }
    return { layout: replaced.layout, ageMs: replaced.ageMs };
}

function decodeTopologyReplanCauses(value: unknown): readonly TopologyReplanCause[] {
    if (!Array.isArray(value)) {
        throw new TypeError('Topology plan record causes must be an array');
    }
    const causes = value.map((cause) => requireOneOf(cause, TOPOLOGY_REPLAN_CAUSES, 'Topology plan record cause'));
    const canonical = TOPOLOGY_REPLAN_CAUSES.filter((cause) => causes.includes(cause));
    if (causes.join('\0') !== canonical.join('\0')) {
        throw new TypeError('Topology plan record causes must be unique and in canonical order');
    }
    return causes;
}

function decodeTopologyLayoutDelta(value: unknown): TopologyLayoutDelta {
    const delta = requireRecord(value, 'Topology layout delta');
    requireExactKeys(delta, [
        'joinedSessionCount',
        'leftSessionCount',
        'changedSessionCount',
        'reroutedSessionCount',
        'acceptingSessionCount',
        'maxJoinerEdgesPerSession'
    ], 'Topology layout delta');
    requireEpoch(delta.joinedSessionCount, 'Topology layout delta joinedSessionCount');
    requireEpoch(delta.leftSessionCount, 'Topology layout delta leftSessionCount');
    requireEpoch(delta.changedSessionCount, 'Topology layout delta changedSessionCount');
    requireEpoch(delta.reroutedSessionCount, 'Topology layout delta reroutedSessionCount');
    requireEpoch(delta.acceptingSessionCount, 'Topology layout delta acceptingSessionCount');
    requireEpoch(delta.maxJoinerEdgesPerSession, 'Topology layout delta maxJoinerEdgesPerSession');
    return {
        joinedSessionCount: delta.joinedSessionCount,
        leftSessionCount: delta.leftSessionCount,
        changedSessionCount: delta.changedSessionCount,
        reroutedSessionCount: delta.reroutedSessionCount,
        acceptingSessionCount: delta.acceptingSessionCount,
        maxJoinerEdgesPerSession: delta.maxJoinerEdgesPerSession
    };
}
