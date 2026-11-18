import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { BackoffGateBounds } from '@shared/resilience/backoff-gate.ts';

import type { GroupLifecyclePolicyRead } from '../../../group-state/persistence/group-lifecycle-policy-repository.ts';

/** A room with no stored policy, or an unreadable one, takes the default preset's bounds. */
export function toTopologyReshapeBounds(read: GroupLifecyclePolicyRead): BackoffGateBounds {
    const { topology } = read.status === 'present' ? read.policy : createDefaultGroupLifecyclePolicy();
    return { minIntervalMs: topology.reshapeMinIntervalMs, maxIntervalMs: topology.reshapeMaxIntervalMs };
}
