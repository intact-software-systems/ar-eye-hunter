import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toPauseCommand } from '../../to-pause-command.ts';
import { GRANT_DELTA_MARGIN_MS } from '../topic-subscription/topic-subscription-budgets.ts';
import {
    TOPIC_SUBSCRIPTION_SELECTOR,
    toTopicGrantCommand,
    toUnsubscribeCommands
} from '../topic-subscription/topic-subscription-commands.ts';
import {
    toConfirmedCueWait,
    toCueListenCommands,
    toCueSendCommands,
    toCueWait,
    toPublicationWait,
    toPublishUntilConfirmedCommands,
    toRejectedPublishCommands
} from '../topic-subscription/topic-subscription-publications.ts';
import { toGrantedRtcOwnerCommands } from './granted-rtc-commands.ts';

/**
 * The receiver revokes the sender's `publish` once `publication-1` was confirmed, and `publication-2` settles
 * `rejected` `no-publish-grant`: refused by the sender's snapshot once the delta lands, or, if that still held the
 * grant, dropped at the receiver and refused at the re-plan, or under the fallback carrier at the WS admission of the
 * hand-over. The receiver never delivers it.
 */
export const grantedRtcRevokedPublisher: AlmConformanceScenarioDefinition = {
    scenarioId: 'granted-rtc-revoked-publisher',
    scenarioKey: 'granted-rtc-revoked-publisher',
    tags: FULL_TAGS,
    carriers: ['rtc', 'rtc-with-ws-fallback'],
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    principalRoles: ['receiver', 'sender'],
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    toSenderCommands: toRevokedPublisherCommands,
    toRecipientCommands: toRevokingOwnerCommands
};

function toRevokedPublisherCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(sender),
        ...toPublishUntilConfirmedCommands({
            step: sender,
            name: 'publication-1',
            confirmations: 1,
            outsideAudience: 0,
            kind: 'publication'
        }),
        toCueWait(sender, 'revoked'),
        toPauseCommand(sender, 'revoke-delta-margin', GRANT_DELTA_MARGIN_MS),
        ...toRejectedPublishCommands(sender, 'publication-2', 'no-publish-grant')
    ];
}

function toRevokingOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toGrantedRtcOwnerCommands(owner, []),
        toPublicationWait(owner, 'publication-1', false),
        toConfirmedCueWait(owner, 'publication-1'),
        toTopicGrantCommand({ step: owner, operation: 'revoke', grantee: 'sender', publish: true, subscribe: false }),
        ...toCueSendCommands(owner, 'revoked'),
        toPublicationWait(owner, 'publication-2', true),
        ...toUnsubscribeCommands(owner, 'receiver')
    ];
}
