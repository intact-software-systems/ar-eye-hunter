import { AL_CONTROL_ACK_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../rallar-black-box-test-contracts.ts';

import {
    EXPIRY_TTL_MS,
    MESSAGE_CONTROL_TIMEOUT_MS,
    MINIMUM_POST_EXPIRY_OBSERVATION_MS,
    NON_EXPIRING_SEND_TIMEOUT_MS,
    NON_EXPIRING_TTL_MS,
    RESPONSE_MARGIN_MS,
    toBudgetMs
} from '../alm-conformance-budgets.ts';
import {
    ALM_CONFORMANCE_CARRIERS,
    ALM_CONFORMANCE_RTC_ALONE_CARRIERS,
    ALM_CONFORMANCE_RTC_CARRIERS,
    type AlmConformanceCarrier
} from '../alm-conformance-carriers.ts';
import { toControlProofRefusalWait, toSentMsgIdReference } from '../alm-conformance-diagnostic-waits.ts';
import { toReceiptsCommand, toResultAssertion } from '../alm-conformance-message-commands.ts';
import {
    toAckHoldFaultCommand,
    toAudiencePayload,
    toAudienceSendCommands,
    toReceiptWindowCommands,
    toServerReceiptCommands,
    type AlmConformanceReceiptRoles
} from '../alm-conformance-receipt-commands.ts';
import {
    toAdmissionOutcomeWait,
    toControlAdmissionOutcomeWait,
    toPayloadWait,
    toReceivedCommand,
    toSingleArrivalReceiverCommands
} from '../alm-conformance-receiver-commands.ts';
import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';
import { toConnectCommand } from '../alm-conformance-session-commands.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';
import { toAlmCellCommandPrefix } from '../cell/to-alm-cell-command-prefix.ts';
import {
    toCueListenCommands,
    toCueSendCommands,
    toCueWait
} from './topic-subscription/topic-subscription-publications.ts';

const RETIRED_ACK_TYPE_ID = 'al.control.ack.v2';
/** The name of the arrival wait a raw ACK answers. */
const ARRIVAL = 'received-send-1';

/** A raw ACK `recipient-b` sends: its command's name, its type and the label its authored msgId carries. */
interface RawAckAnswer {
    readonly name: string;
    readonly typeId: string;
    readonly label: string;
}

interface RawAckControlInput extends RawAckAnswer {
    /** The commandId of the arrival wait whose received message event the control answers. */
    readonly arrival: string;
    readonly logicalRecipientPeerId?: string;
}

export const BOTH_CONFIRMED: AlmConformanceReceiptRoles = {
    confirmed: ['receiver', 'recipient-b'],
    unconfirmed: [],
    outsideAudience: []
};
const RECIPIENT_B_UNCONFIRMED: AlmConformanceReceiptRoles = {
    confirmed: ['receiver'],
    unconfirmed: ['recipient-b'],
    outsideAudience: []
};

/** Both recipients confirm the one send, and the origin reads that from its own receipt. */
const aggregatedReceipt: AlmConformanceScenarioDefinition = {
    scenarioId: 'receipted-audience',
    scenarioKey: 'aggregated-receipt',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    toReceiptRoles: () => BOTH_CONFIRMED,
    toSenderCommands: (sender) => [
        ...toAudienceSendCommands({ sender, ttlMs: NON_EXPIRING_TTL_MS, ack: 'all-logical-recipients' }),
        ...toServerReceiptCommands(sender),
        ...toReceiptWindowCommands(sender, { roles: BOTH_CONFIRMED, ending: 'acknowledged', mode: 'receiver' })
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
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    toReceiptRoles: toRetryReceiptRoles,
    toSenderCommands: (sender) => [
        ...toAudienceSendCommands({
            sender,
            ttlMs: sender.input.carrier === 'ws' ? EXPIRY_TTL_MS : NON_EXPIRING_TTL_MS,
            ack: 'all-logical-recipients'
        }),
        ...toReceiptWindowCommands(sender, {
            roles: toRetryReceiptRoles(sender.input.carrier),
            ending: sender.input.carrier === 'ws' ? 'expired' : 'acknowledged',
            mode: 'receiver'
        })
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
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    toReceiptRoles: () => RECIPIENT_B_UNCONFIRMED,
    toSenderCommands: (sender) => [
        ...toAudienceSendCommands({ sender, ttlMs: EXPIRY_TTL_MS, ack: 'all-logical-recipients' }),
        ...toReceiptWindowCommands(sender, { roles: RECIPIENT_B_UNCONFIRMED, ending: 'expired', mode: 'receiver' })
    ],
    toRecipientCommands: toMembershipRecipientCommands
};

/**
 * `recipient-b` answers the send with a raw ACK envelope of the retired version `al.control.ack.v2`, over the rtc leg
 * both RTC carriers admit the send on. The origin refuses it `unsupported` at its own inbound admission, and the real
 * ACK of `recipient-b` still completes the receipt. Over ws the WS server refuses the frame before any relay, so the
 * origin never sees it; that refusal stays a unit pin of the server.
 */
const unknownAckVersion: AlmConformanceScenarioDefinition = {
    scenarioId: 'receipted-audience',
    scenarioKey: 'unknown-ack-version',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_RTC_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    toReceiptRoles: () => BOTH_CONFIRMED,
    toSenderCommands: (sender) => [
        ...toAudienceSendCommands({ sender, ttlMs: NON_EXPIRING_TTL_MS, ack: 'all-logical-recipients' }),
        toControlAdmissionOutcomeWait(sender, {
            name: 'unknown-ack-version-refused',
            controlMsgId: toRawAckMsgId(
                sender,
                'retired-ack',
                `{resultCache.${toCommandId(sender, 'send-1')}.value.msgId}`
            ),
            controlTypeId: RETIRED_ACK_TYPE_ID,
            contains: '"carrier":"rtc","outcome":"rejected","reason":"unsupported"',
            timeoutMs: sender.input.deadlineMs + NON_EXPIRING_SEND_TIMEOUT_MS - RESPONSE_MARGIN_MS
        }),
        ...toReceiptWindowCommands(sender, { roles: BOTH_CONFIRMED, ending: 'acknowledged', mode: 'receiver' })
    ],
    toRecipientCommands: toUnknownAckVersionRecipientCommands
};

/**
 * `recipient-b` answers the send with a raw `al.control.ack.v3` that carries no proof, over the rtc leg both RTC
 * carriers admit the send on. The origin refuses its proof `missing-proof`, and the signed ACK the page sends of its
 * own still completes the receipt, whichever of the two reaches the origin first.
 */
export const unsignedAckRefused: AlmConformanceScenarioDefinition = {
    scenarioId: 'receipted-audience',
    scenarioKey: 'unsigned-ack-refused',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_RTC_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    toReceiptRoles: () => BOTH_CONFIRMED,
    toSenderCommands: (sender) => [
        ...toAudienceSendCommands({ sender, ttlMs: NON_EXPIRING_TTL_MS, ack: 'all-logical-recipients' }),
        toControlProofRefusalWait({
            step: { ...sender, index: 1 },
            name: 'unsigned-ack-refused',
            controlMsgId: toRawAckMsgId(sender, 'unsigned-ack', toSentMsgIdReference({ ...sender, index: 1 })),
            controlTypeId: AL_CONTROL_ACK_TYPE_ID,
            proofRefusal: 'missing-proof'
        }),
        ...toReceiptWindowCommands(sender, { roles: BOTH_CONFIRMED, ending: 'acknowledged', mode: 'receiver' })
    ],
    toRecipientCommands: toUnsignedAckRecipientCommands
};

/**
 * The receiver forges an unsigned ACK that speaks for `recipient-b`, which holds its own ACK until the sender has read
 * the receipt with the forgery refused `missing-proof` and `recipient-b` not yet confirmed by it. Over `rtc` alone: a
 * WS fallback would complete the held leg and hide it. The cues travel on a type of their own, so the cell's type
 * carries the send alone, which the receipt window and the receivers' counts read.
 */
export const forgedRecipientAck: AlmConformanceScenarioDefinition = {
    scenarioId: 'receipted-audience',
    scenarioKey: 'forged-recipient-ack',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_RTC_ALONE_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    toReceiptRoles: () => BOTH_CONFIRMED,
    toSenderCommands: toForgedAckSenderCommands,
    toRecipientCommands: toForgedAckRecipientCommands
};

export const receiptedAudience: readonly AlmConformanceScenarioDefinition[] = [
    aggregatedReceipt,
    missingRecipientRetry,
    unknownAckVersion,
    unsignedAckRefused,
    forgedRecipientAck,
    frozenAudienceMembership
];

/**
 * Authored, so the refusal the origin states names this control and no raw ACK of another carrier, and suffixed with
 * the msgId of the send it answers, so a re-run on a page whose store survived is admitted again, never a duplicate.
 */
function toRawAckMsgId(step: AlmConformanceStepInput, label: string, ackedMsgId: string): string {
    return `${toAlmCellCommandPrefix(step.input.carrier, step.scenarioKey)}-${label}-${ackedMsgId}`;
}

/** A raw ACK over the rtc leg that answers the arrival's message event, addressed to the session that sent it. */
function toRawAckControlCommand(step: AlmConformanceStepInput, control: RawAckControlInput): RallarBlackBoxTestCommand {
    const event = `resultCache.${control.arrival}.value.event.payload`;
    return {
        kind: 'messages.control',
        commandId: toCommandId(step, control.name),
        connection: step.input.receiverConnection,
        carrier: 'rtc',
        typeId: control.typeId,
        msgId: toRawAckMsgId(step, control.label, `{${event}.data.msgId}`),
        ackedMsgId: `{${event}.data.msgId}`,
        toPeerId: `{${event}.senderId}`,
        ...(control.logicalRecipientPeerId === undefined
            ? {}
            : { logicalRecipientPeerId: control.logicalRecipientPeerId }),
        timeoutMs: toBudgetMs(MESSAGE_CONTROL_TIMEOUT_MS, step.input.deadlineMs)
    };
}

function toControlAdmittedAssertion(step: AlmConformanceStepInput, control: string): RallarBlackBoxTestCommand {
    return toResultAssertion({
        step,
        name: 'assert-control-admitted-1',
        resultName: control,
        field: 'verdict',
        operator: 'equals',
        expected: 'admitted'
    });
}

function toArrivalWait(recipient: AlmConformanceStepInput): RallarBlackBoxTestWaitCommand {
    return toPayloadWait({
        step: recipient,
        name: ARRIVAL,
        payload: toAudiencePayload(recipient),
        absent: false
    });
}

/** The cell's cues travel on a type of their own, which no receipt window or received count of the cell reads. */
export function toCueStep(step: AlmConformanceStepInput): AlmConformanceStepInput {
    return { ...step, scenarioKey: `${step.scenarioKey}-cues` };
}

function toRetryReceiptRoles(carrier: AlmConformanceCarrier): AlmConformanceReceiptRoles {
    return carrier === 'ws' ? RECIPIENT_B_UNCONFIRMED : BOTH_CONFIRMED;
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

function toUnknownAckVersionRecipientCommands(
    recipient: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return toRawAckRecipientCommands(recipient, {
        name: 'unknown-ack-version-1',
        typeId: RETIRED_ACK_TYPE_ID,
        label: 'retired-ack'
    });
}

function toUnsignedAckRecipientCommands(recipient: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return toRawAckRecipientCommands(recipient, {
        name: 'unsigned-ack-1',
        typeId: AL_CONTROL_ACK_TYPE_ID,
        label: 'unsigned-ack'
    });
}

/** The received message event names the send and its origin, which the raw ACK of `recipient-b` answers. */
function toRawAckRecipientCommands(
    recipient: AlmConformanceStepInput,
    answer: RawAckAnswer
): readonly RallarBlackBoxTestCommand[] {
    if (recipient.role !== 'recipient-b') {
        return toSingleArrivalReceiverCommands(recipient);
    }
    return [
        toArrivalWait(recipient),
        toRawAckControlCommand(recipient, { ...answer, arrival: toCommandId(recipient, ARRIVAL) }),
        toControlAdmittedAssertion(recipient, answer.name),
        toReceivedCommand({ ...recipient, index: 2, count: 2, absent: true })
    ];
}

/**
 * The hold is in place before the send, since the sender waits for the victim's cue. The mid-window read cannot name
 * a session, so it pins only that the receipt is incomplete. The refusal wait guards the cell: it waits for the
 * origin's `rejected` admission of the forged control's authored id with `proofRefusal` `missing-proof`, which a
 * forged ACK the origin counted never produces.
 */
function toForgedAckSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const cue = toCueStep(sender);
    const midWindow = 'receipts-mid-window';
    const toMidWindowAssertion = (field: string, operator: 'notEquals' | 'gte' | 'lte', expected: string | number) =>
        toResultAssertion({
            step: sender,
            name: `assert-${midWindow}-${field.replace('.length', '-count')}`,
            resultName: midWindow,
            field,
            operator,
            expected
        });
    return [
        ...toCueListenCommands(cue),
        ...toCueSendCommands(cue, 'ready'),
        toCueWait(cue, 'victim'),
        ...toAudienceSendCommands({ sender, ttlMs: NON_EXPIRING_TTL_MS, ack: 'all-logical-recipients' }),
        toControlProofRefusalWait({
            step: { ...sender, index: 1 },
            name: 'forged-recipient-ack-refused',
            controlMsgId: toRawAckMsgId(sender, 'forged-ack', toSentMsgIdReference({ ...sender, index: 1 })),
            controlTypeId: AL_CONTROL_ACK_TYPE_ID,
            proofRefusal: 'missing-proof'
        }),
        { ...toReceiptsCommand({ ...sender, index: 1 }), commandId: toCommandId(sender, midWindow) },
        toMidWindowAssertion('state', 'notEquals', 'acknowledged'),
        toMidWindowAssertion('unconfirmedRecipientPeerIds.length', 'gte', 1),
        toMidWindowAssertion('confirmedRecipientPeerIds.length', 'lte', 1),
        ...toCueSendCommands(cue, 'release'),
        ...toReceiptWindowCommands(sender, { roles: BOTH_CONFIRMED, ending: 'acknowledged', mode: 'receiver' })
    ];
}

/**
 * The receiver forges once `recipient-b` has received the send, naming it from its cue's sender. `recipient-b` clears
 * its hold explicitly once the sender's mid-window read is done, so its own ACK completes the receipt.
 */
function toForgedAckRecipientCommands(recipient: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const cue = toCueStep(recipient);
    if (recipient.role !== 'recipient-b') {
        const arrival = toArrivalWait(recipient);
        const victim = toCueWait(cue, 'victim');
        const control = 'forged-ack-1';
        return [
            ...toCueListenCommands(cue),
            arrival,
            victim,
            toRawAckControlCommand(recipient, {
                name: control,
                typeId: AL_CONTROL_ACK_TYPE_ID,
                label: 'forged-ack',
                arrival: toCommandId(recipient, ARRIVAL),
                logicalRecipientPeerId: `{resultCache.${victim.commandId}.value.event.payload.senderId}`
            }),
            toControlAdmittedAssertion(recipient, control),
            toReceivedCommand({ ...recipient, index: 2, count: 2, absent: true })
        ];
    }
    return [
        toAckHoldFaultCommand(recipient, 'hold-ack', 'until-cleared'),
        ...toCueListenCommands(cue),
        toCueWait(cue, 'ready'),
        ...toCueSendCommands(cue, 'victim'),
        toReceivedCommand({ ...recipient, index: 1, count: 1, absent: false }),
        toCueWait(cue, 'release'),
        toAckHoldFaultCommand(recipient, 'release-ack', 0)
    ];
}
