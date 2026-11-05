import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';
import {
    toGroupPath,
    TOPIC_SUBSCRIPTION_SELECTOR,
    toUnsubscribeCommands
} from '../topic-subscription/topic-subscription-commands.ts';
import { SUBSCRIPTION_COMMAND_TIMEOUT_MS } from '../topic-subscription/topic-subscription-polls.ts';
import {
    toCueListenCommands,
    toCueSendCommands,
    toCueWait,
    toPublicationWait
} from '../topic-subscription/topic-subscription-publications.ts';
import {
    GRANTED_RTC_CARRIERS,
    toGrantedRtcOwnerCommands,
    toOverlayNextHopsCommand,
    toPublishUntilCueCommand,
    toRtcAdmittedWait,
    toRtcArrivalWait
} from './granted-rtc-commands.ts';

/** Three sessions in a tree whose degree is at most two form a path; `meshParamK` may not exceed the degree limit. */
const PATH_TOPOLOGY = { topologyKind: 'tree', degreeLimit: 2, meshParamK: 2 } as const;

/**
 * The owner reshapes the room into a path before the sender publishes, so a path leaf's connect waits for its one next
 * hop. The receiver holds `subscribe` and an election, recipient-b `publish` alone, so the sender's `ack: 'none'`
 * publication is frozen to the receiver. Whichever of the two the path puts in the middle, recipient-b admits the
 * frame over RTC and delivers nothing: as the middle it forwards the frame to the receiver, as a leaf it only admits
 * it. Each page records its next hops, which name the layout the run drew; the cell asserts neither which agent
 * relays nor the hop count.
 */
export const grantedRtcRelayOnly: AlmConformanceScenarioDefinition = {
    scenarioId: 'granted-rtc-relay-only',
    scenarioKey: 'granted-rtc-relay-only',
    tags: FULL_TAGS,
    carriers: GRANTED_RTC_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    principalRoles: ['receiver', 'recipient-b', 'sender'],
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    connect: { minReadyPeers: 1 },
    toSenderCommands: (sender) => [
        ...toCueListenCommands(sender),
        ...toCueSendCommands(sender, 'ready'),
        toCueWait(sender, 'tree'),
        toPublishUntilCueCommand(sender, 'received'),
        toOverlayNextHopsCommand(sender)
    ],
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver' ? toPathOwnerCommands(recipient) : toPublisherOnlyCommands(recipient)
};

/**
 * A cue reaches only a role whose own first cue opened its channel, so the owner says the path is set only once the
 * sender, which starts last, says it listens. The room's three-agent cells share it, so the owner resets the topology
 * once every page recorded its next hops.
 */
function toPathOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toTopologyConfigCommand(owner, 'tree'),
        ...toGrantedRtcOwnerCommands(owner, [{ grantee: 'recipient-b', publish: true, subscribe: false }]),
        toCueWait(owner, 'ready'),
        ...toCueSendCommands(owner, 'tree'),
        toRtcArrivalWait(owner),
        ...toCueSendCommands(owner, 'received'),
        toOverlayNextHopsCommand(owner),
        toCueWait(owner, 'recorded'),
        ...toUnsubscribeCommands(owner, 'receiver'),
        toTopologyConfigCommand(owner, 'reset')
    ];
}

function toPublisherOnlyCommands(recipient: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(recipient),
        toRtcAdmittedWait(recipient),
        toCueWait(recipient, 'received'),
        toPublicationWait(recipient, 'publication', true),
        toOverlayNextHopsCommand(recipient),
        ...toCueSendCommands(recipient, 'recorded')
    ];
}

/** `tree` writes the path's config through the owner's topology route; `reset` deletes it, restoring the defaults. */
function toTopologyConfigCommand(owner: AlmConformanceStepInput, change: 'tree' | 'reset'): RallarBlackBoxTestCommand {
    const name = `topology-${change}`;
    return {
        kind: 'http.request',
        commandId: toCommandId(owner, name),
        timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS,
        request: {
            method: change === 'tree' ? 'PUT' : 'DELETE',
            path: `${toGroupPath(owner)}/topology/config/requests/` +
                `alm-topology-{runtimeIdentity}-${owner.input.carrier}-${owner.scenarioKey}-${name}`,
            ...(change === 'tree' ? { body: { config: PATH_TOPOLOGY } } : {})
        },
        response: { body: 'json', acceptedStatusCodes: [200] },
        metadata: { purpose: `The room owner's ${change} of the room's topology config.` }
    };
}
