import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { toNoRepairRequestWaits } from '../../alm-conformance-diagnostic-waits.ts';
import { ALM_CONFORMANCE_FOUR_ROLE_ROLES } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toSiblingLeavingCueCommands, toSiblingLeftCommands } from './to-sibling-left-commands.ts';
import {
    computeUnelectedOutsideCount,
    PRODUCERS_START_GRANTS,
    TOPIC_SUBSCRIPTION_CARRIERS,
    TOPIC_SUBSCRIPTION_SELECTOR,
    toProductSocketCommand,
    toSubscribeCommand,
    toTokenReadCommand,
    toUnsubscribeCommands
} from './topic-subscription-commands.ts';
import {
    toGenerationChangePollCommand,
    toPresenceGenerationPollCommand,
    toRowsGenerationPollCommand
} from './topic-subscription-generation-polls.ts';
import {
    toElectionAppliedCueCommands,
    toElectionAppliedCueWaitCommands,
    toOrderedAbsenceWaits,
    toOrderedArrivalWaits,
    toOrderedConfirmedCueWaits,
    toOrderedPositionWaits,
    toOrderedPublishCommands,
    toReadinessProbeCommands
} from './topic-subscription-ordered-publications.ts';
import {
    toCueListenCommands,
    toCueSendCommands,
    toPublishUntilConfirmedCommands
} from './topic-subscription-publications.ts';

/** The receiver heard both producers' `p4` confirmed: the last cue of the stretch the closed sibling must miss. */
const SIBLING_GATE = 'cue-c-p4-confirmed-received';

/** The re-opened sibling's cue, which the receiver applies before the producers probe for both subscribers again. */
const REENTERED = 'reentered';

/**
 * A reconnect reads as an omission, never as loss. The sibling elects and receives `p1` and `p2` of each producer's
 * track, then drops its product socket, which closes its room presence: `p3` and `p4` reach the receiver alone. Its
 * reopened socket re-asserts its election and its room presence, and the sibling receives `p5`, whose record names the
 * sibling's prior `2`: an omission, with no gap NACK and no repair request. A closed page hears no cue, so the sibling's steps
 * from the reopen on are its continuation, which the lane starts once the receiver heard both producers' `p4`.
 */
export const subscriptionOrderedReconnect: AlmConformanceScenarioDefinition = {
    scenarioId: 'subscription-ordered-reconnect',
    scenarioKey: 'subscription-ordered-reconnect',
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
        recipient.role === 'receiver' ? toOwnerCommands(recipient) : toDroppedSubscriberCommands(recipient),
    continuation: {
        role: 'sibling',
        gate: { role: 'receiver', commandName: SIBLING_GATE },
        toCommands: toReenteredSubscriberCommands
    }
};

/**
 * Over RTC the other producer, unelected, is frozen into each copy. While the sibling's socket is closed a probe
 * publishes until the receiver alone is expected: the WS server stops expecting the sibling with its socket, an RTC
 * producer once its snapshot drops the closed presence. After the reopen the producer's page applies the head that
 * carries the layout the re-asserted presence settled on, then a probe waits until both subscribers are expected
 * again: over RTC the producer's snapshot must name the re-asserted presence and the link must be up.
 */
function toProducerCommands(producer: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const outsideAudience = computeUnelectedOutsideCount(producer, 1);
    const subscribed = { step: producer, confirmations: 2, outsideAudience };
    const receiverAlone = { step: producer, confirmations: 1, outsideAudience };
    return [
        ...toCueListenCommands(producer),
        ...toReadinessProbeCommands(producer, subscribed.confirmations, outsideAudience),
        ...toOrderedPublishCommands({ ...subscribed, publication: 1 }),
        ...toOrderedPublishCommands({ ...subscribed, publication: 2 }),
        ...toSiblingLeftCommands(producer),
        ...toPublishUntilConfirmedCommands({ ...receiverAlone, name: 'probe-receiver-alone', kind: 'probe' }),
        ...toOrderedPublishCommands({ ...receiverAlone, publication: 3 }),
        ...toOrderedPublishCommands({ ...receiverAlone, publication: 4 }),
        ...toElectionAppliedCueWaitCommands(producer, REENTERED, 'reasserted'),
        ...toPublishUntilConfirmedCommands({ ...subscribed, name: 'probe-reentered', kind: 'probe' }),
        ...toOrderedPublishCommands({ ...subscribed, publication: 5 }),
        ...toNoRepairRequestWaits(producer)
    ];
}

function toOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(owner),
        toSubscribeCommand(owner, 'receiver'),
        ...toOrderedArrivalWaits(owner, [1, 2]),
        ...toOrderedConfirmedCueWaits(owner, 2),
        ...toOrderedArrivalWaits(owner, [3, 4]),
        ...toOrderedConfirmedCueWaits(owner, 4),
        ...toElectionAppliedCueCommands(owner, REENTERED, 'reasserted'),
        ...toOrderedArrivalWaits(owner, [5]),
        ...toOrderedConfirmedCueWaits(owner, 5),
        ...toUnsubscribeCommands(owner, 'receiver')
    ];
}

/**
 * The sibling holds its election and its socket until both producers' `p2` confirmed, then tells the producers it
 * leaves and drops the socket.
 */
function toDroppedSubscriberCommands(sibling: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(sibling),
        toSubscribeCommand(sibling, 'sibling'),
        toTokenReadCommand(sibling, 'tokens-before-drop'),
        ...toOrderedArrivalWaits(sibling, [1, 2]),
        ...toOrderedConfirmedCueWaits(sibling, 2),
        ...toSiblingLeavingCueCommands(sibling),
        toProductSocketCommand(sibling, 'close')
    ];
}

/**
 * The reopened socket's election names its generation in the session's row, and its room presence names it too, so
 * the sibling sends its cue again, which the receiver applies before it lets the producers publish. Its re-asserted
 * presence re-plans the room's layout, so the sibling, too, applies the head the receiver's cue follows and tells the
 * producers before they publish.
 */
function toReenteredSubscriberCommands(sibling: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toProductSocketCommand(sibling, 'reopen'),
        toGenerationChangePollCommand({
            step: sibling,
            name: 'reasserted',
            before: 'tokens-before-drop',
            status: 'active'
        }),
        toTokenReadCommand(sibling, 'tokens-reconnected'),
        toRowsGenerationPollCommand({
            step: sibling,
            name: 'rows-reconnected',
            tokens: 'tokens-reconnected',
            names: true
        }),
        toPresenceGenerationPollCommand({ step: sibling, name: 'presence-reasserted', tokens: 'tokens-reconnected' }),
        ...toCueSendCommands(sibling, REENTERED),
        ...toElectionAppliedCueCommands(sibling, REENTERED, 'reasserted'),
        ...toOrderedArrivalWaits(sibling, [5]),
        ...toOrderedPositionWaits({
            step: sibling,
            arrival: 5,
            positions: [{ publication: 5, status: 'omitted', priorSeq: 2 }]
        }),
        ...toOrderedAbsenceWaits(sibling, [3, 4]),
        ...toOrderedConfirmedCueWaits(sibling, 5),
        ...toUnsubscribeCommands(sibling, 'sibling')
    ];
}
