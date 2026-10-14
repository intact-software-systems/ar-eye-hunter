import {
    AL_VOLATILE_SESSION_LIMITS,
    type ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toAdmissionCommands, toResultAssertion, toSendCommand } from '../../alm-conformance-message-commands.ts';
import { toOrderingKey } from '../../alm-conformance-ordering-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toStatsCommand } from '../../alm-conformance-session-commands.ts';
import {
    toAcknowledgedCommands,
    toBoundReconnectCommands,
    toBoundRefusalCommands,
    toLimitRefusalFacts,
    toReconnectedArrivalsCommand
} from './volatile-bound-commands.ts';

/** Two live tracks fill the lowered bound; the other limits keep their constants, so tracks alone decide. */
const TRACK_LIMITS: ALVolatileSessionLimits = { ...AL_VOLATILE_SESSION_LIMITS, maxTracks: 2 };
const ADMITTED_INDEXES = [1, 2] as const;
const REFUSED_INDEX = 3;

/**
 * D179: the sender reconnects with two tracks allowed and sends three ordered sends, each the first of its own
 * ordering key: the third would open a third track and ends `rejected` with `refused`/`capacity`, limit `tracks` and
 * no carrier attempt, while the first two are still acknowledged. A received message never opens a counted track, so
 * the rejoin's state sync needs no wait. The sender reads its ledger right after the refusal, inside the admitted sends'
 * ttl, so both tracks are still counted and the reading sits at the bound.
 */
export const capacityTracks: AlmConformanceScenarioDefinition = {
    scenarioId: 'capacity-tracks',
    scenarioKey: 'capacity-tracks',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'addressed',
    toSenderCommands: toCapacityTracksSenderCommands,
    toRecipientCommands: (receiver) => [toReconnectedArrivalsCommand(receiver, ADMITTED_INDEXES.length, 0)]
};

function toCapacityTracksSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toBoundReconnectCommands(sender, 'lowered', TRACK_LIMITS),
        ...ADMITTED_INDEXES.flatMap((index) => [
            toTrackOpeningSend(sender, index),
            ...toAdmissionCommands({ ...sender, index })
        ]),
        toTrackOpeningSend(sender, REFUSED_INDEX),
        ...toBoundRefusalCommands(sender, REFUSED_INDEX, toLimitRefusalFacts('tracks')),
        ...toLedgerAtTheBoundCommands(sender),
        ...ADMITTED_INDEXES.flatMap((index) => toAcknowledgedCommands(sender, index)),
        ...toBoundReconnectCommands(sender, 'restored', undefined)
    ];
}

/** The page's own ledger reading at the track bound, which leaves the count and byte bounds unreached. */
function toLedgerAtTheBoundCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const facts = [
        ['tracks', 'rallar.alm.usage.tracks', TRACK_LIMITS.maxTracks],
        ['track-limit', 'rallar.alm.limits.maxTracks', TRACK_LIMITS.maxTracks],
        ['not-overloaded', 'rallar.alm.overloaded', false]
    ] as const;
    return [
        toStatsCommand(sender, 'stats-at-the-bound'),
        ...facts.map(([name, field, expected]) =>
            toResultAssertion({
                step: sender,
                name: `assert-${name}-at-the-bound`,
                resultName: 'stats-at-the-bound',
                field,
                operator: 'equals',
                expected
            })
        )
    ];
}

/** The first send of an ordering key of its own, so each send opens one track. */
function toTrackOpeningSend(sender: AlmConformanceStepInput, index: number): RallarBlackBoxTestCommand {
    return toSendCommand({
        ...sender,
        index,
        payload: { marker: sender.scenarioId, carrier: sender.input.carrier, index },
        delivery: {
            ack: 'receiver',
            reliability: 'at-least-once',
            ttlMs: NON_EXPIRING_TTL_MS,
            commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS,
            orderingKey: `${toOrderingKey(sender)}-${index}`,
            seq: 1
        }
    });
}
