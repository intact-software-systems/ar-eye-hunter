import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';

import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import {
    SMOKE_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import {
    PUBLICATION_CADENCE_MS,
    PUBLICATION_DRAIN_BYTES,
    toPublicationLeadCommands,
    toPublicationSendCommand,
    toPublicationTtlMs,
    toPublicationVerdictCommands
} from './publication-commands.ts';
import {
    toArrivalCountCommand,
    toNoFurtherArrivalCommand,
    toSeqArrivalWait,
    toSeqNotYetWait
} from './publication-receiver-commands.ts';

const PACED_FAIRNESS_PUBLICATION: ALPublicationPolicy = {
    cadenceMs: PUBLICATION_CADENCE_MS,
    retainNewest: 2,
    drain: { messages: 1, bytes: PUBLICATION_DRAIN_BYTES }
};
/** Sends 1 and 2 on the lead's stream, then send 3 on a second stream; the third opportunity carries the last. */
const PACED_FAIRNESS_SENDS = [[1, undefined], [2, undefined], [3, 'b']] as const;
/** The order the lane's rotating cursor admits them in, one per opportunity: each seq with the arrival before it. */
const ADMISSIONS = [[1, 0], [3, 1], [2, 3]] as const;
const LAST_OPPORTUNITY = ADMISSIONS.length;

/**
 * D478: send 0 is admitted at once; sends 1 and 2 stage on its stream and send 3 on a second, within one cadence. Each
 * opportunity drains one value and the next starts at the stream after the one it served, so the streams alternate:
 * send 1, then send 3, then send 2, where a selection that always started at the first stream would admit send 2
 * before send 3.
 */
export const pacedFairness: AlmConformanceScenarioDefinition = {
    scenarioId: 'paced-fairness',
    scenarioKey: 'paced-fairness',
    tags: SMOKE_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toPacedFairnessSenderCommands,
    toRecipientCommands: (receiver) => [
        toArrivalCountCommand(receiver, 1, 0),
        toSeqArrivalWait(receiver, 0),
        ...ADMISSIONS.flatMap(([seq, afterSeq], index) => [
            toSeqNotYetWait(receiver, seq, afterSeq),
            toArrivalCountCommand(receiver, index + 2, index + 1),
            toSeqArrivalWait(receiver, seq)
        ]),
        toNoFurtherArrivalCommand(receiver, ADMISSIONS.length + 2)
    ]
};

function toPacedFairnessSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toPublicationLeadCommands(sender, PACED_FAIRNESS_PUBLICATION, undefined),
        ...PACED_FAIRNESS_SENDS.map(([index, stream]) =>
            toPublicationSendCommand({
                step: sender,
                index,
                publication: PACED_FAIRNESS_PUBLICATION,
                ttlMs: toPublicationTtlMs(LAST_OPPORTUNITY),
                stream,
                recipientPeer: undefined
            })
        ),
        ...ADMISSIONS.flatMap(([index]) =>
            toPublicationVerdictCommands({ step: sender, index, state: 'transport-accepted', facts: [] })
        )
    ];
}
