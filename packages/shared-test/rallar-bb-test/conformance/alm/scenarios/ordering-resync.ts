import { AL_CONTROL_NACK_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';

import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import {
    ALM_STORAGE_DIAGNOSTICS_TOPIC,
    toControlAdmissionWait,
    toDiagnosticWait,
    toVerdictTimeoutMs
} from '../alm-conformance-diagnostic-waits.ts';
import { toHeldSendCommands } from '../alm-conformance-fault-commands.ts';
import { toAdmissionCommands, toSendCommand } from '../alm-conformance-message-commands.ts';
import { toOrderedSendCommands, toOrderingKey } from '../alm-conformance-ordering-commands.ts';
import { toAdmissionOutcomeWait, toSingleArrivalReceiverCommands } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';
import { toSettledStateCommands } from '../to-settled-state-commands.ts';

const RESYNC_GAP_SEQ = 300;
/** The frame the receiver never receives over RTC: seq 300's record names it as the receiver's prior. */
const RESYNC_PRIOR_SEQ = RESYNC_GAP_SEQ - 1;

/**
 * A gap wider than the repair window is refused `resync-required` where the track is ordered. Over `ws` the WS server
 * orders it and refuses the jump from seq 1 to seq 300. Over the RTC carriers the receiver orders it, and the frame's
 * record states the receiver's prior (D525, D527): a bare jump reads as an omission there, so the sender holds seq 299
 * for good and seq 300 names it, 298 past the receiver's position.
 */
export const orderingResync: AlmConformanceScenarioDefinition = {
    scenarioId: 'ordering-resync',
    scenarioKey: 'ordering-resync',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toOrderingResyncSenderCommands,
    toRecipientCommands: toOrderingResyncReceiverCommands
};

function toOrderingResyncSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return sender.input.carrier === 'ws' ? toRelayResyncSenderCommands(sender) : toPriorGapSenderCommands(sender);
}

/**
 * The gap opens only once the receiver acknowledged seq 1, so it holds a position when seq 300 arrives: a receiver
 * with none enters the track at seq 300. The hold of seq 299 is never released, since a late copy would be an
 * omission; the frame expires held.
 */
function toPriorGapSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toOrderedSendCommands(sender, 1),
        ...toSettledStateCommands({ ...sender, index: 1 }, 'acknowledged'),
        ...toHeldSendCommands({ ...sender, index: RESYNC_PRIOR_SEQ }, toOrderedSendCommands(sender, RESYNC_PRIOR_SEQ)),
        ...toOrderedSendCommands(sender, RESYNC_GAP_SEQ)
    ];
}

/** Over ws the WS server is the relay that refuses the gapped send, so its NACK is the verdict, witnessed at the sender. */
function toRelayResyncSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    const orderingKey = toOrderingKey(sender);
    return [
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, seq: 1 },
            delivery: { reliability: 'at-least-once', orderingKey, seq: 1 }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toSendCommand({
            ...sender,
            index: 2,
            payload: { marker: sender.scenarioId, seq: RESYNC_GAP_SEQ },
            delivery: { reliability: 'at-least-once', orderingKey, seq: RESYNC_GAP_SEQ }
        }),
        ...toAdmissionCommands({ ...sender, index: 2 }),
        toRelayResyncNackWait(sender)
    ];
}

/**
 * The sender admits the NACK as the word of its trusted server (R-S2c-ii-5) and states the rejection by the relay;
 * the send requested no ACK, so its handle is already transport-accepted and keeps that state. The verdict must be
 * `committed`: a refused NACK would mean the trusted-relay rule no longer holds.
 */
function toRelayResyncNackWait(sender: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return toControlAdmissionWait({
        step: { ...sender, index: 2 },
        name: 'relay-resync-nack',
        controlTypeId: AL_CONTROL_NACK_TYPE_ID,
        outcome: 'committed'
    });
}

/**
 * Over the RTC carriers the receiver is the hop that refuses the gapped send, so it proves its own verdict (D44) and,
 * when the lane installed the recording owner on its channel, the owner's one invocation with the track's cursor.
 */
function toOrderingResyncReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    const [delivered, absentSecond] = toSingleArrivalReceiverCommands(receiver);
    if (receiver.input.carrier === 'ws') {
        return [delivered, absentSecond];
    }
    return [
        delivered,
        toAdmissionOutcomeWait(receiver, {
            name: 'resync-outcome',
            contains: '"carrier":"rtc","outcome":"not-handled","reason":"resync-required"',
            timeoutMs: toVerdictTimeoutMs(receiver.input.deadlineMs)
        }),
        ...(receiver.input.recoveryOwner === 'record' ? toRecoveryOwnerWaits(receiver) : []),
        absentSecond
    ];
}

/**
 * The `recovery-owner-invoked` storage event, in its emitted key order (`kind`, `orderingKey`, `senderId`, `epoch`,
 * `lastContiguousSeq`, `expectedSeq`, `observedSeq`, `carrier`). The sender's peer id is unknown when the recipe is
 * authored and sits between the track and the cursor, so the track and the cursor are matched by two waits on the
 * one event: the track stood at seq 1 and expected 2 when seq 300 arrived over RTC.
 */
function toRecoveryOwnerWaits(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const cursor = `"lastContiguousSeq":1,"expectedSeq":2,"observedSeq":${RESYNC_GAP_SEQ},"carrier":"rtc"}`;
    return [
        toDiagnosticWait({
            step: receiver,
            name: 'recovery-owner-invoked',
            topic: ALM_STORAGE_DIAGNOSTICS_TOPIC,
            historyFrom: 'cell',
            contains: `"kind":"recovery-owner-invoked","orderingKey":"${toOrderingKey(receiver)}",`
        }),
        toDiagnosticWait({
            step: receiver,
            name: 'recovery-owner-cursor',
            topic: ALM_STORAGE_DIAGNOSTICS_TOPIC,
            historyFrom: 'cell',
            contains: cursor
        })
    ];
}
