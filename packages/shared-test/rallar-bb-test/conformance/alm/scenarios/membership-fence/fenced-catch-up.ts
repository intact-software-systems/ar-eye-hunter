import { AL_CONTROL_NACK_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';

import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_SINGLE_HOP_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toControlAdmissionWait, toVerdictTimeoutMs } from '../../alm-conformance-diagnostic-waits.ts';
import { toAdmissionCommands, toSendCommand } from '../../alm-conformance-message-commands.ts';
import { toAdmissionOutcomeWait, toPayloadWait, toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toSelfMembershipCommand } from '../../alm-conformance-session-commands.ts';

type CatchUpSend = 'floored' | 'roster-move';

/**
 * A send floored one snapshot past its sender's waits `not-yet-in-sync` until the roster moves, then is delivered.
 * The sender's second send is the cue: `recipient-b` leaves once it arrives, so the move follows the refusal. Over
 * `ws` the server retains the send, answers an advisory NACK and delivers the send itself once the move meets its
 * floor; over `rtc` the receiver refuses and states its refusal, and the sender's retry after the move is admitted.
 * Either way the receiver gets the floored send once.
 */
export const fencedCatchUp: AlmConformanceScenarioDefinition = {
    scenarioId: 'fenced-catch-up',
    scenarioKey: 'fenced-catch-up',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_SINGLE_HOP_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    toSenderCommands: toFencedCatchUpSenderCommands,
    toRecipientCommands: (recipient) =>
        recipient.role === 'recipient-b'
            ? toRosterMoverCommands(recipient)
            : toFencedCatchUpReceiverCommands(recipient)
};

/**
 * The refusal's NACK reaches the sender before the cue leaves, so the roster cannot move before the floored send is
 * refused. Over `ws` the sender leaves the server's advisory NACK unhandled, so its arrival is the cue.
 */
function toFencedCatchUpSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...sender,
            index: 1,
            payload: toCatchUpPayload(sender, 'floored'),
            delivery: {
                ack: 'receiver',
                reliability: 'at-least-once',
                ttlMs: NON_EXPIRING_TTL_MS,
                commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS,
                minSnapshotVersion: { aboveCurrentBy: 1 }
            }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toControlAdmissionWait({
            step: { ...sender, index: 1 },
            name: 'catch-up-nack',
            controlTypeId: AL_CONTROL_NACK_TYPE_ID,
            outcome: sender.input.carrier === 'ws' ? undefined : 'committed'
        }),
        toSendCommand({
            ...sender,
            index: 2,
            payload: toCatchUpPayload(sender, 'roster-move'),
            delivery: { reliability: 'at-least-once', ttlMs: NON_EXPIRING_TTL_MS }
        }),
        ...toAdmissionCommands({ ...sender, index: 2 })
    ];
}

/** Leaving moves the roster and the snapshot by one, which the floored send's floor needs. */
function toRosterMoverCommands(recipient: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toPayloadWait({
            step: recipient,
            name: 'received-roster-move',
            payload: toCatchUpPayload(recipient, 'roster-move'),
            absent: false
        }),
        toSelfMembershipCommand(recipient, 'left')
    ];
}

/** Over `rtc` the receiver states its own refusal before the delivery; over `ws` the server retains the send. */
function toFencedCatchUpReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const refusal = toAdmissionOutcomeWait(receiver, {
        name: 'not-yet-in-sync-outcome',
        contains: '"carrier":"rtc","outcome":"rejected","reason":"not-yet-in-sync',
        timeoutMs: toVerdictTimeoutMs(receiver.input.deadlineMs)
    });
    return [
        ...(receiver.input.carrier === 'rtc' ? [refusal] : []),
        toPayloadWait({
            step: receiver,
            name: 'received-floored',
            payload: toCatchUpPayload(receiver, 'floored'),
            absent: false
        }),
        toReceivedCommand({ ...receiver, index: 3, count: 3, absent: true })
    ];
}

function toCatchUpPayload(step: AlmConformanceStepInput, send: CatchUpSend): Readonly<Record<string, string>> {
    return { marker: step.scenarioKey, carrier: step.input.carrier, send };
}
