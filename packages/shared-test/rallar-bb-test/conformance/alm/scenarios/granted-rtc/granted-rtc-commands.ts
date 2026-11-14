import type { AlmFaultRewrite } from '../../../../alm/decode-alm-fault-rewrite.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesSendCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceCarrier } from '../../alm-conformance-carriers.ts';
import { toRtcRewriteFaultCommand } from '../../alm-conformance-fault-commands.ts';
import { toSendCommand, type AlmConformanceVerdictFact } from '../../alm-conformance-message-commands.ts';
import { toAdmissionOutcomeWait } from '../../alm-conformance-receiver-commands.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import {
    ALM_CONFORMANCE_GRANTED_TOPIC_ID,
    toCommandId,
    toConnectionName,
    toLoopIterationSendHandleId,
    toRoomRef,
    toScenarioTypeId
} from '../../alm-conformance-step-identities.ts';
import { SUBSCRIPTION_COMMAND_TIMEOUT_MS, SUBSCRIPTION_PHASE_MS } from '../../grant/subscription-phase-budgets.ts';
import { toPollCommand, toPollResult, toResultFact } from '../../poll/alm-conformance-poll-commands.ts';
import { toSubscribeCommand, toUnsubscribeCommands } from '../topic-subscription/topic-subscription-commands.ts';
import {
    toCueListenCommands,
    toCueSendCommands,
    toCueWait,
    toPublicationPayload,
    toPublicationWait
} from '../topic-subscription/topic-subscription-publications.ts';

/**
 * A granted cell proves what the RTC carrier itself decides, so it runs under the `rtc` strategy, where no refusal or
 * lost copy is handed to WS; a cell that proves the hand-over too names the fallback carrier itself.
 */
export const GRANTED_RTC_CARRIERS: readonly AlmConformanceCarrier[] = ['rtc'];

/** The one publication every cell sends, so a payload wait or its absence names it. */
const PUBLICATION = 'publication';

/** How long one publish attempt listens for its cue before it publishes again. */
const CUE_ATTEMPT_WAIT_MS = 1_500;

export type GrantedRtcInboundRefusal = 'invalid-signature' | 'missing-proof';

/** Every granted send states its receipt, so no cell leans on a channel default. */
export interface GrantedRtcDelivery {
    readonly ack: NonNullable<RallarBlackBoxTestMessagesSendCommand['ack']>;
    readonly reliability: NonNullable<RallarBlackBoxTestMessagesSendCommand['reliability']>;
}

/** A publication asking no receipt, which only the receiver's cue confirms. */
export const UNRECEIPTED_DELIVERY: GrantedRtcDelivery = { ack: 'none', reliability: 'best-effort' };

interface GrantedRtcRefusalPollInput {
    readonly step: AlmConformanceStepInput;
    readonly delivery: GrantedRtcDelivery;
    readonly facts: readonly AlmConformanceVerdictFact[];
}

/**
 * The receiver owns the room and hears the cell's cues, then elects itself to receive. Its permissions, and every
 * other role's, are the cell's declared start state, written before the cell's body starts.
 */
export function toGrantedRtcOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [...toCueListenCommands(owner), toSubscribeCommand(owner, 'receiver')];
}

/**
 * An `ack: 'none'` publication confirms nothing to its sender, so the sender publishes until the receiver's `cue`
 * says it saw the outcome. An attempt before the sender's snapshot holds its grant and key is refused, and one before
 * the receiver's snapshot names them is dropped there; both only make the loop publish again.
 */
export function toPublishUntilCueCommand(step: AlmConformanceStepInput, cue: string): RallarBlackBoxTestCommand {
    const name = 'publish';
    return toPollCommand({
        step,
        name,
        phaseMs: SUBSCRIPTION_PHASE_MS,
        commandTimeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS,
        commands: [
            toGrantedRtcSend(step, name, UNRECEIPTED_DELIVERY),
            { ...toCueWait(step, cue), timeoutMs: CUE_ATTEMPT_WAIT_MS }
        ]
    });
}

/** The publication reached the page as an RTC copy: only the receiver's own election records one. */
export function toRtcArrivalWait(receiver: AlmConformanceStepInput): RallarBlackBoxTestWaitCommand {
    const wait = toPublicationWait(receiver, PUBLICATION, false);
    return { ...wait, match: { ...wait.match, payloadFields: { 'data.transport': 'rtc' } } };
}

/** The publisher signs; this page rewrites each signed frame it writes until the cue, then releases the hold. */
export function toRewritingPublisherCommands(
    sender: AlmConformanceStepInput,
    rewrite: AlmFaultRewrite
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(sender),
        // A forged principal resolves only once the page's room snapshot names its live session and key.
        toPollCommand({
            step: sender,
            name: 'rewrite-hold',
            phaseMs: SUBSCRIPTION_PHASE_MS,
            commandTimeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS,
            commands: [
                toRtcRewriteFaultCommand(sender, { name: 'rewrite-hold-inject', rewrite, remaining: 'until-cleared' })
            ]
        }),
        toPublishUntilCueCommand(sender, 'refused'),
        toRtcRewriteFaultCommand(sender, { name: 'rewrite-release', rewrite, remaining: 0 })
    ];
}

/**
 * The receiver, granted and subscribed, drops the rewritten frame `unauthorized` for `refusal` and never delivers it,
 * while the sender keeps publishing until it hears so.
 */
export function toRefusedReceiverCommands(
    receiver: AlmConformanceStepInput,
    refusal: GrantedRtcInboundRefusal
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toGrantedRtcOwnerCommands(receiver),
        toInboundRefusalWait(receiver, refusal),
        ...toCueSendCommands(receiver, 'refused'),
        toPublicationWait(receiver, PUBLICATION, true),
        ...toUnsubscribeCommands(receiver, 'receiver')
    ];
}

/** This page dropped a rewritten frame `unauthorized` for `refusal`. */
export function toInboundRefusalWait(
    step: AlmConformanceStepInput,
    refusal: GrantedRtcInboundRefusal
): RallarBlackBoxTestWaitCommand {
    return toAdmissionOutcomeWait(step, {
        name: `${refusal}-outcome`,
        contains: `"carrier":"rtc","outcome":"unauthorized","reason":"unauthorized: ${refusal}"`,
        timeoutMs: SUBSCRIPTION_PHASE_MS
    });
}

/**
 * This page admitted the cell's frame over RTC: verified, and forwarded wherever its plan names a next hop. With an
 * absence wait beside it, the frame reached a member that delivers nothing.
 */
export function toRtcAdmittedWait(step: AlmConformanceStepInput): RallarBlackBoxTestWaitCommand {
    return toAdmissionOutcomeWait(step, {
        name: 'rtc-admitted',
        contains: '"carrier":"rtc","outcome":"committed","reason":"admitted"',
        timeoutMs: SUBSCRIPTION_PHASE_MS
    });
}

/**
 * Sends through the `rallar.messages.rtc.send` lane entry until one attempt's handle settles `rejected` with every
 * fact, which a refusal before admission does at once: the send observes `rejected`, so a rejected handle is its
 * value. Until the page's snapshot holds the grant the cell needs, an attempt ends another way, fails, and the poll
 * sends again.
 */
export function toGrantedRefusalPollCommand(
    { step, delivery, facts }: GrantedRtcRefusalPollInput
): RallarBlackBoxTestCommand {
    const name = 'refusal';
    const send = toCommandId(step, `${name}-send`);
    const verdict = toPollResult({ step, name, index: 1, childId: send });
    return toPollCommand({
        step,
        name,
        phaseMs: SUBSCRIPTION_PHASE_MS,
        commandTimeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS,
        commands: [
            {
                kind: 'rtc.send',
                commandId: send,
                connection: toConnectionName(step),
                transport: 'messages.rtc',
                observe: 'rejected',
                send: {
                    typeId: toScenarioTypeId(step),
                    topicId: ALM_CONFORMANCE_GRANTED_TOPIC_ID,
                    roomRef: toRoomRef(step.input.group),
                    payload: toPublicationPayload(step, PUBLICATION, 'publication'),
                    ...delivery
                },
                timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS
            },
            ...facts.map(([fact, field, operator, expected]) =>
                toResultFact({
                    timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS,
                    step,
                    name: `${name}-${fact}`,
                    source: `${verdict}.message.${field}`,
                    operator,
                    expected
                })
            )
        ]
    });
}

/**
 * The page's health, whose formation summary names its accepted overlay, topology and `nextHopSessionIds`: recorded for
 * the cell's evidence and asserted nowhere. Its RTC lane status lists every open connection, not the overlay's hops.
 */
export function toOverlayNextHopsCommand(step: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return {
        kind: 'health',
        commandId: toCommandId(step, 'overlay-next-hops'),
        timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS
    };
}

/** One room publication on the granted topic over the cell's carrier, its handle new on each attempt of the poll. */
function toGrantedRtcSend(
    step: AlmConformanceStepInput,
    name: string,
    delivery: GrantedRtcDelivery
): RallarBlackBoxTestMessagesSendCommand {
    const send = toSendCommand({
        ...step,
        index: 1,
        payload: toPublicationPayload(step, PUBLICATION, 'publication'),
        delivery: { ...delivery, commandTimeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS }
    });
    return {
        ...send,
        commandId: toCommandId(step, `${name}-send`),
        topicId: ALM_CONFORMANCE_GRANTED_TOPIC_ID,
        handleId: toLoopIterationSendHandleId(step)
    };
}
