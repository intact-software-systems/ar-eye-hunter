import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { SMOKE_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import {
    toCommandId,
    toScenarioTopicId,
    toScenarioTypeId
} from '../../alm-conformance-step-identities.ts';
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
    toSeqArrivalWait
} from './publication-receiver-commands.ts';

const PACED_NEWEST_N_PUBLICATION: ALPublicationPolicy = {
    cadenceMs: PUBLICATION_CADENCE_MS,
    retainNewest: 3,
    drain: { messages: 2, bytes: PUBLICATION_DRAIN_BYTES }
};
const LAST_SEND = 4;

/**
 * The sender proves three retained values, oldest displacement without an attempt, and a two-value drain with one
 * deferred. Receiver history may omit intermediate values through legal carrier conflation; the latest must arrive.
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
        {
            kind: 'wait',
            commandId: toCommandId(sender, 'two-selected-one-deferred'),
            match: {
                kind: 'diagnostic',
                topic: 'rallar.browser.alm.outbound_diagnostics',
                payloadFields: {
                    'data.kind': 'publication-opportunity',
                    'data.laneKey': `${toScenarioTopicId(sender)}/${toScenarioTypeId(sender)}`,
                    'data.selected': 2,
                    'data.deferred': 1,
                    'data.expired': 0
                }
            },
            timeoutMs: sender.input.deadlineMs
        },
        ...[2, 3, LAST_SEND].flatMap((index) =>
            toPublicationVerdictCommands({ step: sender, index, state: 'transport-accepted', facts: [] })
        )
    ],
    toRecipientCommands: (receiver) => [
        toArrivalCountCommand(receiver, 1, 2),
        toSeqArrivalWait(receiver, LAST_SEND),
        { ...toSeqArrivalWait(receiver, 1), absent: true, timeoutMs: 2 * PUBLICATION_CADENCE_MS },
        toNoFurtherArrivalCommand(receiver, 5)
    ]
};
