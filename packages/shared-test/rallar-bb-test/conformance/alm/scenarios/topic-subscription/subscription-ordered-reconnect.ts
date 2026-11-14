import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { toNoGapRepairWaits } from '../../alm-conformance-diagnostic-waits.ts';
import { ALM_CONFORMANCE_FOUR_ROLE_ROLES } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toPauseCommand } from '../../to-pause-command.ts';
import { toSiblingLeftWait } from './to-sibling-left-wait.ts';
import { GRANT_DELTA_MARGIN_MS } from './topic-subscription-budgets.ts';
import {
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
    toCueWait,
    toPublishUntilConfirmedCommands
} from './topic-subscription-publications.ts';

/** The receiver heard both producers' `p4` confirmed: the last cue of the stretch the closed sibling must miss. */
const SIBLING_GATE = 'cue-c-p4-confirmed-received';

/**
 * A reconnect reads as an omission, never as loss. The sibling elects and receives `p1` and `p2` of each producer's
 * track, then drops its product socket, which closes its room presence: `p3` and `p4` reach the receiver alone. Its
 * reopened socket re-asserts its election and its room presence, and the sibling receives `p5`, whose record names the
 * sibling's prior `2`: an omission, with no gap NACK and no repair. A closed page hears no cue, so the sibling's steps
 * from the reopen on are its continuation, which the lane starts once the receiver heard both producers' `p4`.
 */
export const subscriptionOrderedReconnect: AlmConformanceScenarioDefinition = {
    scenarioId: 'subscription-ordered-reconnect',
    scenarioKey: 'subscription-ordered-reconnect',
    tags: FULL_TAGS,
    carriers: TOPIC_SUBSCRIPTION_CARRIERS,
    roles: ALM_CONFORMANCE_FOUR_ROLE_ROLES,
    laneFamily: 'four-role',
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
 * producer once its snapshot drops the closed presence. After the reopen a probe waits until both subscribers are
 * expected again: over RTC the producer's snapshot must name the re-asserted presence and the link must be up.
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
        toSiblingLeftWait(producer),
        ...toPublishUntilConfirmedCommands({ ...receiverAlone, name: 'probe-receiver-alone', kind: 'probe' }),
        ...toOrderedPublishCommands({ ...receiverAlone, publication: 3 }),
        ...toOrderedPublishCommands({ ...receiverAlone, publication: 4 }),
        toCueWait(producer, 'reentered'),
        ...toPublishUntilConfirmedCommands({ ...subscribed, name: 'probe-reentered', kind: 'probe' }),
        ...toOrderedPublishCommands({ ...subscribed, publication: 5 }),
        ...toNoGapRepairWaits(producer)
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
        ...toOrderedArrivalWaits(owner, [5]),
        ...toOrderedConfirmedCueWaits(owner, 5),
        ...toUnsubscribeCommands(owner, 'receiver')
    ];
}

/** The sibling holds its election and its socket until both producers' `p2` confirmed, then drops the socket. */
function toDroppedSubscriberCommands(sibling: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(sibling),
        toSubscribeCommand(sibling, 'sibling'),
        toTokenReadCommand(sibling, 'tokens-before-drop'),
        ...toOrderedArrivalWaits(sibling, [1, 2]),
        ...toOrderedConfirmedCueWaits(sibling, 2),
        toProductSocketCommand(sibling, 'close')
    ];
}

/**
 * The reopened socket's election names its generation in the session's row, and its room presence names it too, so
 * the sibling sends its cue again; the election's delta reaches the producers' snapshots before it does.
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
        toPauseCommand(sibling, 'reentered-delta-margin', GRANT_DELTA_MARGIN_MS),
        ...toCueSendCommands(sibling, 'reentered'),
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
