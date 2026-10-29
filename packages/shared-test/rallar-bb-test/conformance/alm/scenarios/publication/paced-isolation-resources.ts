import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { SMOKE_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import {
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

const PACED_ISOLATION_PUBLICATION: ALPublicationPolicy = {
    cadenceMs: PUBLICATION_CADENCE_MS,
    retainNewest: 1,
    drain: { messages: 8, bytes: PUBLICATION_DRAIN_BYTES }
};
const ISOLATED_INDEXES = [1, 2] as const;

/**
 * D467: send 0 is admitted at once; sends 1 and 2 stage within one cadence on two resources of the one channel, each its
 * own stream, so one value retained per stream displaces neither: the lane's next opportunity admits both.
 */
export const pacedIsolationResources: AlmConformanceScenarioDefinition = {
    scenarioId: 'paced-isolation-resources',
    scenarioKey: 'paced-isolation-resources',
    tags: SMOKE_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: (sender) => [
        ...toPublicationSendCommands({
            step: sender,
            burst: ISOLATED_INDEXES.length,
            publication: PACED_ISOLATION_PUBLICATION,
            ttlMs: toPublicationTtlMs(1),
            streams: 'one-per-send'
        }),
        ...ISOLATED_INDEXES.flatMap((index) =>
            toPublicationVerdictCommands({ step: sender, index, state: 'transport-accepted', facts: [] })
        )
    ],
    toRecipientCommands: (receiver) => [
        toArrivalCountCommand(receiver, 1, 0),
        toSeqArrivalWait(receiver, 0),
        toSeqNotYetWait(receiver, 1, 0),
        toArrivalCountCommand(receiver, ISOLATED_INDEXES.length + 1, 1),
        ...ISOLATED_INDEXES.map((seq) => toSeqArrivalWait(receiver, seq)),
        toNoFurtherArrivalCommand(receiver, ISOLATED_INDEXES.length + 2)
    ]
};
