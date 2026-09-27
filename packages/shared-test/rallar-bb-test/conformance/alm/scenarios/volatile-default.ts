import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import {
    toObserveCommand,
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
 * D2 and D55: a send with no options is receipted and leaves nothing in IndexedDB on either page. The
 * window opens with a reset; the durable owners' idle probes (`work-page`, `work-probe`) are reported
 * beside the zero, never inside it (I2 owns a literal zero). The zero holds while the memory lanes hold
 * the message's surface: a late or unresolved control would still cost one IndexedDB read.
 */
export const volatileDefault: AlmConformanceScenarioDefinition = {
    scenarioId: 'volatile-default',
    scenarioKey: 'volatile-default',
    tags: SMOKE_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    toSenderCommands: toVolatileDefaultSenderCommands,
    toRecipientCommands: toVolatileDefaultReceiverCommands
};

function toVolatileDefaultSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toStorageCountersCommand(sender, 'storage-window-open', true),
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId },
            delivery: {}
        }),
        toObserveCommand({ ...sender, index: 1, state: 'acknowledged' }),
        toResultAssertion({
            step: sender,
            name: 'assert-acknowledged-1',
            resultName: 'observe-acknowledged-1',
            field: 'state',
            operator: 'equals',
            expected: 'acknowledged'
        }),
        toStorageCountersCommand(sender, 'storage-window', false),
        ...toVolatileStorageWindowAssertions(sender)
    ];
}

/**
 * A reset after the arrival could only under-count; the sender's own window is the one that cannot. The
 * trailing absence window keeps the receiver inside the scenario until its acknowledgement has left.
 */
function toVolatileDefaultReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toStorageCountersCommand(receiver, 'storage-window-open', true),
        toReceivedCommand({ ...receiver, index: 1, count: 1, absent: false }),
        toStorageCountersCommand(receiver, 'storage-window', false),
        ...toVolatileStorageWindowAssertions(receiver),
        toReceivedCommand({ ...receiver, index: 2, count: 2, absent: true })
    ];
}

function toVolatileStorageWindowAssertions(
    step: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toResultAssertion({
            step,
            name: 'assert-storage-window-admission',
            resultName: 'storage-window',
            field: 'byOwner.al-admission',
            operator: 'equals',
            expected: 0
        }),
        toResultAssertion({
            step,
            name: 'assert-storage-window-non-probe-work',
            resultName: 'storage-window',
            field: 'workNonProbeCount',
            operator: 'equals',
            expected: 0
        })
    ];
}
