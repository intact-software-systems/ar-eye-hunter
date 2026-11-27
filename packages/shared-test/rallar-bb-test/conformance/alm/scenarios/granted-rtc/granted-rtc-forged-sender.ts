import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import { ALM_CARRIER_MATRIX } from '../../carrier-matrix/alm-carrier-matrix.ts';
import { resolveAlmCarrierMatrixCellCarriers } from '../../carrier-matrix/resolve-alm-carrier-matrix-cell-carriers.ts';
import { toPrincipalPlaceholder } from '../../resolve-alm-conformance-principals.ts';
import { TOPIC_SUBSCRIPTION_SELECTOR } from '../topic-subscription/topic-subscription-commands.ts';
import { toCueListenCommands, toCueWait } from '../topic-subscription/topic-subscription-publications.ts';
import {
    toInboundRefusalWait,
    toRefusedReceiverCommands,
    toRewritingPublisherCommands
} from './granted-rtc-commands.ts';
import { LISTENER_AND_PUBLISHER_START_GRANTS } from './granted-rtc-start-grants.ts';

/** The code each page the forged frame reaches refuses it with, as the matrix states it. */
const FORGED_SENDER_REFUSAL = ALM_CARRIER_MATRIX['frame-with-forged-sender'].cells.rtc.outcome.code;

/**
 * The sender's page names each frame it signed as recipient-b's: that member's live session and its registered key,
 * so the forged identity is neither the sender nor the receiver. The receiver and recipient-b each find the key and
 * drop the frame for its signature, `unauthorized`; the receiver never delivers it.
 */
export const grantedRtcForgedSender: AlmConformanceScenarioDefinition = {
    scenarioId: 'granted-rtc-forged-sender',
    scenarioKey: 'granted-rtc-forged-sender',
    tags: FULL_TAGS,
    carriers: resolveAlmCarrierMatrixCellCarriers('granted-rtc-forged-sender'),
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    principalRoles: ['receiver', 'sender', 'recipient-b'],
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    startGrants: [...LISTENER_AND_PUBLISHER_START_GRANTS, { grantee: 'recipient-b', publish: false, subscribe: false }],
    toSenderCommands: (sender) =>
        toRewritingPublisherCommands(sender, { forgeSender: { principal: toPrincipalPlaceholder('recipient-b') } }),
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver'
            ? toRefusedReceiverCommands(recipient, FORGED_SENDER_REFUSAL)
            : [
                ...toCueListenCommands(recipient),
                toInboundRefusalWait(recipient, FORGED_SENDER_REFUSAL),
                toCueWait(recipient, 'refused')
            ]
};
