import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { BackoffGateBounds } from '@shared/resilience/backoff-gate.ts';

import type { GroupLifecyclePolicyRead } from '../../../group-state/persistence/group-lifecycle-policy-repository.ts';

/** A room with no stored policy, or an unreadable one, takes the default preset's bounds. */
export function toTopologyReshapeBounds(read: GroupLifecyclePolicyRead): BackoffGateBounds {
    switch (read.status) {
        case 'present':
            return toBackoffGateBounds(read.policy.topology);
        case 'absent':
        case 'corrupt':
            // The defaults are safe here: a corrupt policy already holds automatic re-planning.
            return toBackoffGateBounds(createDefaultGroupLifecyclePolicy().topology);
    }
}

function toBackoffGateBounds(topology: GroupLifecyclePolicy['topology']): BackoffGateBounds {
    return { minIntervalMs: topology.reshapeMinIntervalMs, maxIntervalMs: topology.reshapeMaxIntervalMs };
}
