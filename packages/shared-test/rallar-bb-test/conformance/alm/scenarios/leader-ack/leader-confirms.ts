import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toAdmissionCommands } from '../../alm-conformance-message-commands.ts';
import {
    toReceiptWindowCommands,
    toServerReceiptCommands,
    type AlmConformanceReceiptRoles
} from '../../alm-conformance-receipt-commands.ts';
import { toReceivedCommand, toSingleArrivalReceiverCommands } from '../../alm-conformance-receiver-commands.ts';
import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import {
    toDirectorAppointCommand,
    toDirectorResignCommand,
    toLeaderActivityWait,
    toLeaderSendCommand
} from './leader-ack-commands.ts';

const RECEIVER_CONFIRMED: AlmConformanceReceiptRoles = { confirmed: ['receiver'], unconfirmed: [] };

/**
 * The receiver appoints itself the room's director; once the sender's own snapshot reads it active, the sender's room
 * send asks for the leader. The receiver receives it once and confirms it; recipient-b, in the room, never receives
 * it. The receipt expects the receiver alone, in the leader mode. The receiver resigns after its window, so the next
 * cell finds the room without a director.
 */
export const leaderConfirms: AlmConformanceScenarioDefinition = {
    scenarioId: 'leader-confirms',
    scenarioKey: 'leader-confirms',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    toReceiptRoles: () => RECEIVER_CONFIRMED,
    toSenderCommands: (sender) => [
        toLeaderActivityWait(sender, true),
        toLeaderSendCommand(sender, undefined),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        ...toServerReceiptCommands(sender),
        ...toReceiptWindowCommands(sender, { roles: RECEIVER_CONFIRMED, ending: 'acknowledged', mode: 'leader' })
    ],
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver'
            ? [
                toDirectorAppointCommand(recipient),
                ...toSingleArrivalReceiverCommands(recipient),
                toDirectorResignCommand(recipient)
            ]
            : [toReceivedCommand({ ...recipient, index: 1, count: 1, absent: true })]
};
