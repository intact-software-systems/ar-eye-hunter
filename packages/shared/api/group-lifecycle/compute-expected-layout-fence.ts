import { isSameGroupLayoutIdentity, type GroupLayoutIdentity } from './group-layout-identity.ts';

export type ExpectedLayoutFenceOutcome =
    | 'match'
    | 'stale-epoch'
    | 'no-planned-layout'
    | 'planned-layout-superseded';

export interface ComputeExpectedLayoutFenceInput {
    readonly expectedFormationEpoch: number;
    readonly expectedLayout: GroupLayoutIdentity;
    readonly currentFormationEpoch: number;
    /** The current planned row's identity; `undefined` when none is stored. */
    readonly currentPlannedLayout: GroupLayoutIdentity | undefined;
}

/**
 * The causal fence every internal command and `connect` carries (product
 * decisions 19 and 32): the command names the exact planned layout it means,
 * and any mismatch is a typed outcome that writes nothing — never a silent
 * no-op. Every non-identical current layout, including an incomparable one or
 * the named layout's own tombstone, reads `planned-layout-superseded`: the
 * layout the caller waited for is no longer the current plan.
 */
export function computeExpectedLayoutFence(
    input: ComputeExpectedLayoutFenceInput
): ExpectedLayoutFenceOutcome {
    if (input.expectedFormationEpoch !== input.currentFormationEpoch) {
        return 'stale-epoch';
    }
    if (input.currentPlannedLayout === undefined) {
        return 'no-planned-layout';
    }
    return isSameGroupLayoutIdentity(input.expectedLayout, input.currentPlannedLayout)
        ? 'match'
        : 'planned-layout-superseded';
}
