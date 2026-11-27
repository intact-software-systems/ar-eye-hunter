import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { MESSAGE_CONTROL_TIMEOUT_MS, toBudgetMs } from '../alm-conformance-budgets.ts';
import { toRtcDropFaultCommand } from '../alm-conformance-fault-commands.ts';
import { toHandedOverAssertions, toResultAssertion } from '../alm-conformance-message-commands.ts';
import { toAddressedSendCommands } from '../alm-conformance-receipt-commands.ts';
import { toAdmissionOutcomeWait, toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';
import { ALM_CARRIER_MATRIX } from '../carrier-matrix/alm-carrier-matrix.ts';
import { resolveAlmCarrierMatrixCellCarriers } from '../carrier-matrix/resolve-alm-carrier-matrix-cell-carriers.ts';
import { toAlmCarrierOutcomeFacts } from '../carrier-matrix/to-alm-carrier-outcome-facts.ts';

/** The hand-over the addressed send comes to under the fallback strategy, as the matrix states it. */
const HAND_OVER = ALM_CARRIER_MATRIX['peer-unicast-off-overlay-next-hop'].cells['rtc-with-ws-fallback'].outcome;

/**
 * The fallback: the sender drops its own RTC frames of an addressed send, so the third `not-ready` attempt hands the
 * unicast to WS inside its deadline. That no second copy follows a hand-over is `fallback-within-deadline`'s pin on
 * the same fallback controller, so the receiver holds no absence window.
 */
export const unicastFallback: AlmConformanceScenarioDefinition = {
    scenarioId: 'unicast-fallback',
    scenarioKey: 'unicast-fallback',
    tags: FULL_TAGS,
    carriers: resolveAlmCarrierMatrixCellCarriers('unicast-fallback'),
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
        ...toAlmCarrierOutcomeFacts(HAND_OVER).map(([name, field, operator, expected]) =>
            toResultAssertion({
                step: sender,
                name: `assert-${name}-1`,
                resultName: 'observe-acknowledged-1',
                field,
                operator,
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
