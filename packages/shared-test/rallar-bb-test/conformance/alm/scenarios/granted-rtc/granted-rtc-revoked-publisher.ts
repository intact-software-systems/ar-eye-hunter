import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toGrantAppliedHeadCommands } from '../../granted-topic/to-grant-applied-head-commands.ts';
import { toTopicGrantCommand } from '../../granted-topic/to-topic-grant-command.ts';
import {
    TOPIC_SUBSCRIPTION_SELECTOR,
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
import { LISTENER_AND_PUBLISHER_START_GRANTS } from './granted-rtc-start-grants.ts';

/**
 * The receiver revokes the sender's `publish` once `publication-1` was confirmed, and `publication-2` settles
 * `rejected` `no-publish-grant`: refused by the sender's snapshot, which the sender reads after the receiver's cue and
 * waits until it applied, so its own check judges the revoke. The receiver never delivers it.
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
    startGrants: LISTENER_AND_PUBLISHER_START_GRANTS,
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
        ...toGrantAppliedHeadCommands(sender, 'revoke-head'),
        ...toRejectedPublishCommands(sender, 'publication-2', 'no-publish-grant')
    ];
}

function toRevokingOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toGrantedRtcOwnerCommands(owner),
        toPublicationWait(owner, 'publication-1', false),
        toConfirmedCueWait(owner, 'publication-1'),
        toTopicGrantCommand({
            step: owner,
            scope: 'cell',
            operation: 'revoke',
            grantee: 'sender',
            publish: true,
            subscribe: false
        }),
        ...toCueSendCommands(owner, 'revoked'),
        toPublicationWait(owner, 'publication-2', true),
        ...toUnsubscribeCommands(owner, 'receiver')
    ];
}
