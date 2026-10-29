import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { SMOKE_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import {
    NEVER_ATTEMPTED,
    PUBLICATION_DRAIN_BYTES,
    toArrivalCountCommand,
    toNoFurtherArrivalCommand,
    toPublicationSendCommands,
    toPublicationVerdictCommands,
    toSeqArrivalWait
} from './publication-commands.ts';

const PACED_NEWEST_N_PUBLICATION: ALPublicationPolicy = {
    cadenceMs: 500,
    retainNewest: 3,
    drain: { messages: 2, bytes: PUBLICATION_DRAIN_BYTES }
};
const LAST_SEND = 4;
/**
 * The last send waits for the third opportunity, two cadences after the first. The live channel's own 1 000 ms
 * lifetime would leave it only its staging lead over that opportunity, so a late engine pass would expire it; one more
 * cadence keeps the cell about selection, not about the lifetime.
 */
const PACED_NEWEST_N_TTL_MS = 1_500;
const NO_FURTHER_ARRIVAL_WINDOW_MS = 3_000;

/**
 * D469 with three values retained and two drained per opportunity: send 0 is admitted at once; send 4 displaces send
 * 1, the oldest staged; the second opportunity admits sends 2 and 3, the third opportunity send 4, which is still
 * staged while the sender observes it.
 */
export const pacedNewestN: AlmConformanceScenarioDefinition = {
    scenarioId: 'paced-newest-n',
    scenarioKey: 'paced-newest-n',
    tags: SMOKE_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: (sender) => [
        ...toPublicationSendCommands({
            step: sender,
            burst: LAST_SEND,
            publication: PACED_NEWEST_N_PUBLICATION,
            ttlMs: PACED_NEWEST_N_TTL_MS
        }),
        ...toPublicationVerdictCommands({ step: sender, index: LAST_SEND, state: 'staged', facts: [] }),
        ...toPublicationVerdictCommands({ step: sender, index: 1, state: 'superseded', facts: [NEVER_ATTEMPTED] }),
        ...[2, 3, LAST_SEND].flatMap((index) =>
            toPublicationVerdictCommands({ step: sender, index, state: 'transport-accepted', facts: [] })
        )
    ],
    toRecipientCommands: (receiver) => [
        toArrivalCountCommand(receiver, 1),
        toSeqArrivalWait(receiver, 0, true),
        toSeqArrivalWait(receiver, 2, false),
        toArrivalCountCommand(receiver, 3),
        toSeqArrivalWait(receiver, 2, true),
        toSeqArrivalWait(receiver, 3, true),
        toSeqArrivalWait(receiver, LAST_SEND, false),
        toArrivalCountCommand(receiver, 4),
        toSeqArrivalWait(receiver, LAST_SEND, true),
        toNoFurtherArrivalCommand(receiver, 5, NO_FURTHER_ARRIVAL_WINDOW_MS)
    ]
};
