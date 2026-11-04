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
    toLoopIterationSendHandleId
} from '../../alm-conformance-step-identities.ts';
import {
    toSubscribeCommand,
    toTopicGrantCommand,
    toUnsubscribeCommands
} from '../topic-subscription/topic-subscription-commands.ts';
import {
    SUBSCRIPTION_COMMAND_TIMEOUT_MS,
    SUBSCRIPTION_PHASE_MS,
    toPollCommand,
    toPollResult,
    toResultFact
} from '../topic-subscription/topic-subscription-polls.ts';
import {
    toCueListenCommands,
    toCueSendCommands,
    toCueWait,
    toPublicationPayload,
    toPublicationWait
} from '../topic-subscription/topic-subscription-publications.ts';

/** A granted topic rides RTC only under the `rtc` strategy's own cell; the fallback cell would hand a refusal to WS. */
export const GRANTED_RTC_CARRIERS: readonly AlmConformanceCarrier[] = ['rtc'];

/** The one publication every cell sends, so a payload wait or its absence names it. */
const PUBLICATION = 'publication';

/** How long one publish attempt listens for its cue before it publishes again. */
const CUE_ATTEMPT_WAIT_MS = 1_500;

/** A carrier-admission refusal settles the handle before any carrier, well within this. */
const REFUSAL_WAIT_MS = 1_000;

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
 * The receiver owns the room: it elects itself to receive before it grants the sender `publish`, so the sender's
 * snapshot names the grant only once the receiver can hear it.
 */
export function toGrantedRtcOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(owner),
        toTopicGrantCommand({ step: owner, operation: 'grant', grantee: 'receiver', publish: false, subscribe: true }),
        toSubscribeCommand(owner, 'receiver'),
        toTopicGrantCommand({ step: owner, operation: 'grant', grantee: 'sender', publish: true, subscribe: false })
    ];
}

/**
 * An `ack: 'none'` publication confirms nothing to its sender, so the sender publishes until the receiver's `cue`
 * says it saw the outcome. An attempt before the sender's snapshot holds its grant and key is refused, and one before
 * the receiver's snapshot names them is dropped there; both only make the loop publish again.
 */
export function toPublishUntilCueCommand(step: AlmConformanceStepInput, cue: string): RallarBlackBoxTestCommand {
    const name = 'publish';
    return toPollCommand(step, name, [
        toGrantedRtcSend(step, name, UNRECEIPTED_DELIVERY),
        { ...toCueWait(step, cue), timeoutMs: CUE_ATTEMPT_WAIT_MS }
    ]);
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
        toPollCommand(sender, 'rewrite-hold', [
            toRtcRewriteFaultCommand(sender, { name: 'rewrite-hold-inject', rewrite, remaining: 'until-cleared' })
        ]),
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
 * Sends until one attempt's handle settles `rejected` with every fact, which a refusal before admission does at once;
 * until the page's snapshot holds the grant the cell needs, an attempt ends another way and the poll sends again.
 */
export function toGrantedRefusalPollCommand(
    { step, delivery, facts }: GrantedRtcRefusalPollInput
): RallarBlackBoxTestCommand {
    const name = 'refusal';
    const observe = toCommandId(step, `${name}-observe`);
    const verdict = toPollResult({ step, name, index: 2, childId: observe });
    return toPollCommand(step, name, [
        toGrantedRtcSend(step, name, delivery),
        {
            kind: 'messages.observe',
            commandId: observe,
            connection: toConnectionName(step),
            handleId: toLoopIterationSendHandleId(step),
            state: ['rejected'],
            timeoutMs: REFUSAL_WAIT_MS
        },
        ...facts.map(([fact, field, operator, expected]) =>
            toResultFact({ step, name: `${name}-${fact}`, source: `${verdict}.${field}`, operator, expected })
        )
    ]);
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
