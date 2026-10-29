import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { SMOKE_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import {
    NEVER_ATTEMPTED,
    PUBLICATION_CADENCE_MS,
    PUBLICATION_DRAIN_BYTES,
    toPublicationSendCommands,
    toPublicationVerdictCommands
} from './publication-commands.ts';
import {
    toArrivalCountCommand,
    toNoFurtherArrivalCommand,
    toSeqArrivalWait
} from './publication-receiver-commands.ts';

const PACED_EXPIRY_PUBLICATION: ALPublicationPolicy = {
    cadenceMs: PUBLICATION_CADENCE_MS,
    retainNewest: 1,
    drain: { messages: 8, bytes: PUBLICATION_DRAIN_BYTES }
};
/** Far shorter than the cadence, so send 1's deadline passes while it waits for its opportunity. */
const PACED_EXPIRY_TTL_MS = 100;

/** D468: send 0 is admitted at once; send 1 expires staged, before any carrier attempt. */
export const pacedExpiry: AlmConformanceScenarioDefinition = {
    scenarioId: 'paced-expiry',
    scenarioKey: 'paced-expiry',
    tags: SMOKE_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: (sender) => [
        ...toPublicationSendCommands({
            step: sender,
            burst: 1,
            publication: PACED_EXPIRY_PUBLICATION,
            ttlMs: PACED_EXPIRY_TTL_MS,
            streams: 'one'
        }),
        ...toPublicationVerdictCommands({
            step: sender,
            index: 1,
            state: 'expired',
            facts: [['failure.kind', 'expired'], NEVER_ATTEMPTED]
        })
    ],
    toRecipientCommands: (receiver) => [
        toArrivalCountCommand(receiver, 1, 0),
        toSeqArrivalWait(receiver, 0),
        toNoFurtherArrivalCommand(receiver, 2)
    ]
};
