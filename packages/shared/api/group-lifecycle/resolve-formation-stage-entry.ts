import type { GroupLifecycleState } from './group-lifecycle-policy.ts';

/**
 * Entering one of these stages begins a formation attempt: the group stamps
 * `establishmentStartedAtEpochMs` and the attempt's clock starts. Keyed on
 * the stage the transition lands in, never on the operation that caused it —
 * `start-establishment`, `reopen-establishment` and `connect` all arrive
 * here, and a new command joins by landing in one of these stages rather
 * than by being added to a list.
 */
const BEGINS_ESTABLISHMENT: Readonly<Record<GroupLifecycleState, boolean>> = {
    dormant: false,
    forming: false,
    planned: false,
    connecting: true,
    active: false,
    reconfiguring: true,
    reconnecting: true
};

/**
 * The stages whose formation deadline is actually evaluated. This is a
 * strict subset of the stages that begin an attempt: `reconnecting` starts a
 * dialing attempt but has no criterion or deadline consumer yet, so arming a
 * deadline for it would queue an entry the timer handler drops — the group
 * would park with no evaluation and no retry. The row joins its siblings
 * when slice 5e/11 makes the stage's criterion live; keep it in lockstep
 * with `CRITERION_EVALUATES` and the timer handler's own gate.
 */
const CONSUMES_FORMATION_DEADLINE: Readonly<Record<GroupLifecycleState, boolean>> = {
    dormant: false,
    forming: false,
    planned: false,
    connecting: true,
    active: false,
    reconfiguring: true,
    reconnecting: false
};

export function beginsGroupEstablishmentAt(lifecycleState: GroupLifecycleState): boolean {
    return BEGINS_ESTABLISHMENT[lifecycleState];
}

export function consumesFormationDeadlineAt(lifecycleState: GroupLifecycleState): boolean {
    return CONSUMES_FORMATION_DEADLINE[lifecycleState];
}
