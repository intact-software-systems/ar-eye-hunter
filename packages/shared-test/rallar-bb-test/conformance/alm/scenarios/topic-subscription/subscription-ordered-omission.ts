import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { toNoGapRepairWaits } from '../../alm-conformance-diagnostic-waits.ts';
import { ALM_CONFORMANCE_FOUR_ROLE_ROLES } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toTopicGrantCommand } from '../../granted-topic/to-topic-grant-command.ts';
import { toPauseCommand } from '../../to-pause-command.ts';
import { GRANT_DELTA_MARGIN_MS } from './topic-subscription-budgets.ts';
import {
    PRODUCERS_START_GRANTS,
    TOPIC_SUBSCRIPTION_CARRIERS,
    TOPIC_SUBSCRIPTION_SELECTOR,
    toSubscribeCommand,
    toUnsubscribeCommands
} from './topic-subscription-commands.ts';
import {
    toOrderedAbsenceWaits,
    toOrderedArrivalWaits,
    toOrderedConfirmedCueWaits,
    toOrderedPositionWaits,
    toOrderedPublishCommands,
    toReadinessProbeCommands
} from './topic-subscription-ordered-publications.ts';
import {
    computeUnelectedOutsideCount,
    toCueListenCommands,
    toCueSendCommands,
    toCueWait
} from './topic-subscription-publications.ts';

/** The sibling's election after the re-grant: a new one, its first ended by the revoke. */
const REGRANTED_SUBSCRIPTION = 'sibling-regranted';

/**
 * An exclusion reads as an omission, never as loss. The sibling elects at the start and receives `p1` and `p2` of
 * each producer's track; the receiver then revokes the sender principal's `subscribe` alone (D492), so the sibling is
 * outside the audience of `p3` and `p4` on every carrier and witnesses neither. Once the receiver grants it back, the
 * sibling elects anew and receives `p5`, whose record names the sibling's prior `2`: an omission, with no gap NACK and
 * no repair. The receiver receives all five; each loop holds the count identity.
 */
export const subscriptionOrderedOmission: AlmConformanceScenarioDefinition = {
    scenarioId: 'subscription-ordered-omission',
    scenarioKey: 'subscription-ordered-omission',
    tags: FULL_TAGS,
    carriers: TOPIC_SUBSCRIPTION_CARRIERS,
    roles: ALM_CONFORMANCE_FOUR_ROLE_ROLES,
    laneFamily: 'four-role',
    principalRoles: ['receiver', 'publisher-b', 'sender'],
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    startGrants: PRODUCERS_START_GRANTS,
    toSenderCommands: toProducerCommands,
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver' ? toOwnerCommands(recipient) : toExcludedSubscriberCommands(recipient)
};

/**
 * Over RTC the other producer, unelected, is frozen into each copy. While the sender principal holds no `subscribe`,
 * neither the sibling nor the sender's page is: the sender's copy freezes in publisher-b alone, publisher-b's nobody.
 */
function toProducerCommands(producer: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const subscribed = { step: producer, confirmations: 2, outsideAudience: computeUnelectedOutsideCount(producer, 1) };
    const revoked = {
        step: producer,
        confirmations: 1,
        outsideAudience: computeUnelectedOutsideCount(producer, producer.role === 'sender' ? 1 : 0)
    };
    return [
        ...toCueListenCommands(producer),
        ...toReadinessProbeCommands(producer, subscribed.confirmations, subscribed.outsideAudience),
        ...toOrderedPublishCommands({ ...subscribed, publication: 1 }),
        ...toOrderedPublishCommands({ ...subscribed, publication: 2 }),
        toCueWait(producer, 'revoked'),
        ...toOrderedPublishCommands({ ...revoked, publication: 3 }),
        ...toOrderedPublishCommands({ ...revoked, publication: 4 }),
        toCueWait(producer, 'resubscribed'),
        ...toOrderedPublishCommands({ ...subscribed, publication: 5 }),
        ...toNoGapRepairWaits(producer)
    ];
}

/** Each grant change waits for both producers' loops before it, and its delta reaches the pages before its cue. */
function toOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(owner),
        toSubscribeCommand(owner, 'receiver'),
        ...toOrderedArrivalWaits(owner, [1, 2]),
        ...toOrderedConfirmedCueWaits(owner, 2),
        toTopicGrantCommand({
            step: owner,
            scope: 'cell',
            operation: 'revoke',
            grantee: 'sender',
            publish: false,
            subscribe: true
        }),
        toPauseCommand(owner, 'revoke-delta-margin', GRANT_DELTA_MARGIN_MS),
        ...toCueSendCommands(owner, 'revoked'),
        ...toOrderedArrivalWaits(owner, [3, 4]),
        ...toOrderedConfirmedCueWaits(owner, 4),
        toTopicGrantCommand({
            step: owner,
            scope: 'cell',
            operation: 'grant',
            grantee: 'sender',
            publish: false,
            subscribe: true
        }),
        ...toCueSendCommands(owner, 'regranted'),
        ...toOrderedArrivalWaits(owner, [5]),
        ...toOrderedConfirmedCueWaits(owner, 5),
        ...toUnsubscribeCommands(owner, 'receiver')
    ];
}

/**
 * The page keeps its election of the topic until its last token is released, the server's revoke notwithstanding,
 * and a further token joins it with no request of its own; so the sibling releases its first election before it elects
 * anew, and its new election is active at the server before it lets the producers publish `p5`.
 */
function toExcludedSubscriberCommands(sibling: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(sibling),
        toSubscribeCommand(sibling, 'sibling'),
        ...toOrderedArrivalWaits(sibling, [1, 2]),
        toCueWait(sibling, 'regranted'),
        ...toUnsubscribeCommands(sibling, 'sibling'),
        toSubscribeCommand(sibling, REGRANTED_SUBSCRIPTION),
        toPauseCommand(sibling, 'subscribe-delta-margin', GRANT_DELTA_MARGIN_MS),
        ...toCueSendCommands(sibling, 'resubscribed'),
        ...toOrderedArrivalWaits(sibling, [5]),
        ...toOrderedPositionWaits({
            step: sibling,
            arrival: 5,
            positions: [{ publication: 5, status: 'omitted', priorSeq: 2 }]
        }),
        ...toOrderedAbsenceWaits(sibling, [3, 4]),
        ...toOrderedConfirmedCueWaits(sibling, 5),
        ...toUnsubscribeCommands(sibling, REGRANTED_SUBSCRIPTION)
    ];
}
