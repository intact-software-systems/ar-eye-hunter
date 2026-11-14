import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toAlmCellArming } from '../../cell/to-alm-cell-arming.ts';
import {
    toDirectorAppointCommand,
    toDirectorResignCommand,
    toLeaderActivityWait
} from '../leader-ack/leader-ack-commands.ts';
import {
    TOPIC_SUBSCRIPTION_SELECTOR,
    toSubscribeCommand,
    toUnsubscribeCommands
} from '../topic-subscription/topic-subscription-commands.ts';
import {
    toConfirmedCueWait,
    toCueListenCommands,
    toPublishUntilConfirmedCommands
} from '../topic-subscription/topic-subscription-publications.ts';
import { GRANTED_RTC_CARRIERS, toRtcArrivalWait } from './granted-rtc-commands.ts';
import { LISTENER_AND_PUBLISHER_START_GRANTS } from './granted-rtc-start-grants.ts';
import { toConfirmingOwnerCommands } from './to-confirming-owner-commands.ts';

/**
 * The sender lists its two recipients by lane role. The receiver directs the room, so the page resolves the list
 * through the leader rule: `receiver` to the room's leader and `recipient-b` to the session beside it. The lane starts
 * the sender after both recipients connected, and the sender refreshes its snapshot until it reads the leader active,
 * so its first send finds both live sessions and the leader. Both hold `subscribe` and an election, so one copy's
 * receipt expects both, both confirm, and nobody ends outside the audience. The receiver resigns at its end, so the
 * next cell finds the room without a director.
 */
export const grantedRtcListLaneRoles: AlmConformanceScenarioDefinition = {
    scenarioId: 'granted-rtc-list-lane-roles',
    scenarioKey: 'granted-rtc-list-lane-roles',
    tags: FULL_TAGS,
    carriers: GRANTED_RTC_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    principalRoles: ['receiver', 'recipient-b', 'sender'],
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    startGrants: [...LISTENER_AND_PUBLISHER_START_GRANTS, { grantee: 'recipient-b', publish: false, subscribe: true }],
    toSenderCommands: (sender) => [
        toLeaderActivityWait(sender, true),
        ...toPublishUntilConfirmedCommands({
            step: sender,
            name: 'publication',
            confirmations: 2,
            outsideAudience: 0,
            kind: 'publication',
            audience: { recipientPeers: ['receiver', 'recipient-b'] }
        })
    ],
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver' ? toDirectingOwnerCommands(recipient) : toListedSubscriberCommands(recipient)
};

/** The owner subscribes to the cues before it appoints itself, so its cue subscription arms with every other role's. */
function toDirectingOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const { arming, rest } = toAlmCellArming(toConfirmingOwnerCommands(owner));
    return [
        ...arming,
        toDirectorAppointCommand(owner),
        ...rest,
        toDirectorResignCommand(owner)
    ];
}

function toListedSubscriberCommands(recipient: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(recipient),
        toSubscribeCommand(recipient, 'recipient-b'),
        toRtcArrivalWait(recipient),
        toConfirmedCueWait(recipient, 'publication'),
        ...toUnsubscribeCommands(recipient, 'recipient-b')
    ];
}
