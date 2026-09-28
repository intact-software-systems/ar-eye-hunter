import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { EXPIRY_TTL_MS, RESPONSE_MARGIN_MS } from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_FALLBACK_CARRIERS } from '../alm-conformance-carriers.ts';
import {
    toAdmissionCommands,
    toObserveCommand,
    toResultAssertion,
    toSendCommand
} from '../alm-conformance-message-commands.ts';
import { toAckHoldFaultCommand } from '../alm-conformance-receipt-commands.ts';
import { toAdmissionOutcomeWait, toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';

/**
 * D56's deadline: the receiver withholds its RTC ACKs and the send lives 7 500 ms, less than the ≈8 000 ms
 * RTC receipt budget. The last `ack-timeout` expires with the message, so no `receipt-exhausted` is ever
 * stated: the handle reads `expired`, and no WS copy reaches the receiver (C7).
 */
export const noFallbackAfterDeadline: AlmConformanceScenarioDefinition = {
    scenarioId: 'no-fallback-after-deadline',
    scenarioKey: 'no-fallback-after-deadline',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_FALLBACK_CARRIERS,
    roles: ['sender', 'receiver'],
    toSenderCommands: toNoFallbackAfterDeadlineSenderCommands,
    toRecipientCommands: toNoFallbackAfterDeadlineReceiverCommands
};

function toNoFallbackAfterDeadlineSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, carrier: sender.input.carrier },
            delivery: { ack: 'receiver', ttlMs: EXPIRY_TTL_MS }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toObserveCommand({ ...sender, index: 1, state: 'expired' }),
        toResultAssertion({
            step: sender,
            name: 'assert-expired-1',
            resultName: 'observe-expired-1',
            field: 'state',
            operator: 'equals',
            expected: 'expired'
        })
    ];
}

/** The RTC copy arrives; no WS copy arrives for the rest of the window, which outlasts the deadline. */
function toNoFallbackAfterDeadlineReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toAckHoldFaultCommand(receiver, 'hold-ack', 'until-cleared'),
        toReceivedCommand({ ...receiver, index: 1, count: 1, absent: false }),
        {
            ...toAdmissionOutcomeWait(receiver, {
                name: 'no-ws-copy',
                contains: '"carrier":"ws"',
                timeoutMs: receiver.input.deadlineMs - RESPONSE_MARGIN_MS
            }),
            absent: true as const
        },
        toAckHoldFaultCommand(receiver, 'release-ack', 0)
    ];
}
