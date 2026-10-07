import { NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import {
    toAudienceSendCommands,
    toReceiptWindowCommands,
    toServerReceiptCommands,
    type AlmConformanceReceiptRoles
} from '../../alm-conformance-receipt-commands.ts';
import { toReceivedCommand, toSingleArrivalReceiverCommands } from '../../alm-conformance-receiver-commands.ts';
import { ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES } from '../../alm-conformance-roles.ts';
import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';

const RECEIVER_CONFIRMED: AlmConformanceReceiptRoles = { confirmed: ['receiver'], unconfirmed: [] };

/**
 * The sender lists one of the room's three sessions, the receiver's. The receiver receives the send once and
 * confirms it; the sibling, though a session of the sender's own principal, is not on the list and never receives
 * it. The receipt expects the receiver alone.
 */
export const fixedListDelivery: AlmConformanceScenarioDefinition = {
    scenarioId: 'fixed-list-delivery',
    scenarioKey: 'fixed-list-delivery',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES,
    laneFamily: 'same-principal',
    toReceiptRoles: () => RECEIVER_CONFIRMED,
    toSenderCommands: (sender) => [
        ...toAudienceSendCommands({ sender, ttlMs: NON_EXPIRING_TTL_MS, audience: { recipientPeer: 'receiver' } }),
        ...toServerReceiptCommands(sender),
        ...toReceiptWindowCommands(sender, RECEIVER_CONFIRMED, 'acknowledged')
    ],
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver'
            ? toSingleArrivalReceiverCommands(recipient)
            : [toReceivedCommand({ ...recipient, index: 1, count: 1, absent: true })]
};
