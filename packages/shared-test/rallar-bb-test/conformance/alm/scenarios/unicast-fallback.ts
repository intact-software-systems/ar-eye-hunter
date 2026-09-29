import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { MESSAGE_CONTROL_TIMEOUT_MS, toBudgetMs } from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_FALLBACK_CARRIERS } from '../alm-conformance-carriers.ts';
import { toRtcDropFaultCommand } from '../alm-conformance-fault-commands.ts';
import {
    toHandedOverAssertions,
    toResultAssertion
} from '../alm-conformance-message-commands.ts';
import { toAdmissionOutcomeWait, toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';

import { toAddressedSendCommands } from './to-addressed-send-commands.ts';

const HAND_OVER = [['from', 'rtc'], ['to', 'ws'], ['reason', 'not-ready']] as const;

/**
 * The fallback: the sender drops its own RTC frames of an addressed send, so the third `not-ready` attempt hands the
 * unicast to WS inside its deadline. That no second copy follows a hand-over is `fallback-within-deadline`'s pin on
 * the same fallback controller, so the receiver holds no absence window.
 */
export const unicastFallback: AlmConformanceScenarioDefinition = {
    scenarioId: 'unicast-fallback',
    scenarioKey: 'unicast-fallback',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_FALLBACK_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'addressed',
    toSenderCommands: toUnicastFallbackSenderCommands,
    toRecipientCommands: toUnicastFallbackReceiverCommands
};

function toUnicastFallbackSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toRtcDropFaultCommand(sender, 'hold-rtc', 'until-cleared'),
        ...toAddressedSendCommands(sender, 'receiver'),
        ...toHandedOverAssertions(sender, 'observe-acknowledged-1'),
        ...HAND_OVER.map(([field, expected]) =>
            toResultAssertion({
                step: sender,
                name: `assert-fallback-${field}-1`,
                resultName: 'observe-acknowledged-1',
                field: `carrierFallback.${field}`,
                operator: 'equals',
                expected
            })
        ),
        toRtcDropFaultCommand(sender, 'release-rtc', 0)
    ];
}

/** A wait also matches a past event, so the control budget costs nothing once the outcome is buffered. */
function toUnicastFallbackReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toReceivedCommand({ ...receiver, index: 1, count: 1, absent: false }),
        toAdmissionOutcomeWait(receiver, {
            name: 'ws-arrival',
            contains: '"carrier":"ws","outcome":"committed","reason":"admitted"',
            timeoutMs: toBudgetMs(MESSAGE_CONTROL_TIMEOUT_MS, receiver.input.deadlineMs)
        })
    ];
}
