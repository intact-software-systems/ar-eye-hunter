import type { GroupPolicyDenied } from '../group-policy-types.ts';
import type { GroupLifecycleState } from './group-lifecycle-policy.ts';

export type GroupLifecycleTransition =
    | 'start-establishment'
    | 'activate'
    | 'reopen-establishment'
    | 'fail-formation';

export type GroupLifecycleTransitionOutcome =
    | Readonly<{
        allowed: true;
        nextState: GroupLifecycleState;
        nextFormationEpoch: number;
    }>
    | GroupPolicyDenied;

const TRANSITION_SOURCES: Readonly<Record<GroupLifecycleTransition, readonly GroupLifecycleState[]>> = {
    'start-establishment': ['forming'],
    activate: ['establishing', 'reconfiguring'],
    'reopen-establishment': ['active'],
    'fail-formation': ['establishing', 'reconfiguring']
};

const TRANSITION_TARGETS: Readonly<Record<GroupLifecycleTransition, GroupLifecycleState>> = {
    'start-establishment': 'establishing',
    activate: 'active',
    'reopen-establishment': 'reconfiguring',
    'fail-formation': 'forming'
};

/**
 * The intent state machine. Every accepted transition advances the formation
 * epoch, and nothing else does — election and readiness pin their member set
 * to the epoch, so an advance on join would flap them (plan correction 4).
 */
export function computeGroupLifecycleTransition(
    input: Readonly<{
        transition: GroupLifecycleTransition;
        lifecycleState: GroupLifecycleState;
        formationEpoch: number;
    }>
): GroupLifecycleTransitionOutcome {
    const sources = TRANSITION_SOURCES[input.transition];
    if (!sources.includes(input.lifecycleState)) {
        return {
            allowed: false,
            code: 'lifecycle-transition-invalid',
            message: `Cannot ${input.transition} from lifecycle state '${input.lifecycleState}'.`,
            details: {
                transition: input.transition,
                lifecycleState: input.lifecycleState
            }
        };
    }
    return {
        allowed: true,
        nextState: TRANSITION_TARGETS[input.transition],
        nextFormationEpoch: input.formationEpoch + 1
    };
}
