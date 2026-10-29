import { decodeALTraceId } from '@shared/al-contracts/trace/al-trace-id.ts';

import { isRallarBlackBoxTestMessagesSendCommand } from '../../../alm/is-rallar-black-box-test-messages-send-command.ts';
import { isRallarBlackBoxTestResult } from '../../../composite-results.ts';
import type { ControlResultEnvelope } from '../../../control-protocol.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesSendCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult
} from '../../../rallar-black-box-test-contracts.ts';
import { decodeJsonValue } from '../../../runtime/decode-runtime-result-values.ts';
import { isJsonRecordValue } from '../../../schema/json-schema-validation.ts';
import { isSameJsonValue } from '../../../wait/wait-event-match.ts';
import type { AlmConformanceRole } from '../alm-conformance-roles.ts';
import { assessAlmAcknowledgedIdentity } from './assess-alm-acknowledged-identity.ts';
import { assessAlmReceiptRoleIdentity, readAlmReceiptRolesEntries } from './assess-alm-receipt-role-identity.ts';
import {
    assessAlmReceivedTraceIdentity,
    isAlmFallbackMarker,
    toArrivalTransports,
    type AlmFallbackMarker,
    type AlmReceivedTraceIdentityInput
} from './assess-alm-received-trace-identity.ts';
import { assessAlmReloadIdentity } from './assess-alm-reload-identity.ts';
import { assessAlmServerOriginatedIdentity, toTracedRequests } from './assess-alm-server-originated-identity.ts';
import { toAlmJsonPathValue, toRecordedAlmResultValue } from './to-recorded-alm-result-value.ts';

export interface AlmConformanceIdentityParticipant {
    readonly role: string;
    readonly agentId: string;
    readonly commandId: string;
    readonly recipe: RallarBlackBoxTestRecipe;
    readonly result: ControlResultEnvelope | undefined;
}

export interface AlmConformanceIdentityInput {
    readonly runId: string;
    /** The roles the scenario declares; each needs exactly one participant (D45). */
    readonly roles: readonly AlmConformanceRole[];
    readonly participants: readonly AlmConformanceIdentityParticipant[];
}

export interface RecordedAlmConformanceParticipant {
    readonly participant: AlmConformanceIdentityParticipant;
    readonly results: ReadonlyMap<string, RallarBlackBoxTestResult>;
}

const REQUIRED_ALM_CONFORMANCE_ROLES: readonly AlmConformanceRole[] = ['sender', 'receiver'];

/** ALM's ordinary recipe assertions prove states; this boundary joins independently owned message identities. */
export function assessAlmConformanceIdentity(input: AlmConformanceIdentityInput): readonly string[] {
    const roleIssues = validateAlmConformanceRoles(input);
    if (roleIssues.length > 0) {
        return roleIssues;
    }
    const issues: string[] = [];
    const recorded = input.participants.map((participant) => readParticipant(input.runId, participant, issues));
    const sender = recorded.find((participant) => participant?.participant.role === 'sender');
    const receiver = recorded.find((participant) => participant?.participant.role === 'receiver');
    if (issues.length > 0 || !sender || !receiver) {
        return issues;
    }
    if (!hasAlmIdentityEvidence(sender.participant.recipe)) {
        return ['ALM lifecycle, reload, fallback, pinned receipt or traced request sender evidence is missing.'];
    }
    const sends = sender.participant.recipe.commands.filter(isIdentitySend);
    issues.push(...assessAlmReceiptRoleIdentity({
        sender,
        recipients: recorded.filter((participant): participant is RecordedAlmConformanceParticipant =>
            participant !== undefined && participant !== sender
        )
    }));
    issues.push(...assessSendIdentities({ sends, sender, receiver }));
    issues.push(...assessAlmReloadIdentity(
        sender,
        receiver,
        sends.filter((send) => send.payload.marker === 'delivery-reload')
    ));
    issues.push(...assessAlmServerOriginatedIdentity({ sender, receiver }));
    return issues;
}

/** The one decision of which sender recipes this assessment joins; the local ALM lane selects its cells with it. */
export function hasAlmIdentityEvidence(sender: RallarBlackBoxTestRecipe): boolean {
    return sender.commands.some(isIdentitySend) || readAlmReceiptRolesEntries(sender).length > 0 ||
        toTracedRequests(sender.commands).length > 0;
}

/** Every scenario declares the sender and the receiver; each declared role has exactly one agent of its own. */
function validateAlmConformanceRoles({ roles, participants }: AlmConformanceIdentityInput): readonly string[] {
    const declared: readonly string[] = roles;
    const issues = [
        ...REQUIRED_ALM_CONFORMANCE_ROLES.filter((role) => !roles.includes(role))
            .map((role) => `${role}: every ALM scenario declares this role.`),
        ...[...new Set(roles)].filter((role) => roles.indexOf(role) !== roles.lastIndexOf(role))
            .map((role) => `${role}: the run declares this role more than once.`),
        ...participants.filter((participant) => !declared.includes(participant.role))
            .map((participant) => `${participant.role}: the run does not declare this role.`),
        ...[...new Set(roles)].filter((role) =>
            participants.filter((participant) => participant.role === role).length !== 1
        )
            .map((role) => `${role}: a declared role needs exactly one envelope.`)
    ];
    if (new Set(participants.map((participant) => participant.agentId)).size !== participants.length) {
        issues.push('ALM identity assessment requires one distinct agent per role.');
    }
    return issues;
}

/** Full authored roots stay under the existing result bounds; compacted or partial evidence cannot pass. */
function readParticipant(
    runId: string,
    participant: AlmConformanceIdentityParticipant,
    issues: string[]
): RecordedAlmConformanceParticipant | undefined {
    const envelope = participant.result;
    const root = envelope?.result;
    const value = root?.value;
    if (
        !envelope || envelope.runId !== runId || envelope.agentId !== participant.agentId ||
        envelope.commandId !== participant.commandId || !envelope.ok || !root?.ok || root.status !== 'ok' ||
        root.commandId !== participant.commandId || root.kind !== 'recipe.run' || !isJsonRecordValue(value) ||
        value.recipeId !== participant.recipe.recipeId || !Array.isArray(value.results)
    ) {
        issues.push(`${participant.role}: missing, mismatched or failed recipe envelope.`);
        return undefined;
    }
    const recorded = value.results.filter(isRallarBlackBoxTestResult);
    const results = new Map(recorded.map((result) => [result.commandId, result]));
    const commands = participant.recipe.commands;
    if (
        recorded.length !== value.results.length || results.size !== value.results.length ||
        results.size !== commands.length ||
        new Set(commands.map((command) => command.commandId)).size !== commands.length ||
        commands.some((command) => {
            const result = command.commandId ? results.get(command.commandId) : undefined;
            return !result?.ok || result.status !== 'ok' || result.kind !== command.kind;
        })
    ) {
        issues.push(`${participant.role}: malformed, missing, duplicated or failed authored command evidence.`);
        return undefined;
    }
    return { participant, results };
}

interface SendIdentitiesInput {
    readonly sends: readonly AlmIdentitySend[];
    readonly sender: RecordedAlmConformanceParticipant;
    readonly receiver: RecordedAlmConformanceParticipant;
}

interface SendIdentityJoin extends AlmReceivedTraceIdentityInput {
    readonly send: AlmIdentitySend;
    readonly sender: RecordedAlmConformanceParticipant;
}

/** Each send's generated identity is unique and in the trace grammar before any receiver joins it. */
function assessSendIdentities({ sends, sender, receiver }: SendIdentitiesInput): readonly string[] {
    const issues: string[] = [];
    const ids = new Set<string>();
    for (const send of sends) {
        const value = sender.results.get(send.commandId!)?.value;
        const msgId = isJsonRecordValue(value) ? value.msgId : undefined;
        if (typeof msgId !== 'string' || msgId.length === 0 || ids.has(msgId)) {
            issues.push(`${send.commandId}: generated message identity is missing or duplicated.`);
            continue;
        }
        ids.add(msgId);
        const traceId = decodeALTraceId(isJsonRecordValue(value) ? value.traceId : undefined).foldRight((id) => id);
        if (traceId === undefined) {
            issues.push(`${send.commandId}: generated trace identity is missing or invalid.`);
            continue;
        }
        issues.push(...assessSendIdentity({ send, msgId, traceId, sender, receiver }));
    }
    return issues;
}

/** Fallback cells join only the counted copies; the lifecycle and reload joins also read the exact envelope. */
function assessSendIdentity(join: SendIdentityJoin): readonly string[] {
    const { send, sender, receiver } = join;
    const payload = send.payload;
    return [
        ...assessAlmReceivedTraceIdentity(join),
        ...(payload.marker === 'delivery-reload' || payload.specimen === 'submission' ||
                payload.revision === 'replacement'
            ? assessReceivedIdentity(join)
            : []),
        ...(payload.specimen === 'submission' ? assessAlmAcknowledgedIdentity({ send, sender, receiver }) : [])
    ];
}

function assessReceivedIdentity({ send, msgId, traceId, receiver }: SendIdentityJoin): readonly string[] {
    const waits = receiver.participant.recipe.commands.filter((command) =>
        command.kind === 'wait' && command.absent !== true && command.match.kind === 'message' &&
        command.match.payloadPath === 'data.payload' &&
        isSameJsonValue(command.match.equals, decodeJsonValue(send.payload))
    );
    if (waits.length !== 1) {
        return [`${send.commandId}: exactly one authored receiver wait is required.`];
    }
    const value = toRecordedAlmResultValue(receiver, waits[0]);
    const data = toAlmJsonPathValue(value, 'event.payload.data');
    const matches = isJsonRecordValue(value) && value.matched === true && isJsonRecordValue(data) &&
        data.msgId === msgId && data.traceId === traceId && data.typeId === send.typeId &&
        toArrivalTransports(send).some((carrier) => carrier === data.transport) &&
        isSameJsonValue(decodeJsonValue(data.payload), decodeJsonValue(send.payload));
    return matches ? [] : [`${send.commandId}: receiver envelope does not match the actual generated message.`];
}

type AlmIdentitySend = RallarBlackBoxTestMessagesSendCommand & { readonly payload: AlmIdentitySendPayload; };

interface AlmIdentitySendPayload {
    readonly marker: 'delivery-lifecycle' | 'delivery-reload' | AlmFallbackMarker;
    readonly specimen?: 'submission' | 'cancellation' | 'supersedence';
    readonly revision?: 'old' | 'replacement';
}

function isIdentitySend(command: RallarBlackBoxTestCommand): command is AlmIdentitySend {
    return isRallarBlackBoxTestMessagesSendCommand(command) && isAlmIdentitySendPayload(command.payload);
}

function isAlmIdentitySendPayload(value: unknown): value is AlmIdentitySendPayload {
    return isJsonRecordValue(value) &&
        (value.marker === 'delivery-lifecycle' || value.marker === 'delivery-reload' ||
            isAlmFallbackMarker(value.marker)) &&
        (value.specimen === undefined || value.specimen === 'submission' || value.specimen === 'cancellation' ||
            value.specimen === 'supersedence') &&
        (value.revision === undefined || value.revision === 'old' || value.revision === 'replacement');
}
