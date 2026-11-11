import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_RTC_ALONE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toAudienceSendCommands, toReceiptWindowCommands } from '../../alm-conformance-receipt-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toOverlayNextHopsCommand } from '../granted-rtc/granted-rtc-commands.ts';
import { BOTH_CONFIRMED, toCueStep } from '../receipted-audience.ts';
import {
    toCueListenCommands,
    toCueSendCommands,
    toCueWait
} from '../topic-subscription/topic-subscription-publications.ts';
import { toPathTopologyConfigCommand } from './to-path-topology-config-command.ts';

/**
 * The owner reshapes the room into a path before the sender sends a receipted multicast to both recipients, so the
 * middle of the path relays the copy down and the leaf's ACK up. Each page records its next hops, which name the
 * layout the run drew; the cell asserts neither which agent relays nor the hop count. Over `rtc` alone: a WS fallback
 * would complete a relayed leg and hide it. The owner resets the topology only once the sender read its receipt, so
 * no reshape lands inside the receipt.
 */
export const receiptedRelayPath: AlmConformanceScenarioDefinition = {
    scenarioId: 'receipted-relay-path',
    scenarioKey: 'receipted-relay-path',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_RTC_ALONE_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    connect: { minReadyPeers: 1 },
    toReceiptRoles: () => BOTH_CONFIRMED,
    toSenderCommands: toRelayPathSenderCommands,
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver' ? toRelayPathOwnerCommands(recipient) : toRelayPathMemberCommands(recipient)
};

/** The sender listens, says so, sends once the owner set the path, records its next hops and reads its receipt. */
function toRelayPathSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const cue = toCueStep(sender);
    return [
        ...toCueListenCommands(cue),
        ...toCueSendCommands(cue, 'ready'),
        toCueWait(cue, 'tree'),
        ...toAudienceSendCommands({ sender, ttlMs: NON_EXPIRING_TTL_MS, ack: 'all-logical-recipients' }),
        toOverlayNextHopsCommand(sender),
        ...toReceiptWindowCommands(sender, { roles: BOTH_CONFIRMED, ending: 'acknowledged', mode: 'receiver' }),
        ...toCueSendCommands(cue, 'read')
    ];
}

/**
 * The receiver owns the run's group, so it PUTs the path; it says the path is set only once the sender, which starts
 * last, says it listens, and resets it only after the sender's read.
 */
function toRelayPathOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const cue = toCueStep(owner);
    return [
        toPathTopologyConfigCommand(owner, 'tree'),
        ...toCueListenCommands(cue),
        toCueWait(cue, 'ready'),
        ...toCueSendCommands(cue, 'tree'),
        toReceivedCommand({ ...owner, index: 1, count: 1, absent: false }),
        toOverlayNextHopsCommand(owner),
        toCueWait(cue, 'recorded'),
        toCueWait(cue, 'read'),
        toPathTopologyConfigCommand(owner, 'reset')
    ];
}

/** Recipient-b ends on an absence as long as the sender's window, so its own ACK has left inside the cell. */
function toRelayPathMemberCommands(recipient: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const cue = toCueStep(recipient);
    return [
        toReceivedCommand({ ...recipient, index: 1, count: 1, absent: false }),
        toOverlayNextHopsCommand(recipient),
        ...toCueSendCommands(cue, 'recorded'),
        toReceivedCommand({ ...recipient, index: 2, count: 2, absent: true })
    ];
}
