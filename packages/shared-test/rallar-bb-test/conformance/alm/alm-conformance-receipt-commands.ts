import { AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import type { ALReceiptMode } from '@shared/al-contracts/al-policy.ts';
import type { ALDeliveryState } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesSendCommand
} from '../../rallar-black-box-test-contracts.ts';

import {
    NON_EXPIRING_SEND_TIMEOUT_MS,
    NON_EXPIRING_TTL_MS,
    RESPONSE_MARGIN_MS,
    toBudgetMs
} from './alm-conformance-budgets.ts';
import { toControlAdmissionWait } from './alm-conformance-diagnostic-waits.ts';
import { FAULT_TIMEOUT_MS } from './alm-conformance-fault-commands.ts';
import {
    toAdmissionCommands,
    toObserveCommand,
    toReceiptsCommand,
    toResultAssertion,
    toSendCommand
} from './alm-conformance-message-commands.ts';
import type { AlmConformanceRole } from './alm-conformance-roles.ts';
import type { AlmConformanceStepInput } from './alm-conformance-scenario-definition.ts';
import { toCommandId, toScenarioTypeId } from './alm-conformance-step-identities.ts';

/** The recipient roles the receipt of a send confirms and leaves unconfirmed once its scenario has run. */
export interface AlmConformanceReceiptRoles {
    readonly confirmed: readonly AlmConformanceRole[];
    readonly unconfirmed: readonly AlmConformanceRole[];
}

/** The state the handle has reached when the origin reads its receipt: complete, or past its deadline. */
export type AlmConformanceReceiptEnding = Extract<ALDeliveryState, 'acknowledged' | 'expired'>;

/** What the origin's receipt reads after the scenario window: who confirmed, the state it ended in, and its mode. */
export interface AlmConformanceReceiptWindow {
    readonly roles: AlmConformanceReceiptRoles;
    readonly ending: AlmConformanceReceiptEnding;
    /** `receiver` for a send that asks for its logical recipients, `leader` for one that asks for the room's leader. */
    readonly mode: Extract<ALReceiptMode, 'receiver' | 'leader'>;
}

/** Who a room send reaches inside its room: its principal's other sessions, or the one session a lane role names. */
export type AlmConformanceSendAudience =
    | Readonly<{ scope: 'principal'; principalId: string; }>
    | Readonly<{ recipientPeer: NonNullable<RallarBlackBoxTestMessagesSendCommand['recipientPeer']>; }>;

interface AlmConformanceAudienceSendInput {
    readonly sender: AlmConformanceStepInput;
    readonly ttlMs: number;
    /** `all-logical-recipients` asks every session of the frozen audience, `group-leader` the room's leader alone. */
    readonly ack: Extract<RallarBlackBoxTestMessagesSendCommand['ack'], 'all-logical-recipients' | 'group-leader'>;
    /** Absent, every live session of the room. */
    readonly audience?: AlmConformanceSendAudience;
}

/** The first send of an addressed scenario, admitted and observed until its addressee acknowledges it. */
export function toAddressedSendCommands(
    sender: AlmConformanceStepInput,
    toPeer: NonNullable<RallarBlackBoxTestMessagesSendCommand['toPeer']>
): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, carrier: sender.input.carrier },
            delivery: {
                toPeer,
                ack: 'receiver',
                ttlMs: NON_EXPIRING_TTL_MS,
                commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
            }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toObserveCommand({ ...sender, index: 1, state: 'acknowledged' })
    ];
}

/** The first send of an audience scenario: one room send, its audience frozen at its admission. */
export function toAudienceSendCommand(
    { sender, ttlMs, ack, audience }: AlmConformanceAudienceSendInput
): RallarBlackBoxTestCommand {
    return toSendCommand({
        ...sender,
        index: 1,
        payload: toAudiencePayload(sender),
        delivery: {
            ack,
            reliability: 'at-least-once',
            ttlMs,
            commandTimeoutMs: Math.min(ttlMs, NON_EXPIRING_SEND_TIMEOUT_MS),
            ...audience
        }
    });
}

/**
 * The audience send, admitted. Asking for every logical recipient of the audience frozen at its admission (D41) maps
 * to `receiver`, so the receipt of the origin expects that audience minus itself.
 */
export function toAudienceSendCommands(input: AlmConformanceAudienceSendInput): readonly RallarBlackBoxTestCommand[] {
    return [toAudienceSendCommand(input), ...toAdmissionCommands({ ...input.sender, index: 1 })];
}

/**
 * Over ws the receipt is a control of the trusted server, so the origin states its own admission of it. The wait
 * matches the first receipt frame committed for the send, the `admitted` one; the frame carries no phase in its
 * diagnostic, so completion is proven by the receipt read after the window, which must read `acknowledged`.
 */
export function toServerReceiptCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return sender.input.carrier !== 'ws' ? [] : [
        toControlAdmissionWait({
            step: { ...sender, index: 1 },
            name: 'receipt-admitted-1',
            controlTypeId: AL_CONTROL_RECEIPT_TYPE_ID,
            outcome: 'committed'
        })
    ];
}

/**
 * D28: the origin reads its receipt only after the scenario window, never by polling `acknowledged`, and spends the
 * window proving it is not its own recipient, since the frozen audience excludes it. Then it pins the state the handle
 * ended in, the receipt mode and the length of each recipient list; which session each list names is joined after the
 * run.
 */
export function toReceiptWindowCommands(
    sender: AlmConformanceStepInput,
    { roles, ending, mode }: AlmConformanceReceiptWindow
): readonly RallarBlackBoxTestCommand[] {
    const lists = [
        ['expectedRecipientPeerIds', roles.confirmed.length + roles.unconfirmed.length],
        ['confirmedRecipientPeerIds', roles.confirmed.length],
        ['unconfirmedRecipientPeerIds', roles.unconfirmed.length]
    ] as const;
    return [
        toSelfAbsenceCommand(sender),
        toReceiptsCommand({ ...sender, index: 1 }),
        toReceiptAssertion(sender, 'state', ending),
        toReceiptAssertion(sender, 'receiptMode', mode),
        ...lists.map(([field, expected]) => toReceiptAssertion(sender, `${field}.length`, expected))
    ];
}

export function toSelfAbsenceCommand(sender: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    const windowMs = sender.input.deadlineMs - RESPONSE_MARGIN_MS;
    return {
        kind: 'messages.received',
        commandId: toCommandId(sender, 'received-self-1'),
        connection: sender.input.senderConnection,
        typeId: toScenarioTypeId(sender),
        count: 1,
        absent: true,
        windowMs,
        timeoutMs: windowMs + RESPONSE_MARGIN_MS
    };
}

/** The carrier scopes the payload, so a combined recipe never matches the arrival of an earlier carrier. */
export function toAudiencePayload(step: AlmConformanceStepInput): Readonly<Record<string, string>> {
    return { marker: step.scenarioKey, carrier: step.input.carrier };
}

/**
 * A recipient withholds its own ACKs on the carrier the send reaches it on: rtc for both RTC carriers, whose rtc leg
 * admits the send. A dropped RTC frame settles `not-ready` and its sender resubmits it 50 ms later, so one dropped
 * frame only delays an ACK; only a fault held until it is released keeps the ACK from leaving the page.
 */
export function toAckHoldFaultCommand(
    recipient: AlmConformanceStepInput,
    name: string,
    remaining: 'until-cleared' | 0
): RallarBlackBoxTestCommand {
    const carrier = recipient.input.carrier === 'ws' ? 'ws' : 'rtc';
    return {
        kind: 'fault.inject',
        commandId: toCommandId(recipient, `${name}-${carrier}`),
        faultId: `hold-ack-${carrier}-${toScenarioTypeId(recipient)}`,
        carrier,
        match: { controlType: 'ack' },
        action: 'drop',
        remaining,
        timeoutMs: toBudgetMs(FAULT_TIMEOUT_MS, recipient.input.deadlineMs)
    };
}

function toReceiptAssertion(
    sender: AlmConformanceStepInput,
    field: string,
    expected: string | number
): RallarBlackBoxTestCommand {
    return toResultAssertion({
        step: sender,
        name: `assert-receipt-${field.replace('.length', '-count')}-1`,
        resultName: 'receipts-1',
        field,
        operator: 'equals',
        expected
    });
}
