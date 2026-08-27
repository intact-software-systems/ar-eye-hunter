import type { GroupLifecycleState, GroupPreActivationAppData, GroupTransportState } from './group-lifecycle-policy.ts';

export type GroupDataGate =
    | 'flows'
    | 'blocked'
    | 'halted';

/**
 * The forward gate under `blocked-until-active`: closed while no layout has
 * been accepted in the current formation series, derived from the stage and
 * never stored (product decision 25). A below-floor return to `forming` closes
 * it again because the accepted layout was dropped.
 */
const FORWARD_GATE_BLOCKS: Readonly<Record<GroupLifecycleState, boolean>> = {
    dormant: true,
    forming: true,
    planned: true,
    connecting: true,
    active: false,
    reconfiguring: false,
    reconnecting: false
};

export interface ComputeGroupDataGateInput {
    readonly lifecycleState: GroupLifecycleState;
    readonly transportState: GroupTransportState;
    readonly preActivationAppData: GroupPreActivationAppData;
}

/**
 * Application data is refused in exactly two composing cases (product decision
 * 25): the halt, under every data policy; and the forward gate, under
 * `blocked-until-active` only. CRDT topics stay exempt at the relay, not here.
 */
export function computeGroupDataGate(input: ComputeGroupDataGateInput): GroupDataGate {
    if (input.transportState === 'halted') {
        return 'halted';
    }
    if (
        input.preActivationAppData === 'blocked-until-active' &&
        (FORWARD_GATE_BLOCKS[input.lifecycleState] ?? true)
    ) {
        return 'blocked';
    }
    return 'flows';
}
