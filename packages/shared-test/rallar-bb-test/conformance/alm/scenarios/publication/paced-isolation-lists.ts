import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';

import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import {
    SMOKE_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import {
    toDirectorAppointCommand,
    toDirectorResignCommand,
    toLeaderActivityWait
} from '../leader-ack/leader-ack-commands.ts';
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

const PACED_ISOLATION_LISTS_PUBLICATION: ALPublicationPolicy = {
    cadenceMs: PUBLICATION_CADENCE_MS,
    retainNewest: 1,
    drain: { messages: 8, bytes: PUBLICATION_DRAIN_BYTES }
};
/** Send 1 lists the receiver, as the lead does; send 2, staged after it, lists recipient-b. */
const LISTED_SENDS = [[1, 'receiver'], [2, 'recipient-b']] as const;

/**
 * D467: a fixed list is part of the stream. The receiver leads the room, so `receiver` names it among two sessions of
 * other principals; send 0 lists it and is admitted at once. Within one cadence send 1 lists the receiver and send 2,
 * on the same resource, lists recipient-b: one value retained per stream, so had the lists shared a stream send 2
 * would have displaced send 1. The next opportunity admits both, and each recipient receives only its own values.
 */
export const pacedIsolationLists: AlmConformanceScenarioDefinition = {
    scenarioId: 'paced-isolation-lists',
    scenarioKey: 'paced-isolation-lists',
    tags: SMOKE_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    toSenderCommands: toPacedIsolationListsSenderCommands,
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver'
            ? [
                toDirectorAppointCommand(recipient),
                toArrivalCountCommand(recipient, 1, 0),
                toSeqArrivalWait(recipient, 0),
                toSeqNotYetWait(recipient, 1, 0),
                toArrivalCountCommand(recipient, 2, 1),
                toSeqArrivalWait(recipient, 1),
                toNoFurtherArrivalCommand(recipient, 3),
                toDirectorResignCommand(recipient)
            ]
            : [
                toArrivalCountCommand(recipient, 1, 1),
                toSeqArrivalWait(recipient, 2),
                toNoFurtherArrivalCommand(recipient, 2)
            ]
};

function toPacedIsolationListsSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toLeaderActivityWait(sender, true),
        ...toPublicationLeadCommands(sender, PACED_ISOLATION_LISTS_PUBLICATION, 'receiver'),
        ...LISTED_SENDS.map(([index, recipientPeer]) =>
            toPublicationSendCommand({
                step: sender,
                index,
                publication: PACED_ISOLATION_LISTS_PUBLICATION,
                ttlMs: toPublicationTtlMs(1),
                stream: undefined,
                recipientPeer
            })
        ),
        ...LISTED_SENDS.flatMap(([index]) =>
            toPublicationVerdictCommands({ step: sender, index, state: 'transport-accepted', facts: [] })
        )
    ];
}
