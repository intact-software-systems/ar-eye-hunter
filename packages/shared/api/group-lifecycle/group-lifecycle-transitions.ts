import type { GroupPolicyDenied } from '../group-policy-types.ts';
import type { GroupLifecycleState } from './group-lifecycle-policy.ts';

export type GroupLifecycleTransition =
    | 'reset'
    | 'start'
    | 'plan'
    | 'connect'
    | 'start-establishment'
    | 'activate'
    | 'reconfigure'
    | 'reopen-establishment'
    | 'fail-formation';

export type GroupLifecycleTransitionOutcome =
    | Readonly<{
        allowed: true;
        nextState: GroupLifecycleState;
        nextFormationEpoch: number;
    }>
    | GroupPolicyDenied;

/**
 * The transition table, keyed `(stage, command) → stage` (product decision 41)
 * so a command may land differently per source stage and a new stage is a new
 * row, never a refactor. An absent cell is an illegal transition.
 *
 * `start-establishment` and `reopen-establishment` keep today's semantics
 * until their retirement (product decision 34), which also removes
 * `reconfiguring`'s `activate` and `fail-formation` cells — under the new
 * vocabulary that stage holds a layout and `connect` moves it to
 * `reconnecting`. `reset`, `start`, `plan`, `connect` and `reconfigure` are
 * dark: no operation dispatches them yet. `fail-formation` from `reconnecting`
 * returns to `active` because a failed reconnection keeps the accepted layout
 * (product decision 28); exhaustion's `dormant` landing is
 * `resolveFormationFailureLanding`, applied by the criterion owner, never by
 * this table.
 */
const TRANSITION_TABLE: Readonly<
    Record<GroupLifecycleState, Readonly<Partial<Record<GroupLifecycleTransition, GroupLifecycleState>>>>
> = {
    dormant: { reset: 'dormant', start: 'forming' },
    forming: { reset: 'dormant', plan: 'planned', 'start-establishment': 'connecting' },
    planned: { reset: 'dormant', plan: 'planned', connect: 'connecting' },
    connecting: { reset: 'dormant', activate: 'active', 'fail-formation': 'forming' },
    active: { reset: 'dormant', reconfigure: 'reconfiguring', 'reopen-establishment': 'reconfiguring' },
    reconfiguring: {
        reset: 'dormant',
        connect: 'reconnecting',
        activate: 'active',
        'fail-formation': 'forming'
    },
    reconnecting: { reset: 'dormant', activate: 'active', 'fail-formation': 'active' }
};

/**
 * The intent state machine. Every accepted transition advances the formation
 * epoch, and nothing else does — election and readiness pin their member set
 * to the epoch, so an advance on join would flap them (plan correction 4).
 * The one exception is `plan` re-issued from `planned`, whose idempotence
 * (product decision 28) is only real if it re-pins nothing and invalidates no
 * outstanding causal fence. Exhaustion's `dormant` landing for
 * `fail-formation` is `resolveFormationFailureLanding`, applied by the
 * criterion owner over this table's unexhausted landing.
 */
export function computeGroupLifecycleTransition(
    input: Readonly<{
        transition: GroupLifecycleTransition;
        lifecycleState: GroupLifecycleState;
        formationEpoch: number;
    }>
): GroupLifecycleTransitionOutcome {
    const nextState = TRANSITION_TABLE[input.lifecycleState]?.[input.transition];
    if (nextState === undefined) {
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
    const idempotentReplan = input.transition === 'plan' && input.lifecycleState === 'planned';
    return {
        allowed: true,
        nextState,
        nextFormationEpoch: idempotentReplan ? input.formationEpoch : input.formationEpoch + 1
    };
}

/**
 * Where `fail-formation` lands. Spending the attempt budget is terminal for
 * automation and parks the group in `dormant` (product decision 35); an
 * unexhausted failure follows the table — `forming` from `connecting` where no
 * accepted layout exists yet, `active` from `reconnecting` where it does
 * (product decision 28). `undefined` means the stage has no failure landing at
 * all. Dark: the criterion owner does not pass real exhaustion state yet.
 */
export function resolveFormationFailureLanding(
    input: Readonly<{
        lifecycleState: GroupLifecycleState;
        attemptBudgetExhausted: boolean;
    }>
): GroupLifecycleState | undefined {
    const tableLanding = TRANSITION_TABLE[input.lifecycleState]?.['fail-formation'];
    if (tableLanding === undefined) {
        return undefined;
    }
    return input.attemptBudgetExhausted ? 'dormant' : tableLanding;
}
