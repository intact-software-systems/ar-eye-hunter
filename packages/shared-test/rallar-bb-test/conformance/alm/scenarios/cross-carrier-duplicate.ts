import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import {
    ASSERT_TIMEOUT_MS,
    MESSAGE_CONTROL_TIMEOUT_MS,
    NON_EXPIRING_SEND_TIMEOUT_MS,
    NON_EXPIRING_TTL_MS,
    toBudgetMs
} from '../alm-conformance-budgets.ts';
import type { AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import {
    toObserveCommand,
    toReceiptsCommand,
    toResultAssertion,
    toSendCommand
} from '../alm-conformance-message-commands.ts';
import { toAdmissionOutcomeWait, toSingleArrivalReceiverCommands } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';
import { toCommandId, toSendHandleId } from '../alm-conformance-step-identities.ts';

/** The only cell that connects both transports, so one envelope can reach the receiver over each. */
const FALLBACK_CARRIERS: readonly AlmConformanceCarrier[] = ['rtc-with-ws-fallback'];
const CROSS_CARRIER_ORDERS = ['rtc-then-ws', 'ws-then-rtc'] as const;

export const crossCarrierDuplicate: readonly AlmConformanceScenarioDefinition[] = CROSS_CARRIER_ORDERS.map((order) => ({
    scenarioId: 'cross-carrier-duplicate' as const,
    scenarioKey: `cross-carrier-duplicate-${order}`,
    tags: FULL_TAGS,
    carriers: FALLBACK_CARRIERS,
    roles: ['sender', 'receiver'],
    toSenderCommands: (sender: AlmConformanceStepInput) => toCrossCarrierDuplicateSenderCommands(sender, order),
    toRecipientCommands: (receiver: AlmConformanceStepInput) => toCrossCarrierDuplicateReceiverCommands(receiver, order)
}));

/**
 * One envelope over both carriers, which the product never does (it falls back only after an
 * `unroutable` verdict): the replay reuses the first handle's captured envelope on the other carrier.
 * The sender proves its first copy was submitted and the replay admitted, never the replayed handle's
 * acknowledgement (D28). The receiver's count proves the second copy was not delivered twice, and its
 * duplicate-outcome wait proves the second copy arrived and was refused, in both orders.
 */
function toCrossCarrierDuplicateSenderCommands(
    sender: AlmConformanceStepInput,
    order: (typeof CROSS_CARRIER_ORDERS)[number]
): readonly RallarBlackBoxTestCommand[] {
    const [first, replay] = order === 'rtc-then-ws' ? (['rtc', 'ws'] as const) : (['ws', 'rtc'] as const);
    const firstSend = toSendCommand({
        ...sender,
        index: 1,
        payload: { marker: sender.scenarioId, order },
        delivery: { ack: 'receiver', ttlMs: NON_EXPIRING_TTL_MS, commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS }
    });
    return [
        { ...firstSend, carrier: first },
        toObserveCommand({ ...sender, index: 1, state: 'transport-accepted' }),
        ...(['state', 'submitted'] as const).map((field) =>
            toResultAssertion({
                step: sender,
                name: `assert-${field}-1`,
                resultName: 'observe-transport-accepted-1',
                field,
                operator: field === 'state' ? 'matches' : 'equals',
                expected: field === 'state' ? '^(transport-accepted|acknowledged)$' : true
            })
        ),
        {
            kind: 'messages.send',
            commandId: toCommandId(sender, 'send-2'),
            connection: sender.input.senderConnection,
            replayOnCarrier: { handleId: toSendHandleId({ ...sender, index: 1 }), carrier: replay },
            timeoutMs: toBudgetMs(MESSAGE_CONTROL_TIMEOUT_MS, sender.input.deadlineMs)
        },
        toResultAssertion({
            step: sender,
            name: 'assert-replay-admitted-2',
            resultName: 'send-2',
            field: 'verdict',
            operator: 'equals',
            expected: 'admitted'
        }),
        toReceiptsCommand({ ...sender, index: 1 })
    ];
}

/**
 * The receiver refused the pair's second copy. rtc-then-ws pins that copy to WS: RTC `transport-accepted` is the
 * receiver's own hop ACK, so the RTC copy committed first. ws-then-rtc accepts either carrier, since WS
 * `transport-accepted` is only the server's: it reads the pair's latest `admission-outcome`, which is the second
 * arrival's. Both run after the absence window, when the outcome is already in the event buffer, so a short budget
 * suffices. A receiver stays one linear transcript for the reload identity join, so the either-carrier case is a wait
 * and two assertions rather than a composite.
 */
function toCrossCarrierDuplicateReceiverCommands(
    receiver: AlmConformanceStepInput,
    order: (typeof CROSS_CARRIER_ORDERS)[number]
): readonly RallarBlackBoxTestCommand[] {
    const arrivals = toSingleArrivalReceiverCommands(receiver);
    if (order === 'rtc-then-ws') {
        return [
            ...arrivals,
            toAdmissionOutcomeWait(receiver, {
                name: 'duplicate-outcome-ws',
                contains: '"carrier":"ws","outcome":"not-handled","reason":"duplicate"',
                timeoutMs: toBudgetMs(ASSERT_TIMEOUT_MS, receiver.input.deadlineMs)
            })
        ];
    }
    const latest = toAdmissionOutcomeWait(receiver, {
        name: 'duplicate-outcome-latest',
        contains: '"carrier":"',
        timeoutMs: toBudgetMs(ASSERT_TIMEOUT_MS, receiver.input.deadlineMs)
    });
    return [
        ...arrivals,
        latest,
        ...([['outcome', 'not-handled'], ['reason', 'duplicate']] as const).map(([field, expected]) =>
            toResultAssertion({
                step: receiver,
                name: `assert-duplicate-outcome-${field}`,
                resultName: 'duplicate-outcome-latest',
                field: `event.payload.data.${field}`,
                operator: 'equals',
                expected
            })
        )
    ];
}
