import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toAlmCellPrincipalStartCommands } from '../../cell/to-alm-cell-start-state.ts';
import { toRtcRefusalFacts } from '../../to-rtc-refusal-facts.ts';
import { GRANTED_RTC_CARRIERS, toGrantedRefusalPollCommand, UNRECEIPTED_DELIVERY } from './granted-rtc-commands.ts';

/**
 * The receiver holds `subscribe` alone and publishes on the granted topic through the `rallar.messages.rtc.send` lane
 * entry, with no channel of its own: only its room snapshot's grant makes the send a granted one, which the page
 * refuses `no-publish-grant` before any carrier. The cell has no granted selector, so it declares no start state; it
 * writes its receiver's permissions as a body step by the start state's own per-principal sequence, so the claim does
 * not rest on an earlier cell having left the receiver without `publish`.
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
        ...toAlmCellPrincipalStartCommands(receiver, { grantee: 'receiver', publish: false, subscribe: true }),
        toGrantedRefusalPollCommand({
            step: receiver,
            delivery: UNRECEIPTED_DELIVERY,
            facts: toRtcRefusalFacts('no-publish-grant')
        })
    ];
}
