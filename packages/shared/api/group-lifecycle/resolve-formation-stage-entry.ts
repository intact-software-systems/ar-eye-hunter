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

export function beginsGroupEstablishmentAt(lifecycleState: GroupLifecycleState): boolean {
    return BEGINS_ESTABLISHMENT[lifecycleState];
}

export function consumesFormationDeadlineAt(lifecycleState: GroupLifecycleState): boolean {
    return CONSUMES_FORMATION_DEADLINE[lifecycleState];
}
