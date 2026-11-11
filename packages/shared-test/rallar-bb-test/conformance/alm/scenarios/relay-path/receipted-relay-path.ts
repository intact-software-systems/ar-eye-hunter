import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesReceivedCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_RTC_ALONE_CARRIERS } from '../../alm-conformance-carriers.ts';
import {
    toAudienceSendCommands,
    toReceiptReadCommands,
    toSelfAbsenceCommand
} from '../../alm-conformance-receipt-commands.ts';
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
 * The owner reshapes the room into a path, then the sender and the owner each send one receipted multicast to the
 * other two pages. Three sessions in a tree whose degree is at most two form a path with one middle: if the middle is
 * `recipient-b`, both origins are leaves and both sends are relayed; if it is one origin, the other origin's send is
 * relayed, and the middle forwards the far leaf's signed ACK back. So every run witnesses a relayed receipt, whoever
 * the middle is. Each page records its next hops, which name the layout the run drew; the cell asserts neither which
 * agent relays nor the hop count. Over `rtc` alone: a WS fallback would complete a relayed leg and hide it. The owner
 * resets the topology only once both origins read their receipts, so no reshape lands inside either receipt.
 */
export const receiptedRelayPath: AlmConformanceScenarioDefinition = {
    scenarioId: 'receipted-relay-path',
    scenarioKey: 'receipted-relay-path',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_RTC_ALONE_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    connect: { minReadyPeers: 1 },
    // The post-run identity pin describes the sender's send: the receiver and recipient-b confirm it.
    toReceiptRoles: () => BOTH_CONFIRMED,
    toSenderCommands: toRelayPathSenderCommands,
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver' ? toRelayPathOwnerCommands(recipient) : toRelayPathMemberCommands(recipient)
};

/** The sender listens, says so, and sends once the owner set the path; it reads its receipt after its window. */
function toRelayPathSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const cue = toCueStep(sender);
    return [
        ...toCueListenCommands(cue),
        ...toCueSendCommands(cue, 'ready'),
        toCueWait(cue, 'tree'),
        ...toRelayPathOriginCommands(sender),
        ...toCueSendCommands(cue, 'sender-read')
    ];
}

/**
 * The receiver owns the run's group, so it PUTs the path; it says the path is set only once the sender, which starts
 * last, says it listens. Its own window started before the sender's, so once the sender has read both origins have,
 * and only then does it reset the path.
 */
function toRelayPathOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const cue = toCueStep(owner);
    return [
        toPathTopologyConfigCommand(owner, 'tree'),
        ...toCueListenCommands(cue),
        toCueWait(cue, 'ready'),
        ...toCueSendCommands(cue, 'tree'),
        ...toRelayPathOriginCommands(owner),
        toCueWait(cue, 'sender-read'),
        toPathTopologyConfigCommand(owner, 'reset')
    ];
}

/**
 * Each origin sends, hears the other origin's one send, records its next hops and reads its own receipt after its
 * window. Its recipients are the other two pages, so the roles value is read for its lengths alone: expected 2,
 * confirmed 2, nobody unconfirmed or outside.
 */
function toRelayPathOriginCommands(origin: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toAudienceSendCommands({ sender: origin, ttlMs: NON_EXPIRING_TTL_MS, ack: 'all-logical-recipients' }),
        toReceivedCommand({ ...origin, index: 1, count: 1, absent: false }),
        toOverlayNextHopsCommand(origin),
        toOriginSelfAbsenceCommand(origin),
        ...toReceiptReadCommands(origin, { roles: BOTH_CONFIRMED, ending: 'acknowledged', mode: 'receiver' })
    ];
}

/** Of the cell's type an origin holds the other origin's one message and never its own, so a second never arrives. */
function toOriginSelfAbsenceCommand(origin: AlmConformanceStepInput): RallarBlackBoxTestMessagesReceivedCommand {
    return { ...toSelfAbsenceCommand(origin), count: 2 };
}

/** Recipient-b hears both sends and ends on an absence as long as either origin's window, so its ACKs have left. */
function toRelayPathMemberCommands(recipient: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toReceivedCommand({ ...recipient, index: 1, count: 2, absent: false }),
        toOverlayNextHopsCommand(recipient),
        toReceivedCommand({ ...recipient, index: 2, count: 3, absent: true })
    ];
}
