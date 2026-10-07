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

const SIBLING_CONFIRMED: AlmConformanceReceiptRoles = { confirmed: ['sibling'], unconfirmed: [] };

/**
 * The sender addresses its own principal in the room. The principal's other live session, the sibling, receives the
 * send once and confirms it; the receiver, another principal's session in the same room, never receives it. The
 * receipt expects the sibling alone, so the audience the send froze is the principal's sessions minus the origin.
 */
export const principalDelivery: AlmConformanceScenarioDefinition = {
    scenarioId: 'principal-delivery',
    scenarioKey: 'principal-delivery',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES,
    laneFamily: 'same-principal',
    toReceiptRoles: () => SIBLING_CONFIRMED,
    toSenderCommands: (sender) => [
        ...toAudienceSendCommands({
            sender,
            ttlMs: NON_EXPIRING_TTL_MS,
            audience: { scope: 'principal', principalId: '{auth.clientId}' }
        }),
        ...toServerReceiptCommands(sender),
        ...toReceiptWindowCommands(sender, SIBLING_CONFIRMED, 'acknowledged')
    ],
    toRecipientCommands: (recipient) =>
        recipient.role === 'sibling'
            ? toSingleArrivalReceiverCommands(recipient)
            : [toReceivedCommand({ ...recipient, index: 1, count: 1, absent: true })]
};
