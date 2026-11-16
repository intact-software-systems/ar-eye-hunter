import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, RESPONSE_MARGIN_MS } from '../../alm-conformance-budgets.ts';
import { ALM_INBOUND_DIAGNOSTICS_TOPIC } from '../../alm-conformance-diagnostic-waits.ts';
import { toHeldMessageFaultCommands, toHeldSendCommands } from '../../alm-conformance-fault-commands.ts';
import { toAdmissionCommands, toSendCommand } from '../../alm-conformance-message-commands.ts';
import { toOrderingKey, toSentCommands } from '../../alm-conformance-ordering-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';
import { toPauseCommand } from '../../to-pause-command.ts';
import { FAIRNESS_SEND_INTERVAL_MS } from './to-send-loop-command.ts';

/**
 * Sequences 3 to 66, which arrive ahead of seq 2, so seq 2's arrival releases 64 buffered messages at once. A loop
 * cannot name them: its index counts from 0 with no offset, a sequence is a number a loop does not substitute, and an
 * outer loop fixes an inner loop's index before it runs. So each is a literal send with a pause after it.
 */
const BUFFERED_SEQS = Array.from({ length: 64 }, (_, offset) => offset + 3);
const HELD_SEQ = 2;
const TRACK_LENGTH = BUFFERED_SEQS.length + 2;
/**
 * The cell's own lifetime for the sends and the receive window. A slow runner may take longer than the default 30 s
 * to put 66 sends on the wire and deliver them; that a 64-message buffer drains within the default lifetime is
 * proven on the real runtime, and this cell proves the 66 arrivals and, over `rtc`, the promotion.
 */
const BUFFERED_TRACK_TTL_MS = 90_000;
/** A count above zero starts with a digit from 1 to 9, and `promoted` is the last key `effect-drain` emits. */
const NONZERO_LEADING_DIGITS = 9;

/**
 * D190: seq 2 arrives after seq 3 to 66 of one ordering key, and the receiver delivers all 66. The sender's head only
 * moves forward, so the sends leave in order and the transport reorders them: seq 1 opens the receiver's track, seq 2
 * is held by its message id, seq 3 to 66 pass, then seq 2 is released. A receiver with no position enters a recorded
 * track at its first copy, so seq 1 goes first: an entry at seq 3 would leave seq 2 below it. The sends ask for no
 * receipt: the receiver cannot acknowledge seq 3 to 66 before seq 2 arrives, so a receipted send would wait out its
 * ACK retries one after the other. They are bare, without an admission observation each, and paced. Over `rtc` the
 * receiver is the hop that buffered them, so one of its inbound batches states a release it ran by promotion. The cell
 * runs over both carriers: over `ws` the server NACKs the gap at each later frame's arrival, and every report of the
 * held seq 2 is the same gap, so the sender's one retransmit is charged once and the hold's release delivers it
 * (D573). Over `ws` the server is the hop that buffers the track and releases it when seq 2 arrives, so the receiver
 * reads the arrivals and the promotion observation is the RTC receiver's.
 */
export const bufferedTrackDrains: AlmConformanceScenarioDefinition = {
    scenarioId: 'buffered-track-drains',
    scenarioKey: 'buffered-track-drains',
    tags: FULL_TAGS,
    carriers: ['ws', 'rtc'],
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: (sender) => [
        toTrackSend(sender, 1),
        ...toSentCommands({ ...sender, index: 1 }),
        ...toHeldSendCommands({ ...sender, index: HELD_SEQ }, [toTrackSend(sender, HELD_SEQ)]),
        ...BUFFERED_SEQS.flatMap((seq) => [
            toTrackSend(sender, seq),
            toPauseCommand(sender, `pause-${seq}`, FAIRNESS_SEND_INTERVAL_MS)
        ]),
        ...toHeldMessageFaultCommands({ ...sender, index: HELD_SEQ }, `release-message-${HELD_SEQ}`, 0),
        ...toAdmissionCommands({ ...sender, index: HELD_SEQ })
    ],
    toRecipientCommands: (receiver) =>
        receiver.input.carrier === 'rtc'
            ? [toTrackArrivalsCommand(receiver), toPromotionWait(receiver)]
            : [toTrackArrivalsCommand(receiver)]
};

function toTrackSend(sender: AlmConformanceStepInput, seq: number): RallarBlackBoxTestCommand {
    return toSendCommand({
        ...sender,
        index: seq,
        payload: { marker: sender.scenarioId, seq },
        delivery: {
            reliability: 'at-least-once',
            ack: 'none',
            ttlMs: BUFFERED_TRACK_TTL_MS,
            commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS,
            orderingKey: toOrderingKey(sender),
            seq
        }
    });
}

/** Every message of the track within the cell's lifetime: the first buffered one expires at its end. */
function toTrackArrivalsCommand(receiver: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return {
        ...toReceivedCommand({ ...receiver, index: 1, count: TRACK_LENGTH, absent: false }),
        windowMs: BUFFERED_TRACK_TTL_MS - RESPONSE_MARGIN_MS,
        timeoutMs: BUFFERED_TRACK_TTL_MS
    };
}

/**
 * An inbound `effect-drain` whose `promoted` count is above zero. A substring cannot exclude zero, so the loop reads
 * one leading digit per iteration and stops at the first a drain states. Only a release that completed promotes its
 * successor. The wait reads its own cell's history, so no earlier cell's drain can match. The loop runs after the
 * arrivals and reads that history.
 */
function toPromotionWait(receiver: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return {
        kind: 'loop',
        commandId: toCommandId(receiver, 'promoted-release'),
        count: NONZERO_LEADING_DIGITS,
        until: 'first-success',
        commands: [{
            kind: 'wait',
            commandId: toCommandId(receiver, 'promoted-digit'),
            match: {
                kind: 'diagnostic',
                topic: ALM_INBOUND_DIAGNOSTICS_TOPIC,
                payloadPath: 'data',
                contains: '"promoted":{loop.iteration}'
            },
            timeoutMs: RESPONSE_MARGIN_MS
        }]
    };
}
