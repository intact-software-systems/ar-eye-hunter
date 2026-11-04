import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toRtcRefusalFacts } from '../../to-rtc-refusal-facts.ts';
import { toTopicGrantCommand } from '../topic-subscription/topic-subscription-commands.ts';
import { GRANTED_RTC_CARRIERS, toGrantedRefusalPollCommand, UNRECEIPTED_DELIVERY } from './granted-rtc-commands.ts';

/**
 * The receiver holds `subscribe` alone and publishes on the granted topic through the `rallar.messages.rtc.send` lane
 * entry, with no channel of its own: only its room snapshot's grant makes the send a granted one, which the page
 * refuses `no-publish-grant` before any carrier.
 */
export const grantedRtcPublishRefused: AlmConformanceScenarioDefinition = {
    scenarioId: 'granted-rtc-publish-refused',
    scenarioKey: 'granted-rtc-publish-refused',
    tags: FULL_TAGS,
    carriers: GRANTED_RTC_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    principalRoles: ['receiver'],
    toSenderCommands: () => [],
    toRecipientCommands: toSubscribeOnlyPublisherCommands
};

function toSubscribeOnlyPublisherCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toTopicGrantCommand({
            step: receiver,
            operation: 'grant',
            grantee: 'receiver',
            publish: false,
            subscribe: true
        }),
        toGrantedRefusalPollCommand({
            step: receiver,
            delivery: UNRECEIPTED_DELIVERY,
            facts: toRtcRefusalFacts('no-publish-grant')
        })
    ];
}
