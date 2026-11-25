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

/**
 * Only rtc-then-ws runs: the product admits one message on WS after RTC by hand-over (D56), and never on RTC while its
 * WS admission lives, since a ws-then-rtc send falls back only when WS refuses it. Its scenario key keeps the order.
 */
export const crossCarrierDuplicate: readonly AlmConformanceScenarioDefinition[] = [{
    scenarioId: 'cross-carrier-duplicate',
    scenarioKey: 'cross-carrier-duplicate-rtc-then-ws',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_FALLBACK_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toCrossCarrierDuplicateSenderCommands,
    toRecipientCommands: toCrossCarrierDuplicateReceiverCommands
}];

/**
 * One envelope over both carriers, which the product carries only by hand-over (D56); this replay forces it without a
 * trigger: it reuses the first RTC handle's captured envelope on WS.
 * The replay reads that envelope back from IndexedDB, so the first send opts into `local-outbox`.
 * The sender proves its first copy was submitted and the replay admitted, never the replayed handle's
 * acknowledgement (D28). The receiver's count proves the second copy was not delivered twice, and its
 * duplicate-outcome wait proves the second copy arrived and was refused.
 */
function toCrossCarrierDuplicateSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const firstSend = toSendCommand({
        ...sender,
        index: 1,
        payload: { marker: sender.scenarioId, order: 'rtc-then-ws' },
        delivery: {
            ack: 'receiver',
            durability: 'local-outbox',
            ttlMs: NON_EXPIRING_TTL_MS,
            commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
        }
    });
    return [
        { ...firstSend, carrier: 'rtc' },
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
            replayOnCarrier: { handleId: toSendHandleId({ ...sender, index: 1 }), carrier: 'ws' },
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
 * The receiver refused the pair's second copy, on either carrier: neither carrier's `transport-accepted` is the
 * receiver's admission (over RTC it is the frame leaving the sender's data channel, over WS the server's), so the WS
 * replay may commit before the RTC copy. The wait matches the refusal by its fields, so it holds whichever copy came
 * second, and keeps its budget for a copy whose commit conflicted and is refused only on replay. It runs after the
 * absence window, when the outcome is already in the event buffer, so a short budget suffices.
 */
function toCrossCarrierDuplicateReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toSingleArrivalReceiverCommands(receiver),
        toAdmissionOutcomeWait(receiver, {
            name: 'duplicate-outcome',
            fields: { outcome: 'not-handled', reason: 'duplicate' },
            timeoutMs: toBudgetMs(ASSERT_TIMEOUT_MS, receiver.input.deadlineMs)
        })
    ];
}
