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

export interface TopicPublicationInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    /** How many recipients the server must expect for one copy, every one of them confirming it, before the loop ends. */
    readonly confirmations: number;
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
 * Publishes on the granted topic until the server expects exactly `confirmations` recipients for one copy and every one
 * confirms it, then tells the recipients so. Until every subscriber's election holds, an attempt reaches fewer, or
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
        toResultFact({
            step,
            name: `${name}-expected`,
            source: `${receipt}.expectedRecipientPeerIds`,
            operator: 'length',
            expected: publication.confirmations
        }),
        toResultFact({
            step,
            name: `${name}-confirmed`,
            source: `${receipt}.confirmedRecipientPeerIds`,
            operator: 'length',
            expected: publication.confirmations
        })
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

/** The first probe of a readiness loop the page received: proof its election held while that loop ran. */
export function toProbeWait(step: AlmConformanceStepInput, probe: string): RallarBlackBoxTestWaitCommand {
    return toPayloadWait({
        step,
        name: `received-${probe}`,
        payload: toPublicationPayload(step, probe, 'probe'),
        absent: false
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

function toPublicationPayload(
    step: AlmConformanceStepInput,
    name: string,
    kind: TopicPublicationInput['kind']
): Readonly<Record<string, string>> {
    return { marker: step.scenarioKey, carrier: step.input.carrier, [kind]: name };
}

function toCuePayload(step: AlmConformanceStepInput, cue: string): Readonly<Record<string, string>> {
    return { marker: step.scenarioKey, carrier: step.input.carrier, cue };
}
