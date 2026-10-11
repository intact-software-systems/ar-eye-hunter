import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import {
    toAdmissionCommands,
    toObserveCommand,
    toSendCommand,
    toStorageCountersCommand
} from '../alm-conformance-message-commands.ts';
import { toReceiptReadCommands } from '../alm-conformance-receipt-commands.ts';
import { toPayloadWait, toSingleArrivalReceiverCommands } from '../alm-conformance-receiver-commands.ts';
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
    laneFamily: 'two-agent',
    toSenderCommands: toDeliveryBaselineSenderCommands,
    toRecipientCommands: toDeliveryBaselineReceiverCommands,
    toReceiptRoles: () => ({ confirmed: ['receiver'], unconfirmed: [] })
};

function toDeliveryBaselineSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId },
            delivery: { ack: 'all-logical-recipients' }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toObserveCommand({ ...sender, index: 1, state: 'acknowledged' }),
        ...toReceiptReadCommands(sender, {
            roles: { confirmed: ['receiver'], unconfirmed: [] },
            ending: 'acknowledged',
            mode: 'receiver'
        }),
        toStorageCountersCommand(sender, 'storage-counters', false)
    ];
}

function toDeliveryBaselineReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toSingleArrivalReceiverCommands(receiver),
        toPayloadWait({
            step: receiver,
            name: 'received-payload',
            payload: { marker: receiver.scenarioId },
            absent: false
        })
    ];
}
