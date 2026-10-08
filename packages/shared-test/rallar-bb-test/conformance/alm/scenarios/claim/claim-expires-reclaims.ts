import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import type { AlmConformanceCarrier } from '../../alm-conformance-carriers.ts';
import { toAdmissionCommands } from '../../alm-conformance-message-commands.ts';
import {
    toAudienceSendCommands,
    toReceiptReadCommands,
    type AlmConformanceReceiptRoles
} from '../../alm-conformance-receipt-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toClaim, toClaimExpiryWait, toClaimSendCommand } from './claim-commands.ts';

/** The claim's lease is its message's lifetime; the cell runs where the WS server holds the claim. */
const CLAIM_EXPIRES_CARRIERS: readonly AlmConformanceCarrier[] = ['ws'];
const SHORT_CLAIM_TTL_MS = 3_000;
/** Recipient-b's hold starts once the short claim has arrived, so it outlasts that claim's lifetime. */
const CLAIM_EXPIRY_WAIT_MS = 3_500;
const SENDER_AND_RECEIVER_CONFIRMED: AlmConformanceReceiptRoles = {
    confirmed: ['sender', 'receiver'],
    unconfirmed: []
};

/**
 * The sender claims the cell's resource with a short-lived room send. Recipient-b receives it, holds past its
 * lifetime and claims the same resource from its own session: the expired claim frees the key, so the server admits
 * and delivers the reclaim to the sender and the receiver, and its receipt ends acknowledged.
 */
export const claimExpiresReclaims: AlmConformanceScenarioDefinition = {
    scenarioId: 'claim-expires-reclaims',
    scenarioKey: 'claim-expires-reclaims',
    tags: FULL_TAGS,
    carriers: CLAIM_EXPIRES_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    toSenderCommands: (sender) => [
        ...toAudienceSendCommands({
            sender,
            ttlMs: SHORT_CLAIM_TTL_MS,
            ack: 'all-logical-recipients',
            claim: toClaim(sender)
        }),
        toReceivedCommand({ ...sender, index: 1, count: 1, absent: false })
    ],
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver'
            ? [
                toReceivedCommand({ ...recipient, index: 1, count: 2, absent: false }),
                toReceivedCommand({ ...recipient, index: 2, count: 3, absent: true })
            ]
            : toReclaimCommands(recipient)
};

/** The reclaim's own window proves it never reaches its origin before the origin reads its receipt. */
function toReclaimCommands(reclaimer: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toReceivedCommand({ ...reclaimer, index: 1, count: 1, absent: false }),
        toClaimExpiryWait(reclaimer, CLAIM_EXPIRY_WAIT_MS),
        toClaimSendCommand(reclaimer, NON_EXPIRING_TTL_MS),
        ...toAdmissionCommands({ ...reclaimer, index: 1 }),
        toReceivedCommand({ ...reclaimer, index: 2, count: 2, absent: true }),
        ...toReceiptReadCommands(reclaimer, {
            roles: SENDER_AND_RECEIVER_CONFIRMED,
            ending: 'acknowledged',
            mode: 'receiver'
        })
    ];
}
