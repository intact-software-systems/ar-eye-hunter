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
    readonly participants: readonly AlmConformanceIdentityParticipant[];
}

export interface RecordedAlmConformanceParticipant {
    readonly participant: AlmConformanceIdentityParticipant;
    readonly results: ReadonlyMap<string, RallarBlackBoxTestResult>;
}

/** ALM's ordinary recipe assertions prove states; this boundary joins independently owned message identities. */
export function assessAlmConformanceIdentity(input: AlmConformanceIdentityInput): readonly string[] {
    const issues: string[] = [];
    const senders = input.participants.filter((participant) => participant.role === 'sender');
    const receivers = input.participants.filter((participant) => participant.role === 'receiver');
    if (senders.length !== 1 || receivers.length !== 1 || senders[0].agentId === receivers[0].agentId) {
        return ['ALM identity assessment requires one distinct sender and receiver.'];
    }
    const sender = readParticipant(input.runId, senders[0], issues);
    const receiver = readParticipant(input.runId, receivers[0], issues);
    if (!sender || !receiver) {
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
            assessAcknowledgedIdentity({ send, sender, issues });
        }
    }
    issues.push(...assessAlmReloadIdentity(
        sender,
        receiver,
        sends.filter((send) => send.payload.marker === 'delivery-reload')
    ));
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

interface AcknowledgedIdentityInput {
    readonly send: RallarBlackBoxTestMessagesSendCommand;
    readonly sender: RecordedAlmConformanceParticipant;
    readonly issues: string[];
}

/** D28: receipts are read from the same sender evidence, correlated afterwards by the send's handle. */
function assessAcknowledgedIdentity({ send, sender, issues }: AcknowledgedIdentityInput): void {
    if (send.carrier === 'ws' || !send.handleId) {
        return;
    }
    const receipts = sender.participant.recipe.commands.find((command) =>
        command.kind === 'messages.receipts' && command.handleId === send.handleId
    );
    const value = receipts ? sender.results.get(receipts.commandId!)?.value : undefined;
    const confirmed = isJsonRecordValue(value) ? value.confirmedHopPeerIds : undefined;
    const unconfirmed = isJsonRecordValue(value) ? value.unconfirmedHopPeerIds : undefined;
    if (
        !Array.isArray(confirmed) || confirmed.length === 0 ||
        !Array.isArray(unconfirmed) || unconfirmed.length !== 0
    ) {
        issues.push(`${send.commandId}: sender receipts do not confirm an acknowledged hop.`);
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
    return command.kind === 'messages.send' && isAlmIdentitySendPayload(command.payload);
}

function isAlmIdentitySendPayload(value: unknown): value is AlmIdentitySendPayload {
    return isJsonRecordValue(value) &&
        (value.marker === 'delivery-lifecycle' || value.marker === 'delivery-reload') &&
        (value.specimen === undefined || value.specimen === 'submission' || value.specimen === 'cancellation' ||
            value.specimen === 'supersedence') &&
        (value.revision === undefined || value.revision === 'old' || value.revision === 'replacement');
}
