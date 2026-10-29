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

const PACED_EXPIRY_PUBLICATION: ALPublicationPolicy = {
    cadenceMs: 1_000,
    retainNewest: 1,
    drain: { messages: 8, bytes: PUBLICATION_DRAIN_BYTES }
};
/** Far shorter than the cadence, so send 1's deadline passes while it waits for its opportunity. */
const PACED_EXPIRY_TTL_MS = 100;
/** Past the second opportunity, which would carry send 1 had it not expired. */
const NO_FURTHER_ARRIVAL_WINDOW_MS = 1_500;

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
            ttlMs: PACED_EXPIRY_TTL_MS
        }),
        ...toPublicationVerdictCommands({
            step: sender,
            index: 1,
            state: 'expired',
            facts: [['failure.kind', 'expired'], NEVER_ATTEMPTED]
        })
    ],
    toRecipientCommands: (receiver) => [
        toArrivalCountCommand(receiver, 1),
        toSeqArrivalWait(receiver, 0, 'arrived'),
        toNoFurtherArrivalCommand(receiver, 2, NO_FURTHER_ARRIVAL_WINDOW_MS)
    ]
};
