import {
    AL_VOLATILE_SESSION_LIMITS,
    type ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toAdmissionCommands, toSendCommand } from '../../alm-conformance-message-commands.ts';
import { toOrderingKey } from '../../alm-conformance-ordering-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
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
 * the rejoin's state sync needs no wait.
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
        ...ADMITTED_INDEXES.flatMap((index) => toAcknowledgedCommands(sender, index)),
        ...toBoundReconnectCommands(sender, 'restored', undefined)
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
