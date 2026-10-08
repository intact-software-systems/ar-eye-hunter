import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_TTL_MS, RESPONSE_MARGIN_MS } from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_SINGLE_HOP_CARRIERS } from '../../alm-conformance-carriers.ts';
import { ALM_INBOUND_DIAGNOSTICS_TOPIC } from '../../alm-conformance-diagnostic-waits.ts';
import { toOrderedSendCommands } from '../../alm-conformance-ordering-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';

/**
 * Sequences 2 to 65, sent ahead of seq 1, so seq 1's arrival releases 64 buffered messages at once. A loop cannot
 * name them: its index counts from 0 with no offset, and an outer loop fixes an inner loop's index before it runs.
 */
const BUFFERED_SEQS = Array.from({ length: 64 }, (_, offset) => offset + 2);
const TRACK_LENGTH = BUFFERED_SEQS.length + 1;
/** A count above zero starts with a digit from 1 to 9, and `promoted` is the last key `effect-drain` emits. */
const NONZERO_LEADING_DIGITS = 9;

/**
 * D190: the sender sends seq 2 to 65 on one ordering key, then seq 1; the receiver delivers all 65 within one default
 * lifetime. Over `rtc` the receiver is the hop that buffered them, so one of its inbound batches states a release it
 * ran by promotion. Over `ws` the relay buffers and releases them out of the page's sight, as in `ordering-gap-repair`.
 */
export const bufferedTrackDrains: AlmConformanceScenarioDefinition = {
    scenarioId: 'buffered-track-drains',
    scenarioKey: 'buffered-track-drains',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_SINGLE_HOP_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: (sender) => [
        ...BUFFERED_SEQS.flatMap((seq) => toOrderedSendCommands(sender, seq)),
        ...toOrderedSendCommands(sender, 1)
    ],
    toRecipientCommands: (receiver) => [
        toTrackArrivalsCommand(receiver),
        ...(receiver.input.carrier === 'rtc' ? [toPromotionWait(receiver)] : [])
    ]
};

/** Every message of the track within one default lifetime: the first buffered one expires at its end. */
function toTrackArrivalsCommand(receiver: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return {
        ...toReceivedCommand({ ...receiver, index: 1, count: TRACK_LENGTH, absent: false }),
        windowMs: NON_EXPIRING_TTL_MS - RESPONSE_MARGIN_MS,
        timeoutMs: NON_EXPIRING_TTL_MS
    };
}

/**
 * An inbound `effect-drain` whose `promoted` count is above zero. A substring cannot exclude zero, so the loop reads
 * one leading digit per iteration and stops at the first a drain states. Only a release that completed promotes its
 * successor, and no earlier cell buffers two consecutive sequences, so the drain is this cell's.
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
