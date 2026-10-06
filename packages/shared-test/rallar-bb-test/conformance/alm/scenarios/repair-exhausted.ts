import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS } from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import { toObserveCommand, toResultAssertion } from '../alm-conformance-message-commands.ts';
import { toHeldSecondSendCommands, toOrderedSendCommands } from '../alm-conformance-ordering-commands.ts';
import { toSingleArrivalReceiverCommands } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';

/**
 * A repair budget that runs out ends on the handle: the sender's second frame stays held through every
 * retransmission, the gap is reported again by a fourth send, and once the retransmits reach the message's
 * `maxRepairs` the sender settles it `skipped` with reason `repair-exhausted`. The receiver delivered the first send
 * only: the third and fourth wait for a second that never arrives.
 */
export const repairExhausted: AlmConformanceScenarioDefinition = {
    scenarioId: 'repair-exhausted',
    scenarioKey: 'repair-exhausted',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toRepairExhaustedSenderCommands,
    toRecipientCommands: toSingleArrivalReceiverCommands
};

/**
 * The fourth send reports the gap once more, so the budget of one retransmit is spent however many repair
 * requests one arrival raises. The hold is never released: a late second frame would reach the receiver inside
 * its absence window.
 */
function toRepairExhaustedSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    const observation = 'observe-failed-2';
    return [
        ...toHeldSecondSendCommands(sender),
        ...toOrderedSendCommands(sender, 4),
        toObserveCommand({ ...sender, index: 2, state: 'failed', budgetMs: NON_EXPIRING_SEND_TIMEOUT_MS }),
        toResultAssertion({
            step: sender,
            name: 'assert-skipped-2',
            resultName: observation,
            field: 'failure.kind',
            operator: 'equals',
            expected: 'skipped'
        }),
        toResultAssertion({
            step: sender,
            name: 'assert-repair-exhausted-2',
            resultName: observation,
            field: 'failure.reason',
            operator: 'equals',
            expected: 'repair-exhausted'
        })
    ];
}
