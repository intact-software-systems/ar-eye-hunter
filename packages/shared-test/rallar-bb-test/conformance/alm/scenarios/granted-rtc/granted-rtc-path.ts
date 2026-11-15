import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toPathTopologyConfigCommand } from '../../cell/to-path-topology-config-command.ts';
import { toSubscribeCommand, toUnsubscribeCommands } from '../topic-subscription/topic-subscription-commands.ts';
import {
    toCueListenCommands,
    toCueSendCommands,
    toCueWait
} from '../topic-subscription/topic-subscription-publications.ts';
import { toOverlayNextHopsCommand } from './granted-rtc-commands.ts';

/**
 * The cell's start state reshapes the room into a path, and the lane's settle holds every role until every page
 * accepted it; recipient-b holds `publish` alone. A cue reaches
 * only a role whose own first cue opened its channel, so every role subscribes before the cell's `armed` barrier, the
 * owner first of all, and the owner cues `start` only once it subscribed and the sender says it listens; it says it
 * `received` once its own `received` steps passed. The room's three-agent cells share it, so the owner resets the
 * topology once every page recorded its next hops, which name the layout the run drew.
 */
export function toPathOwnerCommands(
    owner: AlmConformanceStepInput,
    received: readonly RallarBlackBoxTestCommand[]
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(owner),
        toSubscribeCommand(owner, 'receiver'),
        toCueWait(owner, 'ready'),
        ...toCueSendCommands(owner, 'start'),
        ...received,
        ...toCueSendCommands(owner, 'received'),
        toOverlayNextHopsCommand(owner),
        toCueWait(owner, 'recorded'),
        ...toUnsubscribeCommands(owner, 'receiver'),
        toPathTopologyConfigCommand(owner, 'reset')
    ];
}

/** The sender listens, says so, and publishes once the owner cued `start`; it then records its next hops. */
export function toPathSenderCommands(
    sender: AlmConformanceStepInput,
    published: readonly RallarBlackBoxTestCommand[]
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(sender),
        ...toCueSendCommands(sender, 'ready'),
        toCueWait(sender, 'start'),
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
