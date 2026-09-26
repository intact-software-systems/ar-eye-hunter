import { AL_CONTROL_NACK_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';

import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, RESPONSE_MARGIN_MS } from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import { toAdmissionCommands, toSendCommand } from '../alm-conformance-message-commands.ts';
import { toAdmissionOutcomeWait, toSingleArrivalReceiverCommands } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';

const OUTBOUND_DIAGNOSTICS_TOPIC = 'rallar.browser.alm.outbound_diagnostics';
const RESYNC_GAP_SEQ = 300;

export const orderingResync: AlmConformanceScenarioDefinition = {
    scenarioId: 'ordering-resync',
    scenarioKey: 'ordering-resync',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
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
 * the send requested no ACK, so its handle is already transport-accepted and keeps that state. The diagnostic
 * names the gapped msgId either way.
 */
function toRelayResyncNackWait(sender: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    const gappedMsgId = `{resultCache.${toCommandId(sender, 'send-2')}.value.msgId}`;
    return {
        kind: 'wait',
        commandId: toCommandId(sender, 'relay-resync-nack'),
        match: {
            kind: 'diagnostic',
            topic: OUTBOUND_DIAGNOSTICS_TOPIC,
            payloadPath: 'data',
            contains: `"typeId":"${AL_CONTROL_NACK_TYPE_ID}","targetMsgId":"${gappedMsgId}"`
        },
        timeoutMs: sender.input.deadlineMs + NON_EXPIRING_SEND_TIMEOUT_MS - RESPONSE_MARGIN_MS
    };
}

/** Over the RTC carriers the receiver is the hop that refuses the gapped send, so it proves its own verdict (D44). */
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
            timeoutMs: receiver.input.deadlineMs + NON_EXPIRING_SEND_TIMEOUT_MS - RESPONSE_MARGIN_MS
        }),
        absentSecond
    ];
}
