import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { SMOKE_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import {
    NEVER_ATTEMPTED,
    PUBLICATION_CADENCE_MS,
    PUBLICATION_DRAIN_BYTES,
    STAGE_DISPLACED,
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

const PACED_NEWEST_N_PUBLICATION: ALPublicationPolicy = {
    cadenceMs: PUBLICATION_CADENCE_MS,
    retainNewest: 3,
    drain: { messages: 2, bytes: PUBLICATION_DRAIN_BYTES }
};
const LAST_SEND = 4;

/**
 * D469 with three values retained and two drained per opportunity: send 0 is admitted at once; send 4 displaces send
 * 1, the oldest staged; the second opportunity admits sends 2 and 3, the third opportunity send 4, which is still
 * staged while the sender observes it. The cell proves the stage's selection, not carrier history: sends 2 and 3 share
 * their stream's latest-wins key, so on a backpressured carrier send 3's admission could conflate send 2 (D467), and
 * the cell assumes an unloaded one.
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
            ttlMs: toPublicationTtlMs(2),
            streams: 'one'
        }),
        ...toPublicationVerdictCommands({ step: sender, index: LAST_SEND, state: 'staged', facts: [] }),
        ...toPublicationVerdictCommands({
            step: sender,
            index: 1,
            state: 'superseded',
            facts: [NEVER_ATTEMPTED, STAGE_DISPLACED]
        }),
        ...[2, 3, LAST_SEND].flatMap((index) =>
            toPublicationVerdictCommands({ step: sender, index, state: 'transport-accepted', facts: [] })
        )
    ],
    toRecipientCommands: (receiver) => [
        toArrivalCountCommand(receiver, 1, 0),
        toSeqArrivalWait(receiver, 0),
        toSeqNotYetWait(receiver, 2, 0),
        toArrivalCountCommand(receiver, 3, 1),
        toSeqArrivalWait(receiver, 2),
        toSeqArrivalWait(receiver, 3),
        toSeqNotYetWait(receiver, LAST_SEND, 3),
        toArrivalCountCommand(receiver, 4, 2),
        toSeqArrivalWait(receiver, LAST_SEND),
        toNoFurtherArrivalCommand(receiver, 5)
    ]
};
