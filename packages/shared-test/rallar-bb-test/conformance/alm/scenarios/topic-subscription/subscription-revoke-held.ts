import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_FOUR_ROLE_ROLES } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toPauseCommand } from '../../to-pause-command.ts';
import {
    TOPIC_SUBSCRIPTION_CARRIERS,
    TOPIC_SUBSCRIPTION_SELECTOR,
    toProductSocketCommand,
    toSubscribeCommand,
    toSubscriptionRowsCommand,
    toTokenReadCommand,
    toTopicGrantCommand,
    toUnsubscribeCommands
} from './topic-subscription-commands.ts';
import { toGenerationChangePollCommand } from './topic-subscription-generation-polls.ts';
import { toReadPollCommand } from './topic-subscription-polls.ts';
import {
    toConfirmedCueWait,
    toCueListenCommands,
    toCueSendCommands,
    toCueWait,
    toPublicationWait,
    toPublishCommands,
    toPublishUntilConfirmedCommands,
    toReceiptsCommand
} from './topic-subscription-publications.ts';

/**
 * Covers the sibling's socket close, which follows the probe loop's cue at once, so `publication-1` leaves while that
 * socket is down: a cue the sibling sent itself could be lost with the socket it closes.
 */
const SOCKET_CLOSE_MARGIN_MS = 2_000;

/** Covers the window between the sender's last readiness probe and its receipt reads, so the receipts have settled. */
const RECEIPT_SETTLE_MS = 2_000;

/**
 * The sibling's product socket drops; `publication-1` leaves while it is down, and the receiver then revokes the
 * principal's `subscribe` (it keeps `publish`) and says so; `publication-2` follows. The reopened socket's
 * re-assertion is refused. The receiver receives both, the sibling neither, and neither receipt confirms the sibling.
 * Whether `publication-1`'s expected set names the sibling depends on when the server closes the dropped socket's room
 * presence, so the lane records it; the deterministic hold proof is the server's own test. A reopened socket's session
 * holds no room presence, so the sibling sends nothing after it drops.
 */
export const subscriptionRevokeHeld: AlmConformanceScenarioDefinition = {
    scenarioId: 'subscription-revoke-held',
    scenarioKey: 'subscription-revoke-held',
    tags: FULL_TAGS,
    carriers: TOPIC_SUBSCRIPTION_CARRIERS,
    roles: ALM_CONFORMANCE_FOUR_ROLE_ROLES,
    laneFamily: 'four-role',
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    toSenderCommands: (producer) => producer.role === 'sender' ? toPublisherCommands(producer) : [],
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver' ? toOwnerCommands(recipient) : toDroppedSubscriberCommands(recipient)
};

/** The sender reads both receipts after the run's last step; the lane joins them to the sibling's session. */
const SUBSCRIPTION_REVOKE_HELD_PUBLICATIONS = ['publication-1', 'publication-2'] as const;

function toOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toTopicGrantCommand({ step: owner, operation: 'grant', grantee: 'receiver', publish: false, subscribe: true }),
        toSubscribeCommand(owner, 'receiver'),
        toTopicGrantCommand({ step: owner, operation: 'grant', grantee: 'sender', publish: true, subscribe: true }),
        toPublicationWait(owner, 'publication-1', false),
        toTopicGrantCommand({ step: owner, operation: 'revoke', grantee: 'sender', publish: false, subscribe: true }),
        ...toCueSendCommands(owner, 'revoked'),
        toPublicationWait(owner, 'publication-2', false),
        ...toUnsubscribeCommands(owner, 'receiver')
    ];
}

/**
 * The revoke deletes the sibling's row, which its own read observes while its socket is down; only then does it
 * reopen, so its re-assertion meets the revoked grant.
 */
function toDroppedSubscriberCommands(sibling: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    if (sibling.role !== 'sibling') {
        return [];
    }
    return [
        ...toCueListenCommands(sibling),
        toSubscribeCommand(sibling, 'sibling'),
        toTokenReadCommand(sibling, 'tokens-before-drop'),
        toConfirmedCueWait(sibling, 'probe-two-subscribers'),
        toProductSocketCommand(sibling, 'close'),
        toReadPollCommand({
            step: sibling,
            name: 'rows-revoked',
            read: (readName) => toSubscriptionRowsCommand(sibling, readName),
            facts: [{ name: 'rows-revoked-empty', field: 'body.subscriptions', operator: 'length', expected: 0 }]
        }),
        toProductSocketCommand(sibling, 'reopen'),
        toGenerationChangePollCommand({
            step: sibling,
            name: 'reasserted',
            before: 'tokens-before-drop',
            status: 'refused'
        }),
        toPublicationWait(sibling, 'publication-1', true),
        toPublicationWait(sibling, 'publication-2', true)
    ];
}

function toPublisherCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(sender),
        ...toPublishUntilConfirmedCommands({
            step: sender,
            name: 'probe-two-subscribers',
            confirmations: 2,
            kind: 'probe'
        }),
        toPauseCommand(sender, 'socket-close-margin', SOCKET_CLOSE_MARGIN_MS),
        ...toPublishCommands(sender, 'publication-1'),
        toCueWait(sender, 'revoked'),
        ...toPublishCommands(sender, 'publication-2'),
        toPauseCommand(sender, 'receipt-settle', RECEIPT_SETTLE_MS),
        ...SUBSCRIPTION_REVOKE_HELD_PUBLICATIONS.map((publication) => toReceiptsCommand(sender, publication))
    ];
}
