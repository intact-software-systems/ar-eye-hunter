import {
    AL_VOLATILE_SESSION_INBOUND_COUNTED_LIFETIME_MS,
    AL_VOLATILE_SESSION_MAX_ADMISSIONS
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toAdmissionCommands, toSendCommand } from '../../alm-conformance-message-commands.ts';
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
    toBoundRefusalCommands,
    toReconnectedArrivalsCommand,
    VOLATILE_BOUND_REFUSAL_FACTS
} from './volatile-bound-commands.ts';

/**
 * Two envelopes of at most 13,410 bytes leave 9,180 bytes in the 36 KB budget. Require at most 8 KB already
 * occupied before sending. Three envelopes always exceed the bound because each contains 12 KB of filler.
 * The initial window lets reconnect sync begin; only the subsequent ledger reading establishes headroom.
 */
const CAPACITY_FILLER = 'x'.repeat(12_000);
const CAPACITY_LIMITS = {
    maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    maxBytes: 36_000
};
const REJOIN_SETTLE_MS = AL_VOLATILE_SESSION_INBOUND_COUNTED_LIFETIME_MS + 1_000;
const REJOIN_SETTLE_TOPIC = 'rallar.black-box.alm.capacity-rejoin-settled';
const HEADROOM_TIMEOUT_MS = 30_000;
const HEADROOM_INTERVAL_MS = 500;
const BACKGROUND_HEADROOM_BYTES = 8 * 1024;
const ADMITTED_INDEXES = [1, 2] as const;
const REFUSED_INDEX = 3;

/**
 * D74 and D78: the sender reconnects under a lowered bound, sends up to it, and the next send ends `rejected` with
 * `refused`/`capacity` and no carrier attempt, so no fallback; the admitted sends are still acknowledged.
 */
export const capacity: AlmConformanceScenarioDefinition = {
    scenarioId: 'capacity',
    scenarioKey: 'capacity',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'addressed',
    toSenderCommands: toCapacitySenderCommands,
    toRecipientCommands: (receiver) => [
        toReconnectedArrivalsCommand(receiver, ADMITTED_INDEXES.length, REJOIN_SETTLE_MS + HEADROOM_TIMEOUT_MS)
    ]
};

function toCapacityHeadroomWait(sender: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    const commandId = toCommandId(sender, 'headroom');
    const stats = toStatsCommand(sender, 'headroom-stats');
    return {
        kind: 'loop',
        commandId,
        until: 'first-success',
        count: HEADROOM_TIMEOUT_MS / HEADROOM_INTERVAL_MS,
        intervalMs: HEADROOM_INTERVAL_MS,
        timeoutMs: HEADROOM_TIMEOUT_MS,
        commands: [
            stats,
            {
                kind: 'assert',
                commandId: toCommandId(sender, 'assert-headroom'),
                source: `resultCache.${commandId}:i{loop.iteration}:c1:${stats.commandId}.value.rallar.alm.usage.bytes`,
                operator: 'lte',
                expected: BACKGROUND_HEADROOM_BYTES
            }
        ]
    };
}

function toCapacitySenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toBoundReconnectCommands(sender, 'lowered', CAPACITY_LIMITS),
        toRejoinSettleWait(sender),
        toCapacityHeadroomWait(sender),
        ...ADMITTED_INDEXES.flatMap((
            index
        ) => [toCapacitySend(sender, index), ...toAdmissionCommands({ ...sender, index })]),
        toCapacitySend(sender, REFUSED_INDEX),
        ...toBoundRefusalCommands(sender, REFUSED_INDEX, VOLATILE_BOUND_REFUSAL_FACTS),
        ...ADMITTED_INDEXES.flatMap((index) => toAcknowledgedCommands(sender, index)),
        ...toBoundReconnectCommands(sender, 'restored', undefined)
    ];
}

/** Avoid reading an empty ledger before reconnect state publications have begun. */
function toRejoinSettleWait(sender: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(sender, 'rejoin-settles'),
        match: { kind: 'diagnostic', topic: REJOIN_SETTLE_TOPIC },
        absent: true,
        timeoutMs: REJOIN_SETTLE_MS
    };
}

function toCapacitySend(sender: AlmConformanceStepInput, index: number): RallarBlackBoxTestCommand {
    return toSendCommand({
        ...sender,
        index,
        payload: {
            marker: sender.scenarioId,
            carrier: sender.input.carrier,
            index,
            filler: CAPACITY_FILLER
        },
        delivery: {
            ack: 'receiver',
            ttlMs: NON_EXPIRING_TTL_MS,
            commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
        }
    });
}
