import type { GroupRef } from '../group-types.ts';
import type {
    GroupFormationOutcome,
    GroupLifecycleState,
} from './group-lifecycle-policy.ts';
import type { GroupFormationReadiness } from './compute-group-formation-readiness.ts';

/**
 * The formation read surface: enough for an application to explain the group
 * to a user -- authoritative intent beside derived observation. The readiness
 * fraction is computed at read time and never stored; `lastFormationOutcome`
 * is the recorded decision from the criterion's last evaluation.
 */
export type GroupFormationView = Readonly<{
    groupRef: GroupRef;
    lifecycleState: GroupLifecycleState;
    formationEpoch: number;
    formationAttemptCount: number;
    lastFormationOutcome: GroupFormationOutcome | null;
    establishmentStartedAtEpochMs: number | null;
    readiness: GroupFormationReadiness;
}>;
