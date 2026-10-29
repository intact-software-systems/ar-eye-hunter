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

const PACED_LATEST_PUBLICATION: ALPublicationPolicy = {
    cadenceMs: 500,
    retainNewest: 1,
    drain: { messages: 8, bytes: PUBLICATION_DRAIN_BYTES }
};
const LAST_SEND = 5;
const DISPLACED_INDEXES = [1, 2, 3, 4] as const;
/** Several cadences, so a displaced value that still reached a carrier would arrive inside it. */
const NO_FURTHER_ARRIVAL_WINDOW_MS = 3_000;

/**
 * D469 with one value retained per stream: send 0 stages on an idle lane and is admitted at once; each of sends 1 to 4
 * is displaced by the one after it before the lane's next opportunity, which admits send 5.
 */
export const pacedLatest: AlmConformanceScenarioDefinition = {
    scenarioId: 'paced-latest',
    scenarioKey: 'paced-latest',
    tags: SMOKE_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: (sender) => [
        ...toPublicationSendCommands({ step: sender, burst: LAST_SEND, publication: PACED_LATEST_PUBLICATION }),
        ...DISPLACED_INDEXES.flatMap((index) =>
            toPublicationVerdictCommands({ step: sender, index, state: 'superseded', facts: [NEVER_ATTEMPTED] })
        ),
        ...toPublicationVerdictCommands({ step: sender, index: LAST_SEND, state: 'transport-accepted', facts: [] })
    ],
    toRecipientCommands: (receiver) => [
        toArrivalCountCommand(receiver, 1),
        toSeqArrivalWait(receiver, 0, true),
        toSeqArrivalWait(receiver, LAST_SEND, false),
        toArrivalCountCommand(receiver, 2),
        toSeqArrivalWait(receiver, LAST_SEND, true),
        toNoFurtherArrivalCommand(receiver, 3, NO_FURTHER_ARRIVAL_WINDOW_MS)
    ]
};
