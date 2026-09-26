import { AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';

import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import {
    EXPIRY_TTL_MS,
    MESSAGE_CONTROL_TIMEOUT_MS,
    MINIMUM_POST_EXPIRY_OBSERVATION_MS,
    NON_EXPIRING_SEND_TIMEOUT_MS,
    NON_EXPIRING_TTL_MS,
    RESPONSE_MARGIN_MS,
    toBudgetMs
} from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import { toCommittedControlAdmissionWait, toResultAssertion } from '../alm-conformance-message-commands.ts';
import {
    toAckHoldFaultCommand,
    toAudiencePayload,
    toAudienceSendCommands,
    toReceiptWindowCommands,
    type AlmConformanceReceiptRoles
} from '../alm-conformance-receipt-commands.ts';
import {
    toAdmissionOutcomeWait,
    toControlAdmissionOutcomeWait,
    toPayloadWait,
    toReceivedCommand,
    toSingleArrivalReceiverCommands
} from '../alm-conformance-receiver-commands.ts';
import type { AlmConformanceRole } from '../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';
import { toConnectCommand } from '../alm-conformance-session-commands.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';

export const RECEIPTED_AUDIENCE_ROLES: readonly AlmConformanceRole[] = ['sender', 'receiver', 'recipient-b'];

const RTC_CARRIERS: readonly AlmConformanceCarrier[] = ALM_CONFORMANCE_CARRIERS.filter((carrier) => carrier !== 'ws');
const RETIRED_ACK_TYPE_ID = 'al.control.ack.v1';

const BOTH_CONFIRMED: AlmConformanceReceiptRoles = { confirmed: ['receiver', 'recipient-b'], unconfirmed: [] };
const RECIPIENT_B_UNCONFIRMED: AlmConformanceReceiptRoles = { confirmed: ['receiver'], unconfirmed: ['recipient-b'] };

/** Both recipients confirm the one send, and the origin reads that from its own receipt. */
const aggregatedReceipt: AlmConformanceScenarioDefinition = {
    scenarioId: 'receipted-audience',
    scenarioKey: 'aggregated-receipt',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: RECEIPTED_AUDIENCE_ROLES,
    toReceiptRoles: () => BOTH_CONFIRMED,
    toSenderCommands: (sender) => [
        ...toAudienceSendCommands({ sender, ttlMs: NON_EXPIRING_TTL_MS }),
        ...toServerReceiptCommands(sender),
        ...toReceiptWindowCommands(sender, BOTH_CONFIRMED, 'acknowledged')
    ],
    toRecipientCommands: toSingleArrivalReceiverCommands
};

/**
 * `recipient-b` holds its ACK back until the copy that repairs it arrives. Over RTC the origin retries only the hop
 * that is still incomplete (R-S2c-ii-3), so the retried copy reaches `recipient-b` and never the receiver, and the
 * receipt completes after it. Over ws the room topic fans out live-only and the WS server keeps no copy to retry, so
 * the receipt of the short-lived send ends timed out with `recipient-b` unconfirmed.
 */
const missingRecipientRetry: AlmConformanceScenarioDefinition = {
    scenarioId: 'receipted-audience',
    scenarioKey: 'missing-recipient-retry',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: RECEIPTED_AUDIENCE_ROLES,
    toReceiptRoles: toRetryReceiptRoles,
    toSenderCommands: (sender) => [
        ...toAudienceSendCommands({
            sender,
            ttlMs: sender.input.carrier === 'ws' ? EXPIRY_TTL_MS : NON_EXPIRING_TTL_MS
        }),
        ...toReceiptWindowCommands(
            sender,
            toRetryReceiptRoles(sender.input.carrier),
            sender.input.carrier === 'ws' ? 'expired' : 'acknowledged'
        )
    ],
    toRecipientCommands: toRetryRecipientCommands
};

/**
 * `recipient-b` holds its ACK back and leaves once the send reached it, which proves the send was admitted first. The
 * frozen audience keeps the session that left expected and reports it unconfirmed (D43). The send expires inside the
 * window, so over ws the timed-out receipt of the WS server has reached the origin before it reads.
 */
const frozenAudienceMembership: AlmConformanceScenarioDefinition = {
    scenarioId: 'receipted-audience',
    scenarioKey: 'frozen-audience-membership',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: RECEIPTED_AUDIENCE_ROLES,
    toReceiptRoles: () => RECIPIENT_B_UNCONFIRMED,
    toSenderCommands: (sender) => [
        ...toAudienceSendCommands({ sender, ttlMs: EXPIRY_TTL_MS }),
        ...toReceiptWindowCommands(sender, RECIPIENT_B_UNCONFIRMED, 'expired')
    ],
    toRecipientCommands: toMembershipRecipientCommands
};

/**
 * `recipient-b` answers the send with a raw ACK envelope of the retired version `al.control.ack.v1`, over the rtc leg
 * both RTC carriers admit the send on. The origin refuses it `unsupported` at its own inbound admission, and the real
 * ACK of `recipient-b` still completes the receipt. Over ws the WS server refuses the frame before any relay, so the
 * origin never sees it; that refusal stays a unit pin of the server.
 */
const unknownAckVersion: AlmConformanceScenarioDefinition = {
    scenarioId: 'receipted-audience',
    scenarioKey: 'unknown-ack-version',
    tags: FULL_TAGS,
    carriers: RTC_CARRIERS,
    roles: RECEIPTED_AUDIENCE_ROLES,
    toReceiptRoles: () => BOTH_CONFIRMED,
    toSenderCommands: (sender) => [
        ...toAudienceSendCommands({ sender, ttlMs: NON_EXPIRING_TTL_MS }),
        toControlAdmissionOutcomeWait(sender, {
            name: 'unknown-ack-version-refused',
            controlMsgId: toRetiredAckMsgId(sender, `{resultCache.${toCommandId(sender, 'send-1')}.value.msgId}`),
            controlTypeId: RETIRED_ACK_TYPE_ID,
            contains: '"carrier":"rtc","outcome":"rejected","reason":"unsupported"',
            timeoutMs: sender.input.deadlineMs + NON_EXPIRING_SEND_TIMEOUT_MS - RESPONSE_MARGIN_MS
        }),
        ...toReceiptWindowCommands(sender, BOTH_CONFIRMED, 'acknowledged')
    ],
    toRecipientCommands: toUnknownAckVersionRecipientCommands
};

export const receiptedAudience: readonly AlmConformanceScenarioDefinition[] = [
    aggregatedReceipt,
    missingRecipientRetry,
    unknownAckVersion,
    frozenAudienceMembership
];

/**
 * Authored, so the refusal the origin states names this control and no raw ACK of another carrier, and suffixed with
 * the msgId of the send it answers, so a re-run on a page whose store survived is admitted again, never a duplicate.
 */
function toRetiredAckMsgId(step: AlmConformanceStepInput, ackedMsgId: string): string {
    return `alm-${step.input.carrier}-${step.scenarioKey}-retired-ack-${ackedMsgId}`;
}

function toRetryReceiptRoles(carrier: AlmConformanceCarrier): AlmConformanceReceiptRoles {
    return carrier === 'ws' ? RECIPIENT_B_UNCONFIRMED : BOTH_CONFIRMED;
}

/**
 * Over ws the receipt is a control of the trusted server, so the origin states its own admission of it. The wait
 * matches the first receipt frame committed for the send, the `admitted` one; the frame carries no phase in its
 * diagnostic, so completion is proven by the receipt read after the window, which must read `acknowledged`.
 */
function toServerReceiptCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return sender.input.carrier !== 'ws' ? [] : [
        toCommittedControlAdmissionWait({
            step: { ...sender, index: 1 },
            name: 'receipt-admitted-1',
            controlTypeId: AL_CONTROL_RECEIPT_TYPE_ID
        })
    ];
}

/**
 * A repaired copy arrives at `recipient-b` as a duplicate, and at no other recipient: that is the retry target set.
 * `recipient-b` releases its ACK only once the retried copy has arrived, or over ws once the window proved none will.
 */
function toRetryRecipientCommands(recipient: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const carrier = recipient.input.carrier;
    const retried = toAdmissionOutcomeWait(recipient, {
        name: 'retried-copy',
        contains: `"carrier":"${carrier === 'ws' ? 'ws' : 'rtc'}","outcome":"not-handled","reason":"duplicate"`,
        timeoutMs: recipient.input.deadlineMs + NON_EXPIRING_SEND_TIMEOUT_MS - RESPONSE_MARGIN_MS
    });
    const noRetriedCopy = {
        ...retried,
        commandId: toCommandId(recipient, 'no-retried-copy'),
        absent: true as const,
        timeoutMs: recipient.input.deadlineMs - RESPONSE_MARGIN_MS
    };
    const received = toReceivedCommand({ ...recipient, index: 1, count: 1, absent: false });
    if (recipient.role !== 'recipient-b') {
        return [received, noRetriedCopy];
    }
    return [
        toAckHoldFaultCommand(recipient, 'hold-ack', 'until-cleared'),
        received,
        carrier === 'ws' ? noRetriedCopy : retried,
        toAckHoldFaultCommand(recipient, 'release-ack', 0)
    ];
}

/**
 * Closing the connection clears every fault the page holds. `recipient-b` reconnects only after the send has expired,
 * so an ACK it still owes then reaches the origin past the deadline and is refused; the reconnect keeps the page
 * usable for the scenarios after it.
 */
function toMembershipRecipientCommands(recipient: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const received = toReceivedCommand({ ...recipient, index: 1, count: 1, absent: false });
    if (recipient.role !== 'recipient-b') {
        return [received];
    }
    const pastExpiryMs = EXPIRY_TTL_MS + MINIMUM_POST_EXPIRY_OBSERVATION_MS;
    return [
        toAckHoldFaultCommand(recipient, 'hold-ack', 'until-cleared'),
        received,
        { kind: 'close', commandId: toCommandId(recipient, 'leave') },
        {
            ...toReceivedCommand({ ...recipient, index: 2, count: 2, absent: true }),
            windowMs: pastExpiryMs,
            timeoutMs: pastExpiryMs + RESPONSE_MARGIN_MS
        },
        { ...toConnectCommand(recipient), commandId: toCommandId(recipient, 'rejoin') }
    ];
}

/** The received message event names the send and its origin, which the raw ACK of `recipient-b` answers. */
function toUnknownAckVersionRecipientCommands(
    recipient: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    if (recipient.role !== 'recipient-b') {
        return toSingleArrivalReceiverCommands(recipient);
    }
    const arrival = toPayloadWait({
        step: recipient,
        name: 'received-send-1',
        payload: toAudiencePayload(recipient),
        absent: false
    });
    const event = `resultCache.${arrival.commandId}.value.event.payload`;
    const control = 'unknown-ack-version-1';
    return [
        arrival,
        {
            kind: 'messages.control',
            commandId: toCommandId(recipient, control),
            connection: recipient.input.receiverConnection,
            carrier: 'rtc',
            typeId: RETIRED_ACK_TYPE_ID,
            msgId: toRetiredAckMsgId(recipient, `{${event}.data.msgId}`),
            ackedMsgId: `{${event}.data.msgId}`,
            toPeerId: `{${event}.senderId}`,
            timeoutMs: toBudgetMs(MESSAGE_CONTROL_TIMEOUT_MS, recipient.input.deadlineMs)
        },
        toResultAssertion({
            step: recipient,
            name: 'assert-control-admitted-1',
            resultName: control,
            field: 'verdict',
            operator: 'equals',
            expected: 'admitted'
        })
    ];
}
