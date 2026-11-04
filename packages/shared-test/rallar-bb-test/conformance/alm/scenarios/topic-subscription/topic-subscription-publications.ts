import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesSendCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import {
    ALM_CONFORMANCE_GRANTED_TOPIC_ID,
    ALM_CONFORMANCE_TOPIC_ID,
    toCommandId,
    toConnectionName,
    toRoomRef,
    toScenarioTypeId
} from '../../alm-conformance-step-identities.ts';
import {
    SUBSCRIPTION_COMMAND_TIMEOUT_MS,
    SUBSCRIPTION_PHASE_MS,
    toPollCommand,
    toPollResult,
    toResultFact
} from './topic-subscription-polls.ts';

/** How long a role listens, after its positive witness, for a publication it must not receive. */
export const SUBSCRIPTION_ABSENCE_MS = 5_000;

/** A fully subscribed audience confirms in well under this; a missing confirmation ends the attempt instead. */
const CONFIRMATION_WAIT_MS = 3_000;

/** A refusal settles the handle before a carrier, or once a re-plan or the WS admission meets the revoke. */
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
}

interface PayloadWaitInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    readonly payload: Readonly<Record<string, string>>;
    readonly absent: boolean;
}

/**
 * Publishes on the granted topic until one copy's receipt expects exactly `confirmations` plus `outsideAudience`
 * recipients, `confirmations` of them confirm it and the rest end outside, then tells the recipients so. Until every subscriber's election holds, an attempt reaches fewer, or
 * none when the page's own room snapshot does not yet hold its publish grant: a probe makes those attempts without a
 * publication's payload. A recipient that drops out of the audience before the cue would leave every later attempt
 * short, so each recipient holds its election and its socket until `toConfirmedCueWait` hears the cue.
 */
export function toPublishUntilConfirmedCommands(
    publication: TopicPublicationInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toPublishUntilConfirmedPoll(publication),
        ...toCueSendCommands(publication.step, toConfirmedCue(publication.name))
    ];
}

/** The producer's loop `name` ended: every recipient it waited for confirmed one copy. */
export function toConfirmedCueWait(step: AlmConformanceStepInput, name: string): RallarBlackBoxTestWaitCommand {
    return toCueWait(step, toConfirmedCue(name));
}

function toPublishUntilConfirmedPoll(publication: TopicPublicationInput): RallarBlackBoxTestCommand {
    const { step, name } = publication;
    const handleId = `${toCommandId(step, name)}-{loop.iteration}`;
    const observe = toCommandId(step, `${name}-observe`);
    const receipt = toPollResult({ step, name, index: 2, childId: observe });
    return toPollCommand(step, name, [
        {
            ...toGrantedSend(step, toPublicationPayload(step, name, publication.kind)),
            commandId: toCommandId(step, `${name}-send`),
            handleId
        },
        {
            kind: 'messages.observe',
            commandId: observe,
            connection: toConnectionName(step),
            handleId,
            state: ['acknowledged'],
            timeoutMs: CONFIRMATION_WAIT_MS
        },
        ...([
            ['expected', publication.confirmations + publication.outsideAudience],
            ['confirmed', publication.confirmations],
            ['outsideAudience', publication.outsideAudience]
        ] as const).map(([list, expected]) =>
            toResultFact({
                step,
                name: `${name}-${list}`,
                source: `${receipt}.${list}RecipientPeerIds`,
                operator: 'length',
                expected
            })
        )
    ]);
}

function toConfirmedCue(name: string): string {
    return `${name}-confirmed`;
}

/** One publication on the granted topic, its handle named after it so the cell can read its receipt. */
export function toPublishCommands(step: AlmConformanceStepInput, name: string): readonly RallarBlackBoxTestCommand[] {
    const send = toCommandId(step, `${name}-send`);
    return [
        { ...toGrantedSend(step, toPublicationPayload(step, name, 'publication')), commandId: send, handleId: send },
        toResultFact({
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
 * room revoked, refused by the sender's own snapshot or, if that still held the grant, by a re-plan or the WS admission.
 */
export function toRejectedPublishCommands(
    step: AlmConformanceStepInput,
    name: string,
    reason: string
): readonly RallarBlackBoxTestCommand[] {
    const send = toCommandId(step, `${name}-send`);
    const observe = toCommandId(step, `${name}-observe`);
    return [
        { ...toGrantedSend(step, toPublicationPayload(step, name, 'publication')), commandId: send, handleId: send },
        {
            kind: 'messages.observe',
            commandId: observe,
            connection: toConnectionName(step),
            handleId: send,
            state: ['rejected'],
            timeoutMs: REJECTION_WAIT_MS
        },
        toResultFact({
            step,
            name: `${name}-refusal-reason`,
            source: `resultCache.${observe}.value.failure.reason`,
            operator: 'equals',
            expected: reason
        })
    ];
}

export function toReceiptsCommand(step: AlmConformanceStepInput, name: string): RallarBlackBoxTestCommand {
    return {
        kind: 'messages.receipts',
        commandId: toCommandId(step, `${name}-receipts`),
        connection: toConnectionName(step),
        handleId: toCommandId(step, `${name}-send`),
        timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS
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
 * send there opens, so every role that waits for a cue sends this one first, before any cue it waits for can be sent.
 */
export function toCueListenCommands(step: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return toCueSendCommands(step, 'listen');
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

function toGrantedSend(
    step: AlmConformanceStepInput,
    payload: Readonly<Record<string, string>>
): Omit<RallarBlackBoxTestMessagesSendCommand, 'commandId'> {
    return {
        kind: 'messages.send',
        connection: toConnectionName(step),
        carrier: step.input.carrier,
        typeId: toScenarioTypeId(step),
        topicId: ALM_CONFORMANCE_GRANTED_TOPIC_ID,
        roomRef: toRoomRef(step.input.group),
        payload,
        reliability: 'at-least-once',
        ack: 'all-logical-recipients',
        ttlMs: NON_EXPIRING_TTL_MS,
        timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS
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
