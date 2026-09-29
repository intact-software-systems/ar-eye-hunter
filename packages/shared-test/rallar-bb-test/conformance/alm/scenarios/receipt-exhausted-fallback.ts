import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import {
    ASSERT_TIMEOUT_MS,
    MESSAGE_CONTROL_TIMEOUT_MS,
    NON_EXPIRING_SEND_TIMEOUT_MS,
    NON_EXPIRING_TTL_MS,
    toBudgetMs
} from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_FALLBACK_CARRIERS } from '../alm-conformance-carriers.ts';
import {
    toAdmissionCommands,
    toHandedOverAssertions,
    toObserveCommand,
    toSendCommand
} from '../alm-conformance-message-commands.ts';
import { toAckHoldFaultCommand } from '../alm-conformance-receipt-commands.ts';
import {
    toAdmissionOutcomeWait,
    toSingleArrivalReceiverCommands
} from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';

/**
 * The RTC receipt budget alone runs ≈8 s from admission (a 2 000 ms ACK timeout, then three retries); the WS
 * copy and its server receipt follow it, so the acknowledged wait outlasts the state's own 10 s budget.
 */
const RECEIPT_EXHAUSTION_OBSERVE_MS = NON_EXPIRING_SEND_TIMEOUT_MS + MESSAGE_CONTROL_TIMEOUT_MS;

/**
 * D56 and Q6: the receiver withholds its RTC ACKs, so the RTC receipt runs out of retries. That
 * `receipt-exhausted` hands the message to WS instead of failing it; the receiver refuses the WS copy as a
 * duplicate and, since its first admission was on RTC, sends its own ACK again over WS (R-S3b-1), and the
 * handle reads `acknowledged`.
 */
export const receiptExhaustedFallback: AlmConformanceScenarioDefinition = {
    scenarioId: 'receipt-exhausted-fallback',
    scenarioKey: 'receipt-exhausted-fallback',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_FALLBACK_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toReceiptExhaustedFallbackSenderCommands,
    toRecipientCommands: toReceiptExhaustedFallbackReceiverCommands
};

function toReceiptExhaustedFallbackSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
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
        toObserveCommand({
            ...sender,
            index: 1,
            state: 'acknowledged',
            budgetMs: RECEIPT_EXHAUSTION_OBSERVE_MS
        }),
        ...toHandedOverAssertions(sender, 'observe-acknowledged-1')
    ];
}

/** The duplicate's outcome is buffered by the end of the absence window; the hold is released last. */
function toReceiptExhaustedFallbackReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toAckHoldFaultCommand(receiver, 'hold-ack', 'until-cleared'),
        ...toSingleArrivalReceiverCommands(receiver),
        toAdmissionOutcomeWait(receiver, {
            name: 'ws-duplicate',
            contains: '"carrier":"ws","outcome":"not-handled","reason":"duplicate"',
            timeoutMs: toBudgetMs(ASSERT_TIMEOUT_MS, receiver.input.deadlineMs)
        }),
        toAckHoldFaultCommand(receiver, 'release-ack', 0)
    ];
}
