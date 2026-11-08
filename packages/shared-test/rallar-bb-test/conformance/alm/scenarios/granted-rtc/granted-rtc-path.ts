import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';
import { toGroupPath, toUnsubscribeCommands } from '../topic-subscription/topic-subscription-commands.ts';
import { SUBSCRIPTION_COMMAND_TIMEOUT_MS } from '../topic-subscription/topic-subscription-polls.ts';
import {
    toCueListenCommands,
    toCueSendCommands,
    toCueWait
} from '../topic-subscription/topic-subscription-publications.ts';
import { toGrantedRtcOwnerCommands, toOverlayNextHopsCommand } from './granted-rtc-commands.ts';

/** Three sessions in a tree whose degree is at most two form a path; `meshParamK` may not exceed the degree limit. */
const PATH_TOPOLOGY = { topologyKind: 'tree', degreeLimit: 2, meshParamK: 2 } as const;

/**
 * The owner reshapes the room into a path before the sender publishes, so a path leaf's connect waits for its one next
 * hop, and grants recipient-b `publish` alone. A cue reaches only a role whose own first cue opened its channel, so the
 * owner says the path is set only once the sender, which starts last, says it listens; it says it `received` once its
 * own `received` steps passed. The room's three-agent cells share it, so the owner resets the topology once every page
 * recorded its next hops, which name the layout the run drew.
 */
export function toPathOwnerCommands(
    owner: AlmConformanceStepInput,
    received: readonly RallarBlackBoxTestCommand[]
): readonly RallarBlackBoxTestCommand[] {
    return [
        toTopologyConfigCommand(owner, 'tree'),
        ...toGrantedRtcOwnerCommands(owner, [{
            operation: 'grant',
            grantee: 'recipient-b',
            publish: true,
            subscribe: false
        }]),
        toCueWait(owner, 'ready'),
        ...toCueSendCommands(owner, 'tree'),
        ...received,
        ...toCueSendCommands(owner, 'received'),
        toOverlayNextHopsCommand(owner),
        toCueWait(owner, 'recorded'),
        ...toUnsubscribeCommands(owner, 'receiver'),
        toTopologyConfigCommand(owner, 'reset')
    ];
}

/** The sender listens, says so, and publishes once the owner set the path; it then records its next hops. */
export function toPathSenderCommands(
    sender: AlmConformanceStepInput,
    published: readonly RallarBlackBoxTestCommand[]
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(sender),
        ...toCueSendCommands(sender, 'ready'),
        toCueWait(sender, 'tree'),
        ...published,
        toOverlayNextHopsCommand(sender)
    ];
}

/** Recipient-b, `publish` alone, observes what reaches it, then records its next hops and says so. */
export function toPathMemberCommands(
    recipient: AlmConformanceStepInput,
    observed: readonly RallarBlackBoxTestCommand[]
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(recipient),
        ...observed,
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
