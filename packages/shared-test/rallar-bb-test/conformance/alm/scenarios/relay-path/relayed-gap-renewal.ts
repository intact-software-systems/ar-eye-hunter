import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_TTL_MS, toBudgetMs } from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_RTC_ALONE_CARRIERS } from '../../alm-conformance-carriers.ts';
import {
    ALM_INBOUND_DIAGNOSTICS_TOPIC,
    ALM_OUTBOUND_DIAGNOSTICS_TOPIC,
    toDiagnosticWait,
    toOrderingPositionWait
} from '../../alm-conformance-diagnostic-waits.ts';
import { toHeldMessageFaultCommands, toHeldSendCommands } from '../../alm-conformance-fault-commands.ts';
import {
    toOrderedSendCommands,
    toOrderingKey,
    toReachedCommands,
    toSentCommands,
    type AlmConformanceOrderedSendOptions
} from '../../alm-conformance-ordering-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import { ALM_CONFORMANCE_THREE_AGENT_ROLES, type AlmConformanceRole } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceMessageStepInput,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceScenarioId,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toPathTopologyConfigCommand } from '../../cell/to-path-topology-config-command.ts';
import { toCueStep } from '../receipted-audience.ts';
import {
    toCueListenCommands,
    toCueSendCommands,
    toCueWait
} from '../topic-subscription/topic-subscription-publications.ts';

/** What one statement of the cell sends and proves: its receipt, the request that releases the hold, its handles. */
interface RelayedGapRenewalStatement {
    readonly scenarioId: Extract<AlmConformanceScenarioId, 'relayed-gap-renewal' | 'relayed-unreceipted-gap-renewal'>;
    readonly ack: NonNullable<AlmConformanceOrderedSendOptions['ack']>;
    /** The gap request each origin waits for from each of its receivers before it releases its hold. */
    readonly requestNumber: number;
    /** How an origin reads one of its handles once its hold is released. */
    readonly toHandleCommands: (step: AlmConformanceMessageStepInput) => readonly RallarBlackBoxTestCommand[];
}

interface AlmConformanceGapRequestAdmissionWaitInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    /** Which request for its sequences the gap NACK is: 1 for the report an arrival causes, one more per renewal. */
    readonly requestNumber: number;
    /** A result reference to an arrival the origin received from the receiver whose request the wait matches. */
    readonly logicalRecipientPeerId: string;
}

/**
 * The longest an origin holds its second send before the request that releases it must have committed: half the
 * send's lifetime, the browser default it states none of its own against. The hold starts with the second send, and the
 * other half is left for the release, the repair it lets out and, for a receipted send, that repair's receipt.
 */
const HELD_SEND_BUDGET_MS = NON_EXPIRING_TTL_MS / 2;

/** The pages that originate a track; recipient-b only receives. */
const ORIGINS: readonly AlmConformanceRole[] = ['sender', 'receiver'];
const SEQS = [1, 2, 3] as const;

/**
 * A gap renewal crosses a relay: the start state reshapes the room into a path, and the sender and the owner each
 * originate an ordered `ack: 'receiver'` track of three to the other two pages. Three sessions in a tree whose degree is
 * at most two form a path with one middle, so at least one of two origins is an end: its far receiver reaches it only
 * through the middle, which forwards that receiver's gap NACKs. Each origin holds its own second send at its RTC
 * transport by message id, once both receivers entered its track at the first: the hold drops the original, every
 * gap repair and every receipt retry of it alike, so the gap stays open while each receiver renews its request. Each
 * origin releases the hold only once it admitted the gap request numbered 3 from each receiver, within half the held
 * send's lifetime so its repair has time to land. Request 3 is the proof:
 * it lands after the origin's 2 s receipt retry of the third send, the message that revealed the gap, so the relay
 * must still forward a renewal once that retry passed it. After the run the identity assessment fails the cell unless
 * at least one origin admitted a request 3 that a relay sent for its receiver; the cell asserts neither which page
 * relays nor whose track. No step reads which page is the middle, so the server's RTT replan may move the middle once
 * the path is 15 s old without breaking a step: any path of three keeps one, and each admitted request names the peer
 * that sent it, which the assessment compares with the receiver it speaks for. Over `rtc` alone: a WS fallback would carry the held message or the renewal around the
 * relay. Every receiver hears each origin's three sends in order: it enters the track at the first, releases the third
 * from its buffer once the second arrives, and omits nothing. The tracks run on one type, so each origin's track has
 * its own ordering key and a receiver tells them apart by the key and the sender's peer id, which each page states on
 * the cue channel before `start`. A middle origin's type hold, which covers its second send until the message hold
 * takes over, can drop a forward of the other origin's frame once; that attempt settles `not-ready` and is resubmitted.
 * The owner resets the topology only once both origins read their last handle.
 */
export const relayedGapRenewal: AlmConformanceScenarioDefinition = toRelayedGapRenewal({
    scenarioId: 'relayed-gap-renewal',
    ack: 'receiver',
    requestNumber: 3,
    toHandleCommands: toReachedCommands
});

/**
 * The same path and holds with unreceipted sends: nothing retries the revealing message, so any committed request
 * proves the relayed renewal and each origin releases after request 2 from each receiver. Each handle is read once its
 * carrier took the send.
 */
export const relayedUnreceiptedGapRenewal: AlmConformanceScenarioDefinition = toRelayedGapRenewal({
    scenarioId: 'relayed-unreceipted-gap-renewal',
    ack: 'none',
    requestNumber: 2,
    toHandleCommands: toSentCommands
});

/**
 * The `control-admission` event in which the origin commits a gap NACK of one request number that speaks for one
 * receiver, whichever peer sent it: the receiver itself, or a relay that forwarded it. The request number and the
 * recipient follow the NACK's track in their emitted order, so the match reads them as one run.
 */
function toGapRequestAdmissionWait(
    { step, name, requestNumber, logicalRecipientPeerId }: AlmConformanceGapRequestAdmissionWaitInput
): RallarBlackBoxTestWaitCommand {
    const wait = toDiagnosticWait({
        step,
        name,
        topic: ALM_OUTBOUND_DIAGNOSTICS_TOPIC,
        historyFrom: 'cell',
        contains: `"nackGapRequestNumber":${requestNumber},"nackLogicalRecipientPeerId":"${logicalRecipientPeerId}"`,
        payloadFields: { 'data.kind': 'control-admission', 'data.outcome': 'committed', 'data.nackReason': 'gap' }
    });
    return { ...wait, timeoutMs: toBudgetMs(HELD_SEND_BUDGET_MS, wait.timeoutMs) };
}

/** The name of an origin's wait for the gap request numbered `requestNumber` that speaks for `recipient`. */
export function toGapRequestWaitName(recipient: AlmConformanceRole, requestNumber: number): string {
    return `gap-request-${requestNumber}-for-${recipient}`;
}

function toRelayedGapRenewal(statement: RelayedGapRenewalStatement): AlmConformanceScenarioDefinition {
    return {
        scenarioId: statement.scenarioId,
        scenarioKey: statement.scenarioId,
        roomTopology: 'reshaped',
        tags: FULL_TAGS,
        carriers: ALM_CONFORMANCE_RTC_ALONE_CARRIERS,
        roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
        laneFamily: 'three-agent',
        connect: { minReadyPeers: 1 },
        relayedGapRenewalOrigins: { roles: ORIGINS, requestNumber: statement.requestNumber },
        toSenderCommands: (sender) => toSenderCommands(sender, statement),
        toRecipientCommands: (recipient) =>
            recipient.role === 'receiver'
                ? toOwnerCommands(recipient, statement)
                : toMemberCommands(recipient)
    };
}

/** The sender listens, states its peer id, and originates once the owner cued `start`. */
function toSenderCommands(
    sender: AlmConformanceStepInput,
    statement: RelayedGapRenewalStatement
): readonly RallarBlackBoxTestCommand[] {
    const cue = toCueStep(sender);
    return [
        ...toCueListenCommands(cue),
        ...toCueSendCommands(cue, toHereCue(sender.role)),
        toCueWait(cue, 'start'),
        ...toHereWaits(sender),
        ...toOriginCommands(sender, statement)
    ];
}

/**
 * The owner's start state writes the path. It cues `start` once both other pages stated their peer ids, so every page
 * listens before either origin sends, and resets the path once the sender read its last handle after the owner's own.
 */
function toOwnerCommands(
    owner: AlmConformanceStepInput,
    statement: RelayedGapRenewalStatement
): readonly RallarBlackBoxTestCommand[] {
    const cue = toCueStep(owner);
    return [
        ...toCueListenCommands(cue),
        ...toHereWaits(owner),
        ...toCueSendCommands(cue, toHereCue(owner.role)),
        ...toCueSendCommands(cue, 'start'),
        ...toOriginCommands(owner, statement),
        toCueWait(cue, toReadCue('sender')),
        toPathTopologyConfigCommand(owner, 'reset')
    ];
}

/**
 * Recipient-b receives both first sends, enters both tracks, then hears both tracks out and holds its page until both
 * origins read their handles. Neither origin sends past its first before recipient-b's cue, so its first two arrivals
 * are the two first sends.
 */
function toMemberCommands(member: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const cue = toCueStep(member);
    return [
        ...toCueListenCommands(cue),
        ...toCueSendCommands(cue, toHereCue(member.role)),
        toCueWait(cue, 'start'),
        ...toHereWaits(member),
        toReceivedCommand({ ...member, index: 2, count: 2, absent: false }),
        ...ORIGINS.flatMap((origin) => toEnteredCommands(member, origin)),
        ...ORIGINS.flatMap((origin) => toTrackOrderWaits(member, origin)),
        toReceivedCommand({ ...member, index: 6, count: 6, absent: false }),
        ...ORIGINS.map((origin) => toCueWait(cue, toReadCue(origin)))
    ];
}

/**
 * An origin sends its first, receives the other origin's first and enters that track as its receiver: the other origin
 * sends nothing more before this page's cue. It opens its own gap only once both of its receivers entered its track at
 * the first: a receiver whose first frame is the third would enter there and never report the gap (D630). It releases
 * its hold once each receiver's numbered request committed, reads its handles, and then proves the other origin's
 * track arrived in order.
 */
function toOriginCommands(
    origin: AlmConformanceStepInput,
    statement: RelayedGapRenewalStatement
): readonly RallarBlackBoxTestCommand[] {
    const options = { ack: statement.ack, orderingKey: toOriginOrderingKey(origin, origin.role) };
    const receivers = toOtherRoles(origin);
    const other = toOtherOrigin(origin.role);
    return [
        ...toOrderedSendCommands(origin, 1, options),
        toReceivedCommand({ ...origin, index: 1, count: 1, absent: false }),
        ...toEnteredCommands(origin, other),
        ...receivers.map((receiver) => toCueWait(toCueStep(origin), toEnteredCue(receiver, origin.role))),
        ...toHeldSendCommands({ ...origin, index: 2 }, toOrderedSendCommands(origin, 2, options)),
        ...toOrderedSendCommands(origin, 3, options),
        ...receivers.map((receiver) =>
            toGapRequestAdmissionWait({
                step: origin,
                name: toGapRequestWaitName(receiver, statement.requestNumber),
                requestNumber: statement.requestNumber,
                logicalRecipientPeerId: toPeerIdReference(origin, receiver)
            })
        ),
        ...toHeldMessageFaultCommands({ ...origin, index: 2 }, 'release-message-2', 0),
        ...SEQS.flatMap((index) => statement.toHandleCommands({ ...origin, index })),
        ...toCueSendCommands(toCueStep(origin), toReadCue(origin.role)),
        ...toTrackOrderWaits(origin, other),
        toReceivedCommand({ ...origin, index: 3, count: 3, absent: false })
    ];
}

/** The page entered `origin`'s track at its first send, and says so on the cue channel. */
function toEnteredCommands(
    step: AlmConformanceStepInput,
    origin: AlmConformanceRole
): readonly RallarBlackBoxTestCommand[] {
    return [
        toOrderingPositionWait(step, {
            name: `entered-${origin}`,
            status: 'entered',
            priorSeq: 0,
            track: toTrack(step, origin)
        }),
        ...toCueSendCommands(toCueStep(step), toEnteredCue(step.role, origin))
    ];
}

/**
 * The page released `origin`'s third send from its buffer once the second arrived, and omitted nothing on the track.
 * The release's `claim-settled` effect id is `release:<track key>:<seq>` with the track key URI-encoded; a session id
 * is URL-safe base64, so the sender's peer id reads the same encoded.
 */
function toTrackOrderWaits(
    step: AlmConformanceStepInput,
    origin: AlmConformanceRole
): readonly RallarBlackBoxTestCommand[] {
    const track = toTrack(step, origin);
    const key = encodeURIComponent(`${toOriginOrderingKey(step, origin)}:`);
    return [
        toDiagnosticWait({
            step,
            name: `release-buffered-3-${origin}`,
            topic: ALM_INBOUND_DIAGNOSTICS_TOPIC,
            historyFrom: 'cell',
            contains: `"effectId":"release:${key}${toPeerIdReference(step, origin)}%3A0:3","msgId":null,` +
                '"typeId":null,"subjectMsgId":null,"payloadKind":"release-buffered"'
        }),
        toOrderingPositionWait(step, { name: `no-omitted-${origin}`, status: 'omitted', track, absent: true })
    ];
}

/** Each page waits for the peer id every other page states before `start`, so it can name their tracks and requests. */
function toHereWaits(step: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return toOtherRoles(step).map((role) => toCueWait(toCueStep(step), toHereCue(role)));
}

/** `<origin's ordering key>:<origin's peer id>`, the head of the track key the page states positions on. */
function toTrack(step: AlmConformanceStepInput, origin: AlmConformanceRole): string {
    return `${toOriginOrderingKey(step, origin)}:${toPeerIdReference(step, origin)}`;
}

/** The cell's key, then the origin's role: each origin's track keeps the cell's key as its head. */
function toOriginOrderingKey(step: AlmConformanceStepInput, origin: AlmConformanceRole): string {
    return `${toOrderingKey(step)}:${origin}`;
}

/** The peer id `role` stated on the cue channel, read from this page's arrival of that cue. */
function toPeerIdReference(step: AlmConformanceStepInput, role: AlmConformanceRole): string {
    const arrival = toCueWait(toCueStep(step), toHereCue(role));
    return `{resultCache.${arrival.commandId}.value.event.payload.senderId}`;
}

function toOtherOrigin(origin: AlmConformanceRole): AlmConformanceRole {
    return origin === 'sender' ? 'receiver' : 'sender';
}

function toOtherRoles(step: AlmConformanceStepInput): readonly AlmConformanceRole[] {
    return step.roles.filter((role) => role !== step.role);
}

function toHereCue(role: AlmConformanceRole): string {
    return `${role}-here`;
}

function toEnteredCue(receiver: AlmConformanceRole, origin: AlmConformanceRole): string {
    return `${receiver}-entered-${origin}`;
}

function toReadCue(origin: AlmConformanceRole): string {
    return `${origin}-read`;
}
