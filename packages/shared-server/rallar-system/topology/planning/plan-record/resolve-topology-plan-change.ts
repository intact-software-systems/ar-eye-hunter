import type { TopologyLayoutDelta } from '@shared/api/topology-plan/rtc-topology-plan-record.ts';
import type { TopologyPlanChange } from '@shared/api/topology-plan/topology-plan-change.ts';

import type { RtcTopologyPlanDerivation } from './rtc-topology-plan-derivation.ts';

/** Null when the plan changes no member and no edge: whatever its derivation, it is no topology work. */
export function resolveTopologyPlanChange(
    derivation: RtcTopologyPlanDerivation,
    delta: TopologyLayoutDelta
): TopologyPlanChange | null {
    if (Object.values(delta).every((count) => count === 0)) {
        return null;
    }
    switch (derivation.method) {
        case 'rebuilt':
            return { kind: 'reshape', reason: derivation.reason };
        case 'established':
            return { kind: 'attach' };
        case 'incremental':
            return delta.leftSessionCount > 0 ? { kind: 'repair' } : { kind: 'attach' };
    }
}
