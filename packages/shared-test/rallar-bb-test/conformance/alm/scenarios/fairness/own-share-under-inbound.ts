import {
    AL_VOLATILE_SESSION_MAX_BYTES,
    AL_VOLATILE_SESSION_OWN_SHARE
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestLoopCommand,
    RallarBlackBoxTestMessagesSendCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import {
    NON_EXPIRING_SEND_TIMEOUT_MS,
    NON_EXPIRING_TTL_MS,
    RESPONSE_MARGIN_MS
} from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_SINGLE_HOP_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toResultAssertion, toSendCommand } from '../../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toStatsCommand } from '../../alm-conformance-session-commands.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';
import {
    toAcknowledgedCommands,
    toBoundReconnectCommands,
    toReconnectedArrivalsCommand
} from '../volatile-bound/volatile-bound-commands.ts';
import { toSendLoopCommand } from './to-send-loop-command.ts';

/** The receiver's lowered count bound; the byte bound keeps its constant, so the count alone decides. */
const OWN_SHARE_LIMITS = { maxAdmissions: 20, maxBytes: AL_VOLATILE_SESSION_MAX_BYTES };
/** The receiver's own pool is refused only once it holds this many of its own admissions (D189): 10. */
const OWN_SHARE_ADMISSIONS = Math.floor(OWN_SHARE_LIMITS.maxAdmissions * AL_VOLATILE_SESSION_OWN_SHARE);
/**
 * Arrivals alone fill the lowered total. An arrival counts for `min(ttl, 30 s)` from the moment it arrives, so the
 * total stays full only while all 20 arrivals are younger than that. The flood therefore asks for no receipt: a
 * receipted send waits for its ACK, so twenty of them in a row would stretch the flood by twenty round trips.
 * Unreceipted and paced at 75 ms, the 20 are on the wire within two seconds, under the RTC limiter that the receiver's
 * ready ACK shares, and the receiver reads its stats once it has seen all of them and its own send is acknowledged.
 */
const FLOOD_COUNT = OWN_SHARE_LIMITS.maxAdmissions;
const READY_INDEX = 1;
const OWN_INDEX = 2;
/**
 * A ready message reaches the sender's recipe only once the sender's connect has subscribed its channel: one that
 * arrives earlier is admitted and acknowledged with no subscriber to see it, which over `ws` happens when the
 * receiver's reconnect finishes first. So the receiver repeats it until the flood's first arrival shows the sender
 * heard one. The five repeats outlast the sender's prologue connect, whose readiness may take up to 30 s, and the 10 s
 * its first send may take after it. Each repeat stays in the own pool for its lifetime, so the five attempts and the
 * own send stay under the share of 10.
 */
const READY_ATTEMPTS = 5;
const READY_REPEAT_MS = 8_000;

/**
 * D189: the receiver reconnects with its count bound lowered and says it is ready; the sender floods the room until
 * the receiver's arrivals alone hold its total at the bound. The receiver's own room send is still admitted, since
 * its own pool is under its share, and acknowledged; its ledger then reads the inbound pool at the bound, the own pool
 * under its share and no overload. One shared pool would have refused that send `capacity`. The receiver reconnects
 * with its constants last. The ledger is carrier-independent, and the lowered-limit reconnect is not stable under
 * `rtc-with-ws-fallback`'s readiness, so the cell runs on `ws` and `rtc`.
 */
export const ownShareUnderInbound: AlmConformanceScenarioDefinition = {
    scenarioId: 'own-share-under-inbound',
    scenarioKey: 'own-share-under-inbound',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_SINGLE_HOP_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: (sender) => [
        toReconnectedArrivalsCommand(sender, READY_INDEX, 0),
        toSendLoopCommand({ step: sender, name: 'flood', count: FLOOD_COUNT, send: toRoomSend(sender, 0, 'none') })
    ],
    toRecipientCommands: toOwnShareReceiverCommands
};

function toOwnShareReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toBoundReconnectCommands(receiver, 'lowered', OWN_SHARE_LIMITS),
        toReadyCommand(receiver),
        toReceivedCommand({ ...receiver, index: 1, count: FLOOD_COUNT, absent: false }),
        toRoomSend(receiver, OWN_INDEX, 'receiver'),
        ...toAcknowledgedCommands(receiver, OWN_INDEX),
        ...toOwnShareLedgerCommands(receiver),
        ...toBoundReconnectCommands(receiver, 'restored', undefined)
    ];
}

/** The ready send, repeated until the first arrival of the flood, each repeat under a handle of its own. */
function toReadyCommand(receiver: AlmConformanceStepInput): RallarBlackBoxTestLoopCommand {
    const send = toRoomSend(receiver, READY_INDEX, 'receiver');
    return {
        kind: 'loop',
        commandId: toCommandId(receiver, 'ready'),
        count: READY_ATTEMPTS,
        until: 'first-success',
        commands: [
            { ...send, commandId: toCommandId(receiver, 'ready-send'), handleId: `${send.handleId}-{loop.index}` },
            {
                ...toReceivedCommand({ ...receiver, index: 1, count: 1, absent: false }),
                commandId: toCommandId(receiver, 'ready-heard'),
                windowMs: READY_REPEAT_MS,
                timeoutMs: READY_REPEAT_MS + RESPONSE_MARGIN_MS
            }
        ]
    };
}

/** The receiver's ledger after its own send: arrivals at the bound, its own pool under the share, no overload. */
function toOwnShareLedgerCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const facts = [
        ['inbound-at-the-bound', 'rallar.alm.inbound.admissions', 'gte', OWN_SHARE_LIMITS.maxAdmissions],
        ['own-under-the-share', 'rallar.alm.own.admissions', 'lt', OWN_SHARE_ADMISSIONS],
        ['not-overloaded', 'rallar.alm.overloaded', 'equals', false]
    ] as const;
    return [
        toStatsCommand(receiver, 'stats-own-share'),
        ...facts.map(([name, field, operator, expected]) =>
            toResultAssertion({
                step: receiver,
                name: `assert-${name}`,
                resultName: 'stats-own-share',
                field,
                operator,
                expected
            })
        )
    ];
}

/** An at-least-once room send that outlives the cell, so each one counts for the whole window; `ack` names its receipt. */
function toRoomSend(
    step: AlmConformanceStepInput,
    index: number,
    ack: 'none' | 'receiver'
): RallarBlackBoxTestMessagesSendCommand {
    return toSendCommand({
        ...step,
        index,
        payload: { marker: step.scenarioId, carrier: step.input.carrier, index },
        delivery: {
            ack,
            reliability: 'at-least-once',
            ttlMs: NON_EXPIRING_TTL_MS,
            commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
        }
    });
}
