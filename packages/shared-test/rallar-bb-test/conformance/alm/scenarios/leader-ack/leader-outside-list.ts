import { NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import type { AlmConformanceCarrier } from '../../alm-conformance-carriers.ts';
import { toAudienceSendCommand } from '../../alm-conformance-receipt-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import {
    toDirectorAppointCommand,
    toDirectorResignCommand,
    toLeaderActivityWait,
    toNoLeaderVerdictCommands
} from './leader-ack-commands.ts';

/** The RTC origin's list refusal is a unit pin; the cell runs where the server judges the named list. */
const LEADER_OUTSIDE_LIST_CARRIERS: readonly AlmConformanceCarrier[] = ['ws'];

/**
 * The receiver appoints itself the room's director; once the sender's own snapshot reads it active, the sender lists
 * recipient-b alone and asks for the leader. The list leaves the leader out, so the send ends rejected, refused
 * `no-leader`, and neither recipient receives it. The receiver resigns after its window.
 */
export const leaderOutsideList: AlmConformanceScenarioDefinition = {
    scenarioId: 'leader-outside-list',
    scenarioKey: 'leader-outside-list',
    tags: FULL_TAGS,
    carriers: LEADER_OUTSIDE_LIST_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    toSenderCommands: (sender) => [
        toLeaderActivityWait(sender, true),
        toAudienceSendCommand({
            sender,
            ttlMs: NON_EXPIRING_TTL_MS,
            ack: 'group-leader',
            audience: { recipientPeer: 'recipient-b' }
        }),
        ...toNoLeaderVerdictCommands(sender)
    ],
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver'
            ? [
                toDirectorAppointCommand(recipient),
                toReceivedCommand({ ...recipient, index: 1, count: 1, absent: true }),
                toDirectorResignCommand(recipient)
            ]
            : [toReceivedCommand({ ...recipient, index: 1, count: 1, absent: true })]
};
