import {
    AL_VOLATILE_SESSION_LIMITS,
    type ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import {
    toAdmissionCommands,
    toObserveCommand,
    toResultAssertion,
    toSendCommand
} from '../../alm-conformance-message-commands.ts';
import { toOrderingKey } from '../../alm-conformance-ordering-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toStatsCommand } from '../../alm-conformance-session-commands.ts';
import {
    toBoundReconnectCommands,
    toBoundRefusalCommands,
    toLimitRefusalFacts
} from './volatile-bound-commands.ts';

/** Two live tracks fill the lowered bound; the other limits keep their constants, so tracks alone decide. */
const TRACK_LIMITS: ALVolatileSessionLimits = { ...AL_VOLATILE_SESSION_LIMITS, maxTracks: 2 };
const ADMITTED_INDEXES = [1, 2] as const;
const REFUSED_INDEX = 3;

/**
 * D179: the outbound volatile bound counts the ordering tracks of the session's own ordered sends on its volatile lane.
 * Since D529 an ordered room send is minted on the durable lane and a peer send carries no ordering, so the one browser
 * send the bound judges is an ordered world broadcast, which an RTC page cannot send: the cell runs over `ws` and
 * `rtc-with-ws-fallback`, which both send it over WS. The sender reconnects with two tracks allowed and sends three, each
 * the first of its own ordering key: the third would open a third track and ends `rejected` with `refused`/`capacity`,
 * limit `tracks` and no carrier attempt. The sender reads its ledger right after the refusal, inside the admitted
 * sends' ttl, so both tracks are still counted and the reading sits at the bound. A world broadcast names no logical
 * recipient, so it asks for no receipt and the first two end `transport-accepted`. The receiver listens on the room's
 * topic, not the world's, so it only completes the room the sender joins.
 */
export const capacityTracks: AlmConformanceScenarioDefinition = {
    scenarioId: 'capacity-tracks',
    scenarioKey: 'capacity-tracks',
    tags: FULL_TAGS,
    carriers: ['ws', 'rtc-with-ws-fallback'],
    roles: ['sender', 'receiver'],
    laneFamily: 'addressed',
    toSenderCommands: toCapacityTracksSenderCommands,
    toRecipientCommands: () => []
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
        ...ADMITTED_INDEXES.flatMap((index) => toTransportAcceptedCommands(sender, index)),
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

/** A receipt-less send ends at the transport's acceptance. */
function toTransportAcceptedCommands(
    sender: AlmConformanceStepInput,
    index: number
): readonly RallarBlackBoxTestCommand[] {
    return [
        toObserveCommand({ ...sender, index, state: 'transport-accepted' }),
        toResultAssertion({
            step: sender,
            name: `assert-transport-accepted-${index}`,
            resultName: `observe-transport-accepted-${index}`,
            field: 'state',
            operator: 'equals',
            expected: 'transport-accepted'
        })
    ];
}

/** The first ordered world broadcast of an ordering key of its own, so each send opens one track. */
function toTrackOpeningSend(sender: AlmConformanceStepInput, index: number): RallarBlackBoxTestCommand {
    return toSendCommand({
        ...sender,
        index,
        payload: { marker: sender.scenarioId, carrier: sender.input.carrier, index },
        delivery: {
            scope: 'world',
            ack: 'none',
            reliability: 'at-least-once',
            ttlMs: NON_EXPIRING_TTL_MS,
            commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS,
            orderingKey: `${toOrderingKey(sender)}-${index}`,
            seq: 1
        }
    });
}
