import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { ASSERT_TIMEOUT_MS, toBudgetMs } from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import {
    toAdmissionCommands,
    toReceiptsCommand,
    toSendCommand,
    toStorageCountersCommand
} from '../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
import {
    SMOKE_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';

export const deliveryBaseline: AlmConformanceScenarioDefinition = {
    scenarioId: 'delivery-baseline',
    scenarioKey: 'delivery-baseline',
    tags: SMOKE_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    toSenderCommands: toDeliveryBaselineSenderCommands,
    toRecipientCommands: toDeliveryBaselineReceiverCommands
};

function toDeliveryBaselineSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId },
            delivery: {}
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toReceiptsCommand({ ...sender, index: 1 }),
        toStorageCountersCommand(sender, 'storage-counters'),
        toStorageCountersAssertCommand(sender)
    ];
}

function toDeliveryBaselineReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [toReceivedCommand({
        ...receiver,
        index: 1,
        count: 1,
        absent: false
    })];
}

/** The spec's own acceptance criterion: an admitted ALM send leaves AL-owned IndexedDB work behind. */
function toStorageCountersAssertCommand(step: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return {
        kind: 'assert',
        commandId: toCommandId(step, 'assert-storage-counters-total'),
        source: `resultCache.${toCommandId(step, 'storage-counters')}.value.total`,
        operator: 'gt',
        expected: 0,
        timeoutMs: toBudgetMs(ASSERT_TIMEOUT_MS, step.input.deadlineMs)
    };
}
