import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toPathTopologyConfigCommand } from '../relay-path/to-path-topology-config-command.ts';
import { toUnsubscribeCommands } from '../topic-subscription/topic-subscription-commands.ts';
import {
    toCueListenCommands,
    toCueSendCommands,
    toCueWait
} from '../topic-subscription/topic-subscription-publications.ts';
import { toGrantedRtcOwnerCommands, toOverlayNextHopsCommand } from './granted-rtc-commands.ts';

/**
 * The owner reshapes the room into a path before the sender publishes, so a path leaf's connect waits for its one next
 * hop, and leaves recipient-b `publish` alone: it grants `publish` and revokes the `subscribe` an earlier cell granted,
 * because a grant only adds permissions and the room's three-agent cells share it. A cue reaches only a role whose own
 * first cue opened its channel, so the owner says the path is set only once the sender, which starts last, says it
 * listens; it says it `received` once its own `received` steps passed. The room's three-agent cells share it, so the
 * owner resets the topology once every page recorded its next hops, which name the layout the run drew.
 */
export function toPathOwnerCommands(
    owner: AlmConformanceStepInput,
    received: readonly RallarBlackBoxTestCommand[]
): readonly RallarBlackBoxTestCommand[] {
    return [
        toPathTopologyConfigCommand(owner, 'tree'),
        ...toGrantedRtcOwnerCommands(owner, [{
            operation: 'grant',
            grantee: 'recipient-b',
            publish: true,
            subscribe: false
        }, {
            operation: 'revoke',
            grantee: 'recipient-b',
            publish: false,
            subscribe: true
        }]),
        toCueWait(owner, 'ready'),
        ...toCueSendCommands(owner, 'tree'),
        ...received,
        ...toCueSendCommands(owner, 'received'),
        toOverlayNextHopsCommand(owner),
        toCueWait(owner, 'recorded'),
        ...toUnsubscribeCommands(owner, 'receiver'),
        toPathTopologyConfigCommand(owner, 'reset')
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
