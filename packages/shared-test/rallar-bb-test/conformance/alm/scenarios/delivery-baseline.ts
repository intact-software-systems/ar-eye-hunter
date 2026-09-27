import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

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
        toStorageCountersCommand(sender, 'storage-counters', false)
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
