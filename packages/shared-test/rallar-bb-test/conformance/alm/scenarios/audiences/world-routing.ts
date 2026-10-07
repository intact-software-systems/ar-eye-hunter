import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import {
    toAdmissionCommands,
    toObserveCommand,
    toResultAssertion,
    toSendCommand
} from '../../alm-conformance-message-commands.ts';
import { toSelfAbsenceCommand } from '../../alm-conformance-receipt-commands.ts';
import { toReceivedCommand, toSingleArrivalReceiverCommands } from '../../alm-conformance-receiver-commands.ts';
import { ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';

type WorldVerdictFact = readonly [name: string, field: string, expected: string | number | boolean];

/**
 * RTC carries no world audience: the RTC carrier refuses the send at admission, a carrier-unsupported rejection that
 * no carrier attempt follows, so no WS leg carries it either.
 */
const RTC_REFUSAL_FACTS: readonly WorldVerdictFact[] = [
    ['refused', 'failure.kind', 'refused'],
    ['unsupported', 'failure.reason', 'unsupported'],
    ['no-attempt', 'attempts', 0]
];

/** A strategy that allows WS sends a world send there at once: one WS attempt and no hand-over from an RTC leg. */
const WS_ROUTE_FACTS: readonly WorldVerdictFact[] = [
    ['one-attempt', 'attempts', 1],
    ['ws-attempt', 'attemptCarriers.0', 'ws'],
    ['no-fallback', 'carrierFallback', false]
];

/**
 * The sender addresses its authenticated scope on an `app.` topic of its own. Over `ws` the server delivers the send to
 * every other live session of the scope, which in the lane are the room's other two sessions; over `rtc` the carrier
 * refuses it `unsupported` and the handle ends rejected, so nobody receives it; over `rtc-with-ws-fallback` the browser
 * routes it to WS at once. On every carrier the sender's own channel never receives it.
 */
export const worldRouting: AlmConformanceScenarioDefinition = {
    scenarioId: 'world-routing',
    scenarioKey: 'world-routing',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES,
    laneFamily: 'same-principal',
    toSenderCommands: toWorldSenderCommands,
    toRecipientCommands: (recipient) =>
        recipient.input.carrier === 'rtc'
            ? [toReceivedCommand({ ...recipient, index: 1, count: 1, absent: true })]
            : toSingleArrivalReceiverCommands(recipient)
};

function toWorldSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const send = toSendCommand({
        ...sender,
        index: 1,
        payload: { marker: sender.scenarioKey, carrier: sender.input.carrier },
        delivery: { scope: 'world' }
    });
    return [send, ...toWorldVerdictCommands(sender), toSelfAbsenceCommand(sender)];
}

function toWorldVerdictCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    switch (sender.input.carrier) {
        case 'ws':
            return toAdmissionCommands({ ...sender, index: 1 });
        case 'rtc':
            return toVerdictCommands(sender, 'rejected', RTC_REFUSAL_FACTS);
        case 'rtc-with-ws-fallback':
            return toVerdictCommands(sender, 'transport-accepted', WS_ROUTE_FACTS);
    }
}

function toVerdictCommands(
    sender: AlmConformanceStepInput,
    state: 'rejected' | 'transport-accepted',
    facts: readonly WorldVerdictFact[]
): readonly RallarBlackBoxTestCommand[] {
    return [
        toObserveCommand({ ...sender, index: 1, state }),
        ...facts.map(([name, field, expected]) =>
            toResultAssertion({
                step: sender,
                name: `assert-${name}-1`,
                resultName: `observe-${state}-1`,
                field,
                operator: field === 'carrierFallback' ? 'exists' : 'equals',
                expected
            })
        )
    ];
}
