import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { toNoGapRepairWaits } from '../../alm-conformance-diagnostic-waits.ts';
import { ALM_CONFORMANCE_FOUR_ROLE_ROLES } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
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

/** The receiver's cue that both producers' `p2` were confirmed, which lets the sibling subscribe. */
const PUBLISHED_BEFORE_ENTRY = 'published-2';

/**
 * A late subscriber enters each producer's track at its first copy. Both producers publish `p1` and `p2` on a track of
 * their own, minted by the page, which the receiver alone confirms; the sibling, granted but not elected, subscribes
 * only once the receiver said both were confirmed and then hears `p3` of each and neither earlier publication. Over ws
 * the server's first copy to the sibling records no position for it, so the sibling enters at `p3` with prior `0`.
 * Over RTC the origin freezes the sibling into `p1` and `p2`, which it witnesses with each prior the origin recorded,
 * so `p3` follows in order. No producer is asked a gap or dispatches a repair, and each loop holds the count identity.
 */
export const subscriptionOrderedEntry: AlmConformanceScenarioDefinition = {
    scenarioId: 'subscription-ordered-entry',
    scenarioKey: 'subscription-ordered-entry',
    tags: FULL_TAGS,
    carriers: TOPIC_SUBSCRIPTION_CARRIERS,
    roles: ALM_CONFORMANCE_FOUR_ROLE_ROLES,
    laneFamily: 'four-role',
    room: 'own',
    principalRoles: ['receiver', 'publisher-b', 'sender'],
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    startGrants: PRODUCERS_START_GRANTS,
    toSenderCommands: toProducerCommands,
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver' ? toOwnerCommands(recipient) : toLateSubscriberCommands(recipient)
};

/**
 * Over RTC the unelected sibling and the other producer are frozen into each copy before the sibling elects, and the
 * other producer alone after.
 */
function toProducerCommands(producer: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const beforeEntry = {
        step: producer,
        confirmations: 1,
        outsideAudience: computeUnelectedOutsideCount(producer, 2)
    };
    return [
        ...toCueListenCommands(producer),
        ...toReadinessProbeCommands(producer, beforeEntry.confirmations, beforeEntry.outsideAudience),
        ...toOrderedPublishCommands({ ...beforeEntry, publication: 1 }),
        ...toOrderedPublishCommands({ ...beforeEntry, publication: 2 }),
        toCueWait(producer, 'entered'),
        ...toOrderedPublishCommands({
            step: producer,
            publication: 3,
            confirmations: 2,
            outsideAudience: computeUnelectedOutsideCount(producer, 1)
        }),
        ...toNoGapRepairWaits(producer)
    ];
}

/**
 * The receiver relays that both producers published `p2`: its cue subscription leads its body, so it listens before the
 * cell's `armed` barrier lets either producer cue, and the sibling waits for this one cue alone.
 */
function toOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(owner),
        toSubscribeCommand(owner, 'receiver'),
        ...toOrderedArrivalWaits(owner, [1, 2]),
        ...toOrderedConfirmedCueWaits(owner, 2),
        ...toCueSendCommands(owner, PUBLISHED_BEFORE_ENTRY),
        ...toOrderedArrivalWaits(owner, [3]),
        ...toOrderedConfirmedCueWaits(owner, 3),
        ...toUnsubscribeCommands(owner, 'receiver')
    ];
}

function toLateSubscriberCommands(sibling: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const positions = sibling.input.carrier === 'ws'
        ? [{ publication: 3, status: 'entered', priorSeq: 0 } as const]
        : [
            { publication: 1, status: 'witnessed', priorSeq: 0 } as const,
            { publication: 2, status: 'witnessed', priorSeq: 1 } as const
        ];
    return [
        ...toCueListenCommands(sibling),
        toCueWait(sibling, PUBLISHED_BEFORE_ENTRY),
        toSubscribeCommand(sibling, 'sibling'),
        toPauseCommand(sibling, 'subscribe-delta-margin', GRANT_DELTA_MARGIN_MS),
        ...toCueSendCommands(sibling, 'entered'),
        ...toOrderedArrivalWaits(sibling, [3]),
        ...toOrderedPositionWaits({ step: sibling, arrival: 3, positions }),
        ...toOrderedAbsenceWaits(sibling, [1, 2]),
        ...toOrderedConfirmedCueWaits(sibling, 3),
        ...toUnsubscribeCommands(sibling, 'sibling')
    ];
}
