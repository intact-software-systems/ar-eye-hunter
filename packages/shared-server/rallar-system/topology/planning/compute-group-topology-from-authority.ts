import { validateGroupTopologyNextHops } from '@shared-graph/group-topology-validation.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { readGroupCreatedByPrincipalId, readGroupMemberSessionIds } from '@shared/api/group-client-views.ts';
import { toCanonicalGroupRef, type GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import { filterRtcRttMeasurementsForGroup } from '../../rtc-rtt/policy/rtc-rtt-measurement-policy.ts';
import { GroupTopologyValidationError } from '../group-topology-errors.ts';
import { compareRtcTopologyIdentifiers } from '../persistence/rtc-topology-identifiers.ts';
import type { RtcTopologyPlanningIntent } from '../runtime/rallar-rtc-topology-service.ts';
import type { GroupTopologyPlanningAuthority } from './group-topology-planning-authority.ts';
import type { ReconcileGroupTopologyResult } from './group-topology-planning-contracts.ts';
import {
    resolveTopologyPlanAction,
    type TopologyWorkOrigin
} from './resolve-topology-plan-action.ts';
import { computeRtcTopologyPlan } from './rtc-topology-planner.ts';
import { isGroupTopologyActiveAt } from './select-group-topology-planning-snapshot.ts';

export interface TopologyPlanningRequest {
    readonly intent: RtcTopologyPlanningIntent;
    readonly origin: TopologyWorkOrigin;
}

export function computeGroupTopologyFromAuthority(
    authority: GroupTopologyPlanningAuthority,
    previous: RallarOverlayTopologySnapshot | undefined,
    planning: TopologyPlanningRequest
): ReconcileGroupTopologyResult {
    if (!isGroupTopologyActiveAt(authority.group, authority.nowEpochMs)) {
        return computeRemovedTopology(authority.group, previous);
    }
    const action = resolveTopologyPlanAction({
        lifecycleState: authority.group.group.lifecycleState,
        replanning: authority.replanning,
        workOrigin: planning.origin,
        previous
    });
    if (action === 'publish-removal') {
        return computeRemovedTopology(authority.group, previous);
    }
    if (action === 'freeze') {
        return { action: 'frozen', current: requireFrozenTopology(previous) };
    }
    const result = computeRtcTopologyPlan(
        {
            ...authority.config.effective,
            ...authority.kindHysteresisWidths,
            rttReportingDegreeLimit: authority.rttReportingDegreeLimit
        },
        {
            group: authority.group,
            rttMeasurements: filterRtcRttMeasurementsForGroup({
                group: authority.group,
                rttMeasurements: authority.rttMeasurements,
                overlaySnapshot: previous,
                degreeLimit: authority.rttReportingDegreeLimit
            }),
            previous,
            updateOptions: {
                previous,
                topologyOptions: authority.config.effective,
                planningIntent: planning.intent
            },
            nowEpochMs: authority.nowEpochMs
        }
    );
    return { ...result, action: 'planned' };
}

export function validateComputedGroupTopology(computed: ReconcileGroupTopologyResult): void {
    validateComputedTopologySnapshot(computed.action === 'planned' ? computed.snapshot : computed.current);
}

export function validateComputedTopologySnapshot(snapshot: RallarOverlayTopologySnapshot): void {
    if (snapshot.state === 'removed') {
        return;
    }
    const result = validateGroupTopologyNextHops({
        activeSessionIds: new Set(snapshot.activeSessionIds),
        nextHopsBySessionId: snapshot.nextHopsBySessionId,
        maxDegree: snapshot.degreeLimit
    });
    if (!result.valid) {
        throw new GroupTopologyValidationError(
            result.issues.map((issue) => ({
                code: issue.code,
                path: issue.sessionId ? ['nextHopsBySessionId', issue.sessionId] : undefined,
                message: issue.code,
                details: issue
            }))
        );
    }
}

export function requireFrozenTopology(
    previous: RallarOverlayTopologySnapshot | undefined
): RallarOverlayTopologySnapshot {
    if (!previous) {
        throw new TypeError('A frozen topology plan requires a stored layout');
    }
    return previous;
}

function computeRemovedTopology(
    group: GroupSnapshot,
    previous: RallarOverlayTopologySnapshot | undefined
): ReconcileGroupTopologyResult {
    const activeSessionIds = [
        ...new Set([...(previous?.activeSessionIds ?? []), ...readGroupMemberSessionIds(group)])
    ].sort(compareRtcTopologyIdentifiers);
    return {
        action: 'planned',
        planningObservation: null,
        snapshot: {
            sourceGroupStateCausalRevision: group.causalRevision,
            state: 'removed',
            overlayId: toScopedOverlayId(group.group),
            groupRef: toCanonicalGroupRef(group.group),
            name: previous?.name ?? group.group.displayName,
            topology: previous?.topology ?? 'star',
            activeSessionIds,
            nextHopsBySessionId: Object.fromEntries(activeSessionIds.map((sessionId) => [sessionId, []])),
            degreeLimit: previous?.degreeLimit ?? 1,
            version: previous?.version ?? 0,
            createdByClientId: previous?.createdByClientId ?? readGroupCreatedByPrincipalId(group),
            createdAtEpochMs: previous?.createdAtEpochMs ?? group.group.created.atEpochMs,
            updatedAtEpochMs: group.group.updated.atEpochMs
        },
        previous: previous ?? null,
        changed: previous?.state !== 'removed'
    };
}
