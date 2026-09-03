import type { GroupLifecycleState } from './group-lifecycle-policy.ts';

const BEGINS_ESTABLISHMENT: Readonly<Record<GroupLifecycleState, boolean>> = {
    dormant: false,
    forming: false,
    planned: false,
    connecting: true,
    active: false,
    reconfiguring: false,
    reconnecting: true
};

const CONSUMES_FORMATION_DEADLINE: Readonly<Record<GroupLifecycleState, boolean>> = {
    dormant: false,
    forming: false,
    planned: false,
    connecting: true,
    active: false,
    reconfiguring: false,
    reconnecting: true
};

/** The stages that hold a planned candidate for `connect` — where a connect trigger arms and petitions. */
const HOLDS_PLANNED_CANDIDATE: Readonly<Record<GroupLifecycleState, boolean>> = {
    dormant: false,
    forming: false,
    planned: true,
    connecting: false,
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

export function holdsPlannedCandidateAt(lifecycleState: GroupLifecycleState): boolean {
    return HOLDS_PLANNED_CANDIDATE[lifecycleState];
}
