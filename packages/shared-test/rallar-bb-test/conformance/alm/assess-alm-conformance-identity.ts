import { isRallarBlackBoxTestMessagesSendCommand } from '../../alm/is-rallar-black-box-test-messages-send-command.ts';
import { isRallarBlackBoxTestResult } from '../../composite-results.ts';
import type { ControlResultEnvelope } from '../../control-protocol.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesSendCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult
} from '../../rallar-black-box-test-contracts.ts';
import { decodeJsonValue } from '../../runtime/decode-runtime-result-values.ts';
import { isJsonRecordValue } from '../../schema/json-schema-validation.ts';
import { decodePayloadPathValue, isSameJsonValue } from '../../wait/wait-event-match.ts';
import type { AlmConformanceRole } from './alm-conformance-roles.ts';
import { assessAlmAcknowledgedIdentity } from './assess-alm-acknowledged-identity.ts';
import { assessAlmReloadIdentity } from './assess-alm-reload-identity.ts';

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
    const sends = sender.participant.recipe.commands.filter(isIdentitySend);
    if (sends.length === 0) {
        return ['ALM lifecycle or reload sender evidence is missing.'];
    }
    const ids = new Set<string>();
    for (const send of sends) {
        const value = sender.results.get(send.commandId!)?.value;
        const msgId = isJsonRecordValue(value) ? value.msgId : undefined;
        if (typeof msgId !== 'string' || msgId.length === 0 || ids.has(msgId)) {
            issues.push(`${send.commandId}: generated message identity is missing or duplicated.`);
            continue;
        }
        ids.add(msgId);
        if (
            send.payload.marker === 'delivery-reload' || send.payload.specimen === 'submission' ||
            send.payload.revision === 'replacement'
        ) {
            assessReceivedIdentity({ send, msgId, receiver, issues });
        }
        if (send.payload.specimen === 'submission') {
            issues.push(...assessAlmAcknowledgedIdentity({ send, sender, receiver }));
        }
    }
    issues.push(...assessAlmReloadIdentity(
        sender,
        receiver,
        sends.filter((send) => send.payload.marker === 'delivery-reload')
    ));
    return issues;
}

/** Every scenario declares the sender and the receiver; each declared role has exactly one agent of its own. */
function validateAlmConformanceRoles({ roles, participants }: AlmConformanceIdentityInput): readonly string[] {
    if (!roles.includes('sender') || !roles.includes('receiver') || new Set(roles).size !== roles.length) {
        return ['ALM identity assessment requires one distinct sender and receiver.'];
    }
    const undeclared = participants.filter((participant) => !(roles as readonly string[]).includes(participant.role))
        .map((participant) => `${participant.role}: the run does not declare this role.`);
    const miscounted = roles.filter((role) =>
        participants.filter((participant) => participant.role === role).length !== 1
    )
        .map((role) => `${role}: a declared role needs exactly one envelope.`);
    const issues = [...undeclared, ...miscounted];
    if (
        issues.length === 0 &&
        new Set(participants.map((participant) => participant.agentId)).size !== participants.length
    ) {
        return ['ALM identity assessment requires one distinct agent per role.'];
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

interface ReceivedIdentityInput {
    readonly send: RallarBlackBoxTestMessagesSendCommand;
    readonly msgId: string;
    readonly receiver: RecordedAlmConformanceParticipant;
    readonly issues: string[];
}

function assessReceivedIdentity({ send, msgId, receiver, issues }: ReceivedIdentityInput): void {
    const waits = receiver.participant.recipe.commands.filter((command) =>
        command.kind === 'wait' && command.absent !== true && command.match.kind === 'message' &&
        command.match.payloadPath === 'data.payload' &&
        isSameJsonValue(command.match.equals, decodeJsonValue(send.payload))
    );
    if (waits.length !== 1) {
        issues.push(`${send.commandId}: exactly one authored receiver wait is required.`);
        return;
    }
    const wait = waits[0];
    const value = receiver.results.get(wait.commandId!)?.value;
    const receivedId = decodePayloadPathValue(value, 'event.payload.data.msgId');
    const receivedType = decodePayloadPathValue(value, 'event.payload.data.typeId');
    const transport = decodePayloadPathValue(value, 'event.payload.data.transport');
    const payload = decodePayloadPathValue(value, 'event.payload.data.payload');
    if (
        !isJsonRecordValue(value) || value.matched !== true || !receivedId.exists || receivedId.value !== msgId ||
        !transport.exists || transport.value !== (send.carrier === 'ws' ? 'ws' : 'rtc') ||
        !receivedType.exists || receivedType.value !== send.typeId || !payload.exists ||
        !isSameJsonValue(payload.value, decodeJsonValue(send.payload))
    ) {
        issues.push(`${send.commandId}: receiver envelope does not match the actual generated message.`);
    }
}

interface AlmIdentitySendPayload {
    readonly marker: 'delivery-lifecycle' | 'delivery-reload';
    readonly specimen?: 'submission' | 'cancellation' | 'supersedence';
    readonly revision?: 'old' | 'replacement';
}

function isIdentitySend(
    command: RallarBlackBoxTestCommand
): command is RallarBlackBoxTestMessagesSendCommand & { readonly payload: AlmIdentitySendPayload; } {
    return isRallarBlackBoxTestMessagesSendCommand(command) && isAlmIdentitySendPayload(command.payload);
}

function isAlmIdentitySendPayload(value: unknown): value is AlmIdentitySendPayload {
    return isJsonRecordValue(value) &&
        (value.marker === 'delivery-lifecycle' || value.marker === 'delivery-reload') &&
        (value.specimen === undefined || value.specimen === 'submission' || value.specimen === 'cancellation' ||
            value.specimen === 'supersedence') &&
        (value.revision === undefined || value.revision === 'old' || value.revision === 'replacement');
}
