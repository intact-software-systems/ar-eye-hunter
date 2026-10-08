import { NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import {
    toAudienceSendCommands,
    toReceiptWindowCommands,
    toServerReceiptCommands,
    type AlmConformanceReceiptRoles
} from '../../alm-conformance-receipt-commands.ts';
import { toReceivedCommand, toSingleArrivalReceiverCommands } from '../../alm-conformance-receiver-commands.ts';
import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import {
    CLAIM_WS_ROUTE_CARRIERS,
    toClaim,
    toClaimRouteCommands,
    toClaimSendCommand,
    toHeldByOtherVerdictCommands
} from './claim-commands.ts';

const BOTH_CONFIRMED: AlmConformanceReceiptRoles = { confirmed: ['receiver', 'recipient-b'], unconfirmed: [] };

/**
 * The sender claims the cell's resource with a room send over WS that both recipients receive once and confirm.
 * Recipient-b, once it has received it, claims the same resource from its own session while the sender's claim lives:
 * the trusted server NACKs it `held-by-other` and nobody receives it, which the receiver's second window and the
 * sender's own window prove. Recipient-b's closing window keeps its page until its ACK of the sender's claim has left.
 */
export const claimFirstWins: AlmConformanceScenarioDefinition = {
    scenarioId: 'claim-first-wins',
    scenarioKey: 'claim-first-wins',
    tags: FULL_TAGS,
    carriers: CLAIM_WS_ROUTE_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    toReceiptRoles: () => BOTH_CONFIRMED,
    toSenderCommands: (sender) => [
        ...toAudienceSendCommands({
            sender,
            ttlMs: NON_EXPIRING_TTL_MS,
            ack: 'all-logical-recipients',
            claim: toClaim(sender)
        }),
        ...toServerReceiptCommands(sender),
        ...toReceiptWindowCommands(sender, { roles: BOTH_CONFIRMED, ending: 'acknowledged', mode: 'receiver' }),
        ...toClaimRouteCommands(sender)
    ],
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver' ? toSingleArrivalReceiverCommands(recipient) : [
            toReceivedCommand({ ...recipient, index: 1, count: 1, absent: false }),
            toClaimSendCommand(recipient, NON_EXPIRING_TTL_MS),
            ...toHeldByOtherVerdictCommands(recipient),
            toReceivedCommand({ ...recipient, index: 2, count: 2, absent: true })
        ]
};
