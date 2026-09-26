import type { ALDeliveryState } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import type { RallarBlackBoxTestCommand } from '../../rallar-black-box-test-contracts.ts';

import {
    NON_EXPIRING_SEND_TIMEOUT_MS,
    RESPONSE_MARGIN_MS,
    toBudgetMs
} from './alm-conformance-budgets.ts';
import { FAULT_TIMEOUT_MS } from './alm-conformance-fault-commands.ts';
import {
    toAdmissionCommands,
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

interface AlmConformanceAudienceSendInput {
    readonly sender: AlmConformanceStepInput;
    readonly ttlMs: number;
}

/**
 * One room send that asks for every logical recipient of the audience frozen at its admission (D41): the request
 * name maps to `receiver`, so the receipt of the origin expects that audience minus itself.
 */
export function toAudienceSendCommands(
    { sender, ttlMs }: AlmConformanceAudienceSendInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...sender,
            index: 1,
            payload: toAudiencePayload(sender),
            delivery: {
                ack: 'all-logical-recipients',
                reliability: 'at-least-once',
                ttlMs,
                commandTimeoutMs: Math.min(ttlMs, NON_EXPIRING_SEND_TIMEOUT_MS)
            }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 })
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
    roles: AlmConformanceReceiptRoles,
    ending: AlmConformanceReceiptEnding
): readonly RallarBlackBoxTestCommand[] {
    const windowMs = sender.input.deadlineMs - RESPONSE_MARGIN_MS;
    const lists = [
        ['expectedRecipientPeerIds', roles.confirmed.length + roles.unconfirmed.length],
        ['confirmedRecipientPeerIds', roles.confirmed.length],
        ['unconfirmedRecipientPeerIds', roles.unconfirmed.length]
    ] as const;
    return [
        {
            kind: 'messages.received',
            commandId: toCommandId(sender, 'received-self-1'),
            connection: sender.input.senderConnection,
            typeId: toScenarioTypeId(sender),
            count: 1,
            absent: true,
            windowMs,
            timeoutMs: windowMs + RESPONSE_MARGIN_MS
        },
        toReceiptsCommand({ ...sender, index: 1 }),
        toReceiptAssertion(sender, 'state', ending),
        toReceiptAssertion(sender, 'receiptMode', 'receiver'),
        ...lists.map(([field, expected]) => toReceiptAssertion(sender, `${field}.length`, expected))
    ];
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
