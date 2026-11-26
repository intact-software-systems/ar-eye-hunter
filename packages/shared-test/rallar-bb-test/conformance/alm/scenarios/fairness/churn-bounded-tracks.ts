import { AL_INBOUND_MAX_ORDERING_TRACKS } from '@shared/alm/inbound/admission/evict-al-inbound-ordering-tracks-past-cap.ts';
import {
    AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    AL_VOLATILE_SESSION_MAX_BYTES
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesReceivedCommand,
    RallarBlackBoxTestMessagesSendCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import {
    NON_EXPIRING_SEND_TIMEOUT_MS,
    NON_EXPIRING_TTL_MS,
    RESPONSE_MARGIN_MS
} from '../../alm-conformance-budgets.ts';
import type { AlmConformanceCarrier } from '../../alm-conformance-carriers.ts';
import { computeSenderBodyMs } from '../../alm-conformance-cell-parts.ts';
import { ALM_STORAGE_DIAGNOSTICS_TOPIC, toDiagnosticWait } from '../../alm-conformance-diagnostic-waits.ts';
import { toObserveCommand, toResultAssertion, toSendCommand } from '../../alm-conformance-message-commands.ts';
import { toOrderingKey } from '../../alm-conformance-ordering-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toStatsCommand } from '../../alm-conformance-session-commands.ts';
import { toCommandId, toSendHandleId } from '../../alm-conformance-step-identities.ts';
import { toBoundReconnectCommands } from '../volatile-bound/volatile-bound-commands.ts';
import { toSendLoopCommand } from './to-send-loop-command.ts';

/**
 * More tracks than a session store keeps ordering snapshots for (`AL_INBOUND_MAX_ORDERING_TRACKS`, D191), and a
 * margin.
 */
const CHURN_TRACK_COUNT = AL_INBOUND_MAX_ORDERING_TRACKS + 24;
/**
 * The sender's own ledger counts every live track of its own (64 by default, D179); each of these tracks lives as
 * long as its one send, so the sender reconnects with room for all of them.
 */
const CHURN_SENDER_LIMITS = {
    maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    maxBytes: AL_VOLATILE_SESSION_MAX_BYTES,
    maxTracks: 2 * CHURN_TRACK_COUNT
};
/**
 * The longest the 280 sends may take at all. Each send does the same work, about 15 IndexedDB reads, so the loop's
 * pace is the runner's storage latency: run 45258793437 read at 4 ms an operation, averaged 1,251 ms a send and would
 * have needed about 370 s. The ceiling leaves room for a runner slower still, and keeps the cell's worst case inside
 * its family's limit (`ALM_LANE_FAMILY_TIMEOUT_MS`).
 */
const CHURN_SEND_LOOP_CEILING_MS = 600_000;
const CHURN_COUNT_COVERS = 'the receiver\'s count of the churned tracks';
/**
 * Only over `rtc` is the receiver the one hop that orders a track: over `ws` the WS server orders it first and keeps
 * its own snapshots, and a hand-over moves a message to a relay that never saw its track (D56).
 */
const RECEIVER_ORDERED_CARRIERS: readonly AlmConformanceCarrier[] = ['rtc'];

/**
 * D191: the sender opens 280 tracks with one send each and leaves. The receiver delivers the 280, and its inbound
 * stores then hold exactly the cap of ordering snapshots: each track past it evicted the least recently updated one.
 * The loop's pace is the runner's, so the cell bounds both roles by progress rather than by a budget per send: each
 * send's own timeout bounds its loop iteration, and the receiver's count fails once no track arrives for as long as
 * the sender may take to reach its first. The receiver counts the arrivals themselves, so it needs no cue from a
 * sender that leaves once its last track is acknowledged.
 */
export const churnBoundedTracks: AlmConformanceScenarioDefinition = {
    scenarioId: 'churn-bounded-tracks',
    scenarioKey: 'churn-bounded-tracks',
    tags: FULL_TAGS,
    carriers: RECEIVER_ORDERED_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toRecipeRunExtensionMs: computeChurnSenderBodyMs,
    toSenderCommands: (sender) => [
        ...toChurnSends(sender),
        { kind: 'close', commandId: toCommandId(sender, 'close-departs') }
    ],
    toRecipientCommands: (receiver) => [
        toChurnArrivalsCommand(receiver),
        toOrderingTracksCapStatedWait(receiver),
        ...toOrderingTracksCommands(receiver)
    ]
};

function toChurnSends(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toChurnReconnectCommands(sender),
        toSendLoopCommand({
            step: sender,
            name: 'open-tracks',
            count: CHURN_TRACK_COUNT,
            send: toTrackSend(sender, '{loop.index}'),
            timeoutMs: CHURN_SEND_LOOP_CEILING_MS
        }),
        toLastTrackAcknowledgedCommand(sender),
        toResultAssertion({
            step: sender,
            name: 'assert-last-track-acknowledged',
            resultName: 'observe-last-track',
            field: 'state',
            operator: 'equals',
            expected: 'acknowledged'
        })
    ];
}

/**
 * The sender leaves only once the receiver acknowledged its last track, within the track's lifetime. Over RTC
 * `transport-accepted` is the frame leaving the page's data channel, not the receiver's admission, so a close right
 * after it could lose the frame in the transport's buffer; the receiver is the track's one hop, so its receipt is its
 * admission. The loop names each handle by its index, so the last one ends in 279.
 */
function toLastTrackAcknowledgedCommand(sender: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return {
        ...toObserveCommand({ ...sender, index: 0, state: 'acknowledged' }),
        commandId: toCommandId(sender, 'observe-last-track'),
        handleId: `${toSendHandleId({ ...sender, index: 0 })}-${CHURN_TRACK_COUNT - 1}`,
        timeoutMs: NON_EXPIRING_TTL_MS
    };
}

function toChurnReconnectCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return toBoundReconnectCommands(sender, 'raised', CHURN_SENDER_LIMITS);
}

/** Seq 1, the first send, on the cell's track named `track`. */
function toTrackSend(sender: AlmConformanceStepInput, track: string): RallarBlackBoxTestMessagesSendCommand {
    return toSendCommand({
        ...sender,
        index: 0,
        payload: { marker: sender.scenarioId, carrier: sender.input.carrier, track },
        delivery: {
            reliability: 'at-least-once',
            ttlMs: NON_EXPIRING_TTL_MS,
            commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS,
            orderingKey: `${toOrderingKey(sender)}-${track}`,
            seq: 1
        }
    });
}

/**
 * The receiver's count opens with the sender's body and may take all of it, the loop's ceiling included. It fails once
 * no track arrives for as long as the sender may take to reach its first track, its storage baseline, its reconnect
 * and one send, which is longer than any later track takes after the one before it: one send and its pause.
 */
function toChurnArrivalsCommand(receiver: AlmConformanceStepInput): RallarBlackBoxTestMessagesReceivedCommand {
    const windowMs = computeChurnSenderBodyMs(receiver);
    return {
        ...toReceivedCommand({ ...receiver, index: 1, count: CHURN_TRACK_COUNT, absent: false }),
        stallMs: computeSenderBodyMs(
            receiver,
            (sender) => [...toChurnReconnectCommands(sender), toTrackSend(sender, '0')],
            CHURN_COUNT_COVERS
        ),
        windowMs,
        timeoutMs: windowMs + RESPONSE_MARGIN_MS
    };
}

/** The sender's body up to its last track: the cell's longest step, so each role's recipe runs that much longer. */
function computeChurnSenderBodyMs(step: AlmConformanceStepInput): number {
    return computeSenderBodyMs(step, toChurnSends, CHURN_COUNT_COVERS);
}

/**
 * The memory store states its count at the end of the eviction pass a newly opened track runs after its admission
 * commit, not at the delivery the arrivals count, so the read follows the store's statement that it holds the cap.
 */
function toOrderingTracksCapStatedWait(receiver: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return toDiagnosticWait({
        step: receiver,
        name: 'ordering-tracks-cap-stated',
        topic: ALM_STORAGE_DIAGNOSTICS_TOPIC,
        contains: '/volatile"',
        payloadFields: { 'data.kind': 'ordering-tracks', 'data.tracks': AL_INBOUND_MAX_ORDERING_TRACKS },
        historyFrom: 'cell'
    });
}

/**
 * The receiver's ordering snapshots after the churn: at the cap, neither under it nor past it. The count sums every
 * inbound store that stated one since the receiver's last close. The cell's 280 tracks are volatile and fill that
 * store to the cap; the cell sends nothing durable, so its durable store opens no track and adds nothing, and the upper
 * bound is the cap plus those zero tracks.
 */
function toOrderingTracksCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const facts = [
        ['ordering-tracks-within-the-cap', 'lte'],
        ['ordering-tracks-at-the-cap', 'gte']
    ] as const;
    return [
        toStatsCommand(receiver, 'stats-ordering-tracks'),
        ...facts.map(([name, operator]) =>
            toResultAssertion({
                step: receiver,
                name: `assert-${name}`,
                resultName: 'stats-ordering-tracks',
                field: 'rallar.alm.orderingTracks',
                operator,
                expected: AL_INBOUND_MAX_ORDERING_TRACKS
            })
        )
    ];
}
