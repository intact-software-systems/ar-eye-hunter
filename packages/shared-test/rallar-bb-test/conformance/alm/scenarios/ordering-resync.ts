import { AL_CONTROL_NACK_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';

import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { toVerdictTimeoutMs } from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import {
    ALM_STORAGE_DIAGNOSTICS_TOPIC,
    toCommittedControlAdmissionWait,
    toDiagnosticWait
} from '../alm-conformance-diagnostic-waits.ts';
import { toAdmissionCommands, toSendCommand } from '../alm-conformance-message-commands.ts';
import { toAdmissionOutcomeWait, toSingleArrivalReceiverCommands } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';

const RESYNC_GAP_SEQ = 300;

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

/** Over ws the WS server is the relay that refuses the gapped send, so its NACK is the verdict, witnessed at the sender. */
function toOrderingResyncSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    const orderingKey = `alm-${sender.input.carrier}-${sender.scenarioId}`;
    const commands = [
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
        ...toAdmissionCommands({ ...sender, index: 2 })
    ];
    return sender.input.carrier === 'ws' ? [...commands, toRelayResyncNackWait(sender)] : commands;
}

/**
 * The sender admits the NACK as the word of its trusted server (R-S2c-ii-5) and states the rejection by the relay;
 * the send requested no ACK, so its handle is already transport-accepted and keeps that state. The verdict must be
 * `committed`: a refused NACK would mean the trusted-relay rule no longer holds.
 */
function toRelayResyncNackWait(sender: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return toCommittedControlAdmissionWait({
        step: { ...sender, index: 2 },
        name: 'relay-resync-nack',
        controlTypeId: AL_CONTROL_NACK_TYPE_ID
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
            contains:
                `"kind":"recovery-owner-invoked","orderingKey":"alm-${receiver.input.carrier}-${receiver.scenarioId}",`
        }),
        toDiagnosticWait({
            step: receiver,
            name: 'recovery-owner-cursor',
            topic: ALM_STORAGE_DIAGNOSTICS_TOPIC,
            contains: cursor
        })
    ];
}
