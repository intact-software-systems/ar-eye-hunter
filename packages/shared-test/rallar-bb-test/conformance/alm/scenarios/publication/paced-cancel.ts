import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toCancelCommand } from '../../alm-conformance-message-commands.ts';
import { SMOKE_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
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

const PACED_CANCEL_PUBLICATION: ALPublicationPolicy = {
    cadenceMs: PUBLICATION_CADENCE_MS,
    retainNewest: 2,
    drain: { messages: 8, bytes: PUBLICATION_DRAIN_BYTES }
};
const CANCELLED_INDEX = 1;
const ADMITTED_INDEX = 2;

/**
 * D479: send 0 is admitted at once; sends 1 and 2 stage on its stream, both retained, and the sender cancels send 1
 * before the lane's next opportunity, which admits send 2 alone: send 1 ends `cancelled` with no carrier attempt.
 */
export const pacedCancel: AlmConformanceScenarioDefinition = {
    scenarioId: 'paced-cancel',
    scenarioKey: 'paced-cancel',
    tags: SMOKE_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: (sender) => [
        ...toPublicationSendCommands({
            step: sender,
            burst: ADMITTED_INDEX,
            publication: PACED_CANCEL_PUBLICATION,
            ttlMs: toPublicationTtlMs(1),
            streams: 'one'
        }),
        toCancelCommand({ ...sender, index: CANCELLED_INDEX }),
        ...toPublicationVerdictCommands({
            step: sender,
            index: CANCELLED_INDEX,
            state: 'cancelled',
            facts: [NEVER_ATTEMPTED]
        }),
        ...toPublicationVerdictCommands({ step: sender, index: ADMITTED_INDEX, state: 'transport-accepted', facts: [] })
    ],
    toRecipientCommands: (receiver) => [
        toArrivalCountCommand(receiver, 1, 0),
        toSeqArrivalWait(receiver, 0),
        toSeqNotYetWait(receiver, ADMITTED_INDEX, 0),
        toArrivalCountCommand(receiver, 2, 1),
        toSeqArrivalWait(receiver, ADMITTED_INDEX),
        toNoFurtherArrivalCommand(receiver, 3)
    ]
};
