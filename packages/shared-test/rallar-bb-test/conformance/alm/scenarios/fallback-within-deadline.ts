import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import {
    ASSERT_TIMEOUT_MS,
    NON_EXPIRING_SEND_TIMEOUT_MS,
    NON_EXPIRING_TTL_MS,
    toBudgetMs
} from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_FALLBACK_CARRIERS } from '../alm-conformance-carriers.ts';
import { toRtcDropFaultCommand } from '../alm-conformance-fault-commands.ts';
import {
    toAdmissionCommands,
    toHandedOverAssertions,
    toObserveCommand,
    toSendCommand
} from '../alm-conformance-message-commands.ts';
import {
    toAdmissionOutcomeWait,
    toSingleArrivalReceiverCommands
} from '../alm-conformance-receiver-commands.ts';
import {
    SMOKE_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';

/**
 * D56: the sender drops its own RTC frames of the send for the whole scenario, so every RTC attempt settles
 * `not-ready`; the third hands the admitted message to WS inside its 30 s deadline, and the receiver
 * delivers the one copy WS carries.
 */
export const fallbackWithinDeadline: AlmConformanceScenarioDefinition = {
    scenarioId: 'fallback-within-deadline',
    scenarioKey: 'fallback-within-deadline',
    tags: SMOKE_TAGS,
    carriers: ALM_CONFORMANCE_FALLBACK_CARRIERS,
    roles: ['sender', 'receiver'],
    toSenderCommands: toFallbackWithinDeadlineSenderCommands,
    toRecipientCommands: toFallbackWithinDeadlineReceiverCommands
};

function toFallbackWithinDeadlineSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toRtcDropFaultCommand(sender, 'hold-rtc', 'until-cleared'),
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, carrier: sender.input.carrier },
            delivery: {
                ack: 'receiver',
                ttlMs: NON_EXPIRING_TTL_MS,
                commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
            }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toObserveCommand({ ...sender, index: 1, state: 'acknowledged' }),
        ...toHandedOverAssertions(sender, 'observe-acknowledged-1'),
        toRtcDropFaultCommand(sender, 'release-rtc', 0)
    ];
}

/** After the absence window the arrival's own diagnostic is already buffered, so a short budget reads its carrier. */
function toFallbackWithinDeadlineReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toSingleArrivalReceiverCommands(receiver),
        toAdmissionOutcomeWait(receiver, {
            name: 'ws-arrival',
            contains: '"carrier":"ws","outcome":"committed","reason":"admitted"',
            timeoutMs: toBudgetMs(ASSERT_TIMEOUT_MS, receiver.input.deadlineMs)
        })
    ];
}
