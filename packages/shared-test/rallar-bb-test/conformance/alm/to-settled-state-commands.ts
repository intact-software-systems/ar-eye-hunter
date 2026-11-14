import type { ALDeliveryState } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import type { RallarBlackBoxTestCommand } from '../../rallar-black-box-test-contracts.ts';

import { toObserveCommand, toResultAssertion } from './alm-conformance-message-commands.ts';
import type { AlmConformanceMessageStepInput } from './alm-conformance-scenario-definition.ts';

/**
 * The send of `step.index` settled in exactly `state`, which its observation must name; with no `budgetMs`, the state's
 * own observe budget.
 */
export function toSettledStateCommands(
    step: AlmConformanceMessageStepInput,
    state: ALDeliveryState,
    budgetMs?: number
): readonly RallarBlackBoxTestCommand[] {
    return [
        toObserveCommand({ ...step, state, ...(budgetMs === undefined ? {} : { budgetMs }) }),
        toResultAssertion({
            step,
            name: `assert-${state}-${step.index}`,
            resultName: `observe-${state}-${step.index}`,
            field: 'state',
            operator: 'equals',
            expected: state
        })
    ];
}
