import type { ALDeliveryState } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesObserveCommand,
    RallarBlackBoxTestMessagesSendCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import type { AlmConformanceSendAudience } from '../../alm-conformance-receipt-commands.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import {
    ALM_CONFORMANCE_TOPIC_ID,
    toCommandId,
    toConnectionName,
    toRoomRef,
    toScenarioTypeId
} from '../../alm-conformance-step-identities.ts';
import { ALM_CELL_CUE_SUBSCRIPTION_METADATA } from '../../cell/to-alm-cell-arming.ts';
import {
    SUBSCRIPTION_COMMAND_TIMEOUT_MS,
    SUBSCRIPTION_PHASE_MS
} from '../../granted-topic/subscription-phase-budgets.ts';
import { toPollCommand, toPollResult, toResultFact } from '../../poll/alm-conformance-poll-commands.ts';
import { toGrantedSend } from './to-granted-send.ts';
import { SUBSCRIPTION_ABSENCE_MS } from './topic-subscription-budgets.ts';

/**
 * How long one attempt of a publish loop observes its copy before the next attempt sends a new one. The origin's
 * admission of acknowledgements reached 12.1 s on GitHub runners, with a p90 of 4.3 to 5.8 s on the failing jobs of the
 * full-scope runs of 2026-11-22, so an attempt that misses this window met a short audience, not a slow lane.
 */
const SLOW_PATH_ACKNOWLEDGEMENT_WAIT_MS = 15_000;

/**
 * A refusal settles the handle before a carrier, or once a re-plan or the WS admission meets the revoke. The S3-ii
 * lanes ran the whole revoked-publisher sender recipe, this wait included, in 3.2–6.6 s over `rtc` and
 * `rtc-with-ws-fallback`, so the budget keeps at least 4.5 times the longest.
 */
const REJECTION_WAIT_MS = 30_000;

export interface TopicPublicationInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    /** How many recipients one copy must confirm before the loop ends. */
    readonly confirmations: number;
    /**
     * How many more the copy's receipt must expect and record outside its audience: granted sessions that answered
     * `not-subscribed` because they hold no election, which only a send that starts on RTC freezes in.
     */
    readonly outsideAudience: number;
    /** A probe's payload names the probe, so no publication wait or absence matches it. */
    readonly kind: 'publication' | 'probe';
    /** The track the publication rides, whose sequence the page mints; absent, it rides none. */
    readonly orderingKey?: string;
    /** Absent, every granted session of the room. */
    readonly audience?: AlmConformanceSendAudience;
}

interface PayloadWaitInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    readonly payload: Readonly<Record<string, string>>;
    readonly absent: boolean;
}

/**
 * Publishes on the granted topic until one copy's receipt expects exactly `confirmations` plus `outsideAudience`
 * recipients, `confirmations` of them confirm it and the rest end outside, then tells the recipients so. Until every
 * subscriber's election holds, an attempt reaches fewer, or none when the page's own room snapshot does not yet hold
 * its publish grant: a probe makes those attempts without a publication's payload. A recipient that drops out of the
 * audience before the cue would leave every later attempt short, so each recipient holds its election and its socket
 * until `toConfirmedCueWait` hears the cue. Each attempt sends a new message, so an ordered publication, whose retry
 * would mint a sequence of its own, publishes once through `toPublishOnceCommands` instead.
 */
export function toPublishUntilConfirmedCommands(
    publication: TopicPublicationInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toPublishUntilConfirmedPoll(publication),
        ...toCueSendCommands(publication.step, toConfirmedCue(publication.name))
    ];
}

/**
 * Publishes once, observes the copy for one phase and holds its receipt to the counts `toPublishUntilConfirmedCommands`
 * holds an attempt to, then tells the recipients so. A receipt that names another audience fails the cell.
 */
export function toPublishOnceCommands(publication: TopicPublicationInput): readonly RallarBlackBoxTestCommand[] {
    const { step, name } = publication;
    const send = toCommandId(step, `${name}-send`);
    const observe = toPublicationObserveCommand(step, name, 'acknowledged');
    return [
        { ...toPublicationSend(publication), commandId: send, handleId: send },
        observe,
        ...toReceiptCountFacts(publication, `resultCache.${observe.commandId}.value`),
        ...toCueSendCommands(step, toConfirmedCue(name))
    ];
}

/** The producer's loop `name` ended: every recipient it waited for confirmed one copy. */
export function toConfirmedCueWait(step: AlmConformanceStepInput, name: string): RallarBlackBoxTestWaitCommand {
    return toCueWait(step, toConfirmedCue(name));
}

/**
 * Attempts start for one phase; the poll's deadline adds one attempt's budget, its send's and its observe's timeouts,
 * so the last attempt started inside the phase observes its whole window.
 */
function toPublishUntilConfirmedPoll(publication: TopicPublicationInput): RallarBlackBoxTestCommand {
    const { step, name } = publication;
    const handleId = `${toCommandId(step, name)}-{loop.iteration}`;
    const observe = toCommandId(step, `${name}-observe`);
    return toPollCommand({
        step,
        name,
        phaseMs: SUBSCRIPTION_PHASE_MS,
        commands: [
            { ...toPublicationSend(publication), commandId: toCommandId(step, `${name}-send`), handleId },
            {
                kind: 'messages.observe',
                commandId: observe,
                connection: toConnectionName(step),
                handleId,
                state: ['acknowledged'],
                timeoutMs: SLOW_PATH_ACKNOWLEDGEMENT_WAIT_MS
            },
            ...toReceiptCountFacts(publication, toPollResult({ step, name, index: 2, childId: observe }))
        ]
    });
}

function toPublicationSend(
    publication: TopicPublicationInput
): Omit<RallarBlackBoxTestMessagesSendCommand, 'commandId'> {
    return toGrantedSend({
        step: publication.step,
        payload: toPublicationPayload(publication.step, publication.name, publication.kind),
        orderingKey: publication.orderingKey,
        audience: publication.audience
    });
}

/** The receipt at `receipt` expects the audience and outside counts, and the audience confirmed it. */
function toReceiptCountFacts(
    publication: TopicPublicationInput,
    receipt: string
): readonly RallarBlackBoxTestCommand[] {
    const { step, name, confirmations, outsideAudience } = publication;
    return ([
        ['expected', confirmations + outsideAudience],
        ['confirmed', confirmations],
        ['outsideAudience', outsideAudience]
    ] as const).map(([list, expected]) =>
        toResultFact({
            timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS,
            step,
            name: `${name}-${list}`,
            source: `${receipt}.${list}RecipientPeerIds`,
            operator: 'length',
            expected
        })
    );
}

function toConfirmedCue(name: string): string {
    return `${name}-confirmed`;
}

/** One publication on the granted topic, its handle named after it so the cell can read its receipt. */
export function toPublishCommands(step: AlmConformanceStepInput, name: string): readonly RallarBlackBoxTestCommand[] {
    const send = toCommandId(step, `${name}-send`);
    return [
        {
            ...toGrantedSend({ step, payload: toPublicationPayload(step, name, 'publication') }),
            commandId: send,
            handleId: send
        },
        toResultFact({
            timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS,
            step,
            name: `${name}-admitted`,
            source: `resultCache.${send}.value.status`,
            operator: 'notEquals',
            expected: 'rejected'
        })
    ];
}

/**
 * One publication on the granted topic that must settle `rejected` for `reason`: a send whose publisher's grant the
 * room revoked, refused by the sender's own snapshot or, if that still held the grant, by a re-plan or the WS
 * admission.
 */
export function toRejectedPublishCommands(
    step: AlmConformanceStepInput,
    name: string,
    reason: string
): readonly RallarBlackBoxTestCommand[] {
    const send = toCommandId(step, `${name}-send`);
    const observe = toPublicationObserveCommand(step, name, 'rejected');
    return [
        {
            ...toGrantedSend({ step, payload: toPublicationPayload(step, name, 'publication') }),
            commandId: send,
            handleId: send
        },
        observe,
        toResultFact({
            timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS,
            step,
            name: `${name}-refusal-reason`,
            source: `resultCache.${observe.commandId}.value.failure.reason`,
            operator: 'equals',
            expected: reason
        })
    ];
}

/**
 * A publication's receipt, read once its handle has ended: a receipt's lists stop changing at a terminal state. The
 * observe resolves at any terminal state, so what the receipt reads is still the read's to judge.
 */
export function toEndedReceiptCommands(
    step: AlmConformanceStepInput,
    name: string
): readonly RallarBlackBoxTestCommand[] {
    return [
        toPublicationObserveCommand(step, name, 'acknowledged'),
        {
            kind: 'messages.receipts',
            commandId: toCommandId(step, `${name}-receipts`),
            connection: toConnectionName(step),
            handleId: toCommandId(step, `${name}-send`),
            timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS
        }
    ];
}

/**
 * The publication's handle reaches `state` or any terminal state: a refusal within its rejection budget, a receipt
 * once its audience confirmed, which is one phase of the cell.
 */
function toPublicationObserveCommand(
    step: AlmConformanceStepInput,
    name: string,
    state: Extract<ALDeliveryState, 'rejected' | 'acknowledged'>
): RallarBlackBoxTestMessagesObserveCommand {
    return {
        kind: 'messages.observe',
        commandId: toCommandId(step, `${name}-observe`),
        connection: toConnectionName(step),
        handleId: toCommandId(step, `${name}-send`),
        state: [state],
        timeoutMs: state === 'rejected' ? REJECTION_WAIT_MS : SUBSCRIPTION_PHASE_MS
    };
}

/** A publication's arrival on the page, or its absence over `SUBSCRIPTION_ABSENCE_MS` and everything before it. */
export function toPublicationWait(
    step: AlmConformanceStepInput,
    publication: string,
    absent: boolean
): RallarBlackBoxTestWaitCommand {
    return toPayloadWait({
        step,
        name: `${absent ? 'absent' : 'received'}-${publication}`,
        payload: toPublicationPayload(step, publication, 'publication'),
        absent
    });
}

/**
 * A cue travels on the members topic under the cell's type. A role hears it only through the typed channel its own
 * send there opens, so every role that waits for a cue leads its body with this pair: it is the role's arming run,
 * which a barriered cell completes on every role before any role's body sends a cue.
 */
export function toCueListenCommands(step: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return toCueSendCommands(step, 'listen').map((command) => ({
        ...command,
        metadata: ALM_CELL_CUE_SUBSCRIPTION_METADATA
    }));
}

/**
 * Tells every role listening on the members topic that this role reached `cue`. The cue has left the page once its
 * handle reads `transport-accepted`, so a role that drops its socket right after its cue still sends it.
 */
export function toCueSendCommands(step: AlmConformanceStepInput, cue: string): readonly RallarBlackBoxTestCommand[] {
    const handleId = toCommandId(step, `cue-${cue}`);
    return [
        {
            kind: 'messages.send',
            commandId: handleId,
            connection: toConnectionName(step),
            carrier: 'ws',
            typeId: toScenarioTypeId(step),
            topicId: ALM_CONFORMANCE_TOPIC_ID,
            roomRef: toRoomRef(step.input.group),
            payload: toCuePayload(step, cue),
            reliability: 'at-least-once',
            ack: 'none',
            ttlMs: NON_EXPIRING_TTL_MS,
            handleId,
            timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS
        },
        {
            kind: 'messages.observe',
            commandId: toCommandId(step, `cue-${cue}-sent`),
            connection: toConnectionName(step),
            handleId,
            state: ['transport-accepted'],
            timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS
        }
    ];
}

export function toCueWait(step: AlmConformanceStepInput, cue: string): RallarBlackBoxTestWaitCommand {
    return toPayloadWait({ step, name: `cue-${cue}-received`, payload: toCuePayload(step, cue), absent: false });
}

function toPayloadWait({ step, name, payload, absent }: PayloadWaitInput): RallarBlackBoxTestWaitCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(step, name),
        match: { kind: 'message', connection: toConnectionName(step), payloadPath: 'data.payload', equals: payload },
        ...(absent ? { absent: true } : {}),
        timeoutMs: absent ? SUBSCRIPTION_ABSENCE_MS : SUBSCRIPTION_PHASE_MS
    };
}

export function toPublicationPayload(
    step: AlmConformanceStepInput,
    name: string,
    kind: TopicPublicationInput['kind']
): Readonly<Record<string, string>> {
    return { marker: step.scenarioKey, carrier: step.input.carrier, [kind]: name };
}

function toCuePayload(step: AlmConformanceStepInput, cue: string): Readonly<Record<string, string>> {
    return { marker: step.scenarioKey, carrier: step.input.carrier, cue };
}
