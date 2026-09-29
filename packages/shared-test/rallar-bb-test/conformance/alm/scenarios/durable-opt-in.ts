import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS } from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import {
    toAdmissionCommands,
    toReceiptsCommand,
    toResultAssertion,
    toSendCommand,
    toStorageCountersCommand
} from '../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
import {
    SMOKE_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';

/**
 * The channel that opts in pays for storage on both pages; its reload survival is `delivery-reload`'s,
 * which opts into `local-outbox`.
 */
export const durableOptIn: AlmConformanceScenarioDefinition = {
    scenarioId: 'durable-opt-in',
    scenarioKey: 'durable-opt-in',
    tags: SMOKE_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toDurableOptInSenderCommands,
    toRecipientCommands: toDurableOptInReceiverCommands
};

function toDurableOptInSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toStorageCountersCommand(sender, 'storage-window-open', true),
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId },
            delivery: { durability: 'local-inbox' }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toReceiptsCommand({ ...sender, index: 1 }),
        toStorageCountersCommand(sender, 'storage-window', false),
        toDurableStorageWindowAssertion(sender)
    ];
}

/**
 * The trailing absence window keeps the receiver inside the scenario until its acknowledgement has left.
 * `received-1`'s wait opens at receiver connect and must additionally cover the durable admission commit
 * and drain this `local-inbox` send pays for, so it carries the durable path's own budget (R-S3b-20).
 */
function toDurableOptInReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toStorageCountersCommand(receiver, 'storage-window-open', true),
        toReceivedCommand({
            ...receiver,
            index: 1,
            count: 1,
            absent: false,
            durablePathBudgetMs: NON_EXPIRING_SEND_TIMEOUT_MS
        }),
        toStorageCountersCommand(receiver, 'storage-window', false),
        toDurableStorageWindowAssertion(receiver),
        toReceivedCommand({ ...receiver, index: 2, count: 2, absent: true })
    ];
}

function toDurableStorageWindowAssertion(step: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return toResultAssertion({
        step,
        name: 'assert-storage-window-admission',
        resultName: 'storage-window',
        field: 'byOwner.al-admission',
        operator: 'gt',
        expected: 0
    });
}
