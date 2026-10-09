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
import { toCommandId } from '../../alm-conformance-step-identities.ts';
import {
    toAcknowledgedCommands,
    toBoundReconnectCommands,
    toBoundRefusalCommands,
    toReconnectedArrivalsCommand,
    VOLATILE_BOUND_REFUSAL_FACTS
} from './volatile-bound-commands.ts';

/**
 * The scenario is deterministic only while 3 * F = maxBytes and 2 * S + H <= maxBytes, where F is the filler, S is the
 * envelope of one send and H is the headroom kept for the platform traffic that arrives during the sends. An envelope
 * always weighs more than its filler, so the admitted sends, counted until their 30 s deadline, refuse the third
 * however small the envelope: 3 * S > 3 * 12 000 = 36 000. A planned send weighs 1 039 to 1 410 bytes over its filler
 * on the three carriers, so the second send leaves at least 36 000 - 2 * 13 410 = 9 180 bytes, above 8 KB. The
 * reconnect joins the room again (the close keeps the membership), and the lowered session admits the platform state
 * sync inbound (`group-state.event`, `client-state.snapshot` and `event`, 6 entries and about 26 KB in a fresh
 * two-member room), counted for at most 30 s; the sender waits that long after the reconnect before its first send,
 * so that sync has left the budget. The count bound keeps its constant, so bytes alone decide. An own send is
 * refused only once its own pool would also pass its share, half the bound (D189): with the sync gone the own pool is
 * the sends themselves, which the second already takes past 18 000, so the total decides and refuses the third.
 */
const CAPACITY_FILLER = 'x'.repeat(12_000);
const CAPACITY_LIMITS = {
    maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    maxBytes: 36_000
};
const REJOIN_SETTLE_MS = AL_VOLATILE_SESSION_INBOUND_COUNTED_LIFETIME_MS + 1_000;
const REJOIN_SETTLE_TOPIC = 'rallar.black-box.alm.capacity-rejoin-settled';
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
        toReconnectedArrivalsCommand(receiver, ADMITTED_INDEXES.length, REJOIN_SETTLE_MS)
    ]
};

function toCapacitySenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toBoundReconnectCommands(sender, 'lowered', CAPACITY_LIMITS),
        toRejoinSettleWait(sender),
        ...ADMITTED_INDEXES.flatMap((
            index
        ) => [toCapacitySend(sender, index), ...toAdmissionCommands({ ...sender, index })]),
        toCapacitySend(sender, REFUSED_INDEX),
        ...toBoundRefusalCommands(sender, REFUSED_INDEX, VOLATILE_BOUND_REFUSAL_FACTS),
        ...ADMITTED_INDEXES.flatMap((index) => toAcknowledgedCommands(sender, index)),
        ...toBoundReconnectCommands(sender, 'restored', undefined)
    ];
}

/** Holds the whole window: nothing emits the topic, so it only lets the rejoin's state sync leave the budget. */
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
