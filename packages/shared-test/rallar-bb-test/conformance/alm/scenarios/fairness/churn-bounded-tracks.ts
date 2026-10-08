import { AL_INBOUND_MAX_ORDERING_TRACKS } from '@shared/alm/inbound/admission/al-inbound-ordering-track-cap.ts';
import {
    AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    AL_VOLATILE_SESSION_MAX_BYTES
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesSendCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import {
    NON_EXPIRING_SEND_TIMEOUT_MS,
    NON_EXPIRING_TTL_MS,
    RESPONSE_MARGIN_MS
} from '../../alm-conformance-budgets.ts';
import type { AlmConformanceCarrier } from '../../alm-conformance-carriers.ts';
import { toObserveCommand, toResultAssertion, toSendCommand } from '../../alm-conformance-message-commands.ts';
import { toOrderingKey } from '../../alm-conformance-ordering-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toStatsCommand } from '../../alm-conformance-session-commands.ts';
import { toCommandId, toSendHandleId } from '../../alm-conformance-step-identities.ts';
import { toBoundReconnectCommands, toReconnectedArrivalsCommand } from '../volatile-bound/volatile-bound-commands.ts';
import { toPauseCommand } from './to-pause-command.ts';
import { toSendLoopCommand } from './to-send-loop-command.ts';

/**
 * More tracks than a session store keeps ordering snapshots for (`AL_INBOUND_MAX_ORDERING_TRACKS`, D191), with a
 * margin: at this count the opens take about 21 s at the loop's pace, inside the receiver's 58 s window.
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
 * Only over `rtc` is the receiver the one hop that orders a track: over `ws` the WS server orders it first and keeps
 * its own snapshots, and a hand-over moves a message to a relay that never saw its track (D56).
 */
const RECEIVER_ORDERED_CARRIERS: readonly AlmConformanceCarrier[] = ['rtc'];

/**
 * D191: the sender opens 280 tracks with one send each and leaves. The receiver delivers the 280, and its inbound
 * stores then hold exactly the cap of ordering snapshots: each track past it evicted the least recently updated one.
 */
export const churnBoundedTracks: AlmConformanceScenarioDefinition = {
    scenarioId: 'churn-bounded-tracks',
    scenarioKey: 'churn-bounded-tracks',
    tags: FULL_TAGS,
    carriers: RECEIVER_ORDERED_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toChurnSenderCommands,
    toRecipientCommands: (receiver) => [
        toReconnectedArrivalsCommand(receiver, CHURN_TRACK_COUNT, 0),
        // A store states its count right after a new track's admission commit, before that track's delivery.
        toPauseCommand(receiver, 'snapshots-settle', RESPONSE_MARGIN_MS),
        ...toOrderingTracksCommands(receiver)
    ]
};

function toChurnSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toBoundReconnectCommands(sender, 'raised', CHURN_SENDER_LIMITS),
        toSendLoopCommand({
            step: sender,
            name: 'open-tracks',
            count: CHURN_TRACK_COUNT,
            send: toTrackSend(sender, '{loop.index}')
        }),
        {
            ...toObserveCommand({ ...sender, index: 0, state: 'transport-accepted' }),
            commandId: toCommandId(sender, 'observe-last-track'),
            handleId: `${toSendHandleId({ ...sender, index: 0 })}-${CHURN_TRACK_COUNT - 1}`
        },
        toResultAssertion({
            step: sender,
            name: 'assert-last-track-sent',
            resultName: 'observe-last-track',
            field: 'state',
            operator: 'matches',
            expected: '^(transport-accepted|acknowledged)$'
        }),
        { kind: 'close', commandId: toCommandId(sender, 'close-departs') }
    ];
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

/** The receiver's ordering snapshots after the churn: at the cap, neither under it nor past it. */
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
