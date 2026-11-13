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
import { toCommandId } from '../../alm-conformance-step-identities.ts';
import { toReadPollCommand } from '../../poll/alm-conformance-poll-commands.ts';
import { toOverlayNextHopsCommand } from '../granted-rtc/granted-rtc-commands.ts';
import { BOTH_CONFIRMED, toCueStep } from '../receipted-audience.ts';
import { SUBSCRIPTION_PHASE_MS } from '../topic-subscription/topic-subscription-polls.ts';
import {
    toCueListenCommands,
    toCueSendCommands,
    toCueWait
} from '../topic-subscription/topic-subscription-publications.ts';
import { toPathTopologyConfigCommand } from './to-path-topology-config-command.ts';

/**
 * The owner reshapes the room into a path, then the sender and the owner each send one receipted multicast to the
 * other two pages. Three sessions in a tree whose degree is at most two form a path with one middle, so whenever both
 * sends route on one planned path at least one origin is a leaf: its send is relayed, and the middle forwards the far
 * leaf's signed ACK back. The owner's PUT only requests the reshape, so each origin sends only once its own page has
 * accepted the tree. Each page records its next hops and each origin's receipt names the hops it confirmed through;
 * the cell asserts neither which agent relays nor through which hop, and after the run the identity assessment fails
 * it unless at least one origin confirmed both recipients through one hop. Over `rtc` alone: a WS fallback would
 * complete a relayed leg and hide it. The owner resets the topology only once both origins read their receipts, so no
 * reshape lands inside either receipt.
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
    relayedReceiptOrigins: ['sender', 'receiver'],
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
 * The receiver owns the run's group, so it PUTs the path. It subscribes to the cues first, so it listens before the
 * cell's `armed` barrier lets the sender say it is ready, and it says the path is set only once the sender says it
 * listens. It reads its own receipt before it waits for the sender's `sender-read` cue, so by the reset both origins
 * have read.
 */
function toRelayPathOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const cue = toCueStep(owner);
    return [
        ...toCueListenCommands(cue),
        toPathTopologyConfigCommand(owner, 'tree'),
        toCueWait(cue, 'ready'),
        ...toCueSendCommands(cue, 'tree'),
        ...toRelayPathOriginCommands(owner),
        toCueWait(cue, 'sender-read'),
        toPathTopologyConfigCommand(owner, 'reset')
    ];
}

/**
 * Each origin waits for the tree, sends, hears the other origin's one send, records its next hops and reads its own
 * receipt after its window. Its recipients are the other two pages, so the roles value is read for its lengths alone:
 * expected 2, confirmed 2, nobody unconfirmed or outside.
 */
function toRelayPathOriginCommands(origin: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toTreeInForcePollCommand(origin),
        ...toAudienceSendCommands({ sender: origin, ttlMs: NON_EXPIRING_TTL_MS, ack: 'all-logical-recipients' }),
        toReceivedCommand({ ...origin, index: 1, count: 1, absent: false }),
        toOverlayNextHopsCommand(origin),
        toOriginSelfAbsenceCommand(origin),
        ...toReceiptReadCommands(origin, { roles: BOTH_CONFIRMED, ending: 'acknowledged', mode: 'receiver' })
    ];
}

/** The page's health names its accepted overlay: the origin reads it until that overlay is the tree. */
function toTreeInForcePollCommand(origin: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return toReadPollCommand({
        step: origin,
        name: 'tree-in-force',
        phaseMs: SUBSCRIPTION_PHASE_MS,
        reads: [{
            name: 'read',
            read: (readName) => ({ ...toOverlayNextHopsCommand(origin), commandId: toCommandId(origin, readName) })
        }],
        facts: [{
            name: 'tree-in-force-topology',
            source: { read: 'read', field: 'rallar.formation.accepted.overlay.topology' },
            operator: 'equals',
            expected: 'tree'
        }]
    });
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
