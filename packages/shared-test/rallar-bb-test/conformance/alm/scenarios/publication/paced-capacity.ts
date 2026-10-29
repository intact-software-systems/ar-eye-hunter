import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';
import {
    AL_PUBLICATION_STAGE_LIMITS,
    type ALPublicationStageLimits
} from '@shared/al-contracts/publication/al-publication-stage-limits.ts';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesReceivedCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import { CONNECT_READINESS_TIMEOUT_MS, RESPONSE_MARGIN_MS } from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import {
    SMOKE_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toLimitsReconnectCommands } from '../../to-limits-reconnect-commands.ts';
import { toPauseCommand } from '../../to-pause-command.ts';
import {
    NEVER_ATTEMPTED,
    PUBLICATION_CADENCE_MS,
    PUBLICATION_DRAIN_BYTES,
    toPublicationSendCommands,
    toPublicationTtlMs,
    toPublicationVerdictCommands
} from './publication-commands.ts';
import {
    toArrivalCountCommand,
    toNoFurtherArrivalCommand,
    toSeqArrivalWait,
    toSeqNotYetWait
} from './publication-receiver-commands.ts';

/** Two staged values fill the lowered bound; the stream and byte limits keep their constants, so values alone decide. */
const PACED_CAPACITY_LIMITS: ALPublicationStageLimits = { ...AL_PUBLICATION_STAGE_LIMITS, maxStagedValues: 2 };
const PACED_CAPACITY_PUBLICATION: ALPublicationPolicy = {
    cadenceMs: PUBLICATION_CADENCE_MS,
    retainNewest: 1,
    drain: { messages: 8, bytes: PUBLICATION_DRAIN_BYTES }
};
const ADMITTED_INDEXES = [1, 2] as const;
const REFUSED_INDEX = 3;

/**
 * D477: the sender reconnects with two staged values allowed; send 0 is admitted at once, so the stage holds nothing
 * when sends 1 to 3 stage, each on a stream of its own within one cadence: the third would pass the bound and ends
 * `rejected` with `refused`/`capacity`, limit `staged-values` and no carrier attempt, and the lane's next opportunity
 * admits the first two. The sender restores the product's limits after.
 */
export const pacedCapacity: AlmConformanceScenarioDefinition = {
    scenarioId: 'paced-capacity',
    scenarioKey: 'paced-capacity',
    tags: SMOKE_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toPacedCapacitySenderCommands,
    toRecipientCommands: (receiver) => [
        toReconnectedLeadArrivalCommand(receiver),
        toSeqArrivalWait(receiver, 0),
        toSeqNotYetWait(receiver, 1, 0),
        toArrivalCountCommand(receiver, ADMITTED_INDEXES.length + 1, 1),
        ...ADMITTED_INDEXES.map((seq) => toSeqArrivalWait(receiver, seq)),
        toNoFurtherArrivalCommand(receiver, ADMITTED_INDEXES.length + 2)
    ]
};

function toPacedCapacitySenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toLimitsReconnectCommands(sender, 'lowered', { almPublicationLimits: { ...PACED_CAPACITY_LIMITS } }),
        ...toPublicationSendCommands({
            step: sender,
            burst: REFUSED_INDEX,
            publication: PACED_CAPACITY_PUBLICATION,
            ttlMs: toPublicationTtlMs(1),
            streams: 'one-per-send'
        }),
        ...toPublicationVerdictCommands({
            step: sender,
            index: REFUSED_INDEX,
            state: 'rejected',
            facts: [
                ['failure.kind', 'refused'],
                ['failure.reason', 'capacity'],
                ['failure.limit', 'staged-values'],
                NEVER_ATTEMPTED
            ]
        }),
        ...ADMITTED_INDEXES.flatMap((index) =>
            toPublicationVerdictCommands({ step: sender, index, state: 'transport-accepted', facts: [] })
        ),
        // A send without a receipt is `transport-accepted` once its socket takes it: the local WS lane lost the second
        // admitted value to a restoring close 2 ms later, before the relay forwarded it.
        toPauseCommand(sender, 'delivery-settles', PUBLICATION_CADENCE_MS),
        ...toLimitsReconnectCommands(sender, 'restored', {})
    ];
}

/** The receiver's window opens before the sender's reconnect, so it also owns one RTC readiness budget. */
function toReconnectedLeadArrivalCommand(receiver: AlmConformanceStepInput): RallarBlackBoxTestMessagesReceivedCommand {
    const lead = toArrivalCountCommand(receiver, 1, 0);
    const windowMs = lead.windowMs + CONNECT_READINESS_TIMEOUT_MS;
    return { ...lead, windowMs, timeoutMs: windowMs + RESPONSE_MARGIN_MS };
}
