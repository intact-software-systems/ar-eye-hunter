import type {
    RallarBlackBoxTestMessagesSendCommand,
    RallarBlackBoxTestResult
} from '../../../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../../../schema/json-schema-validation.ts';
import type { RecordedAlmConformanceParticipant } from './assess-alm-conformance-identity.ts';

export interface AlmAcknowledgedIdentityInput {
    readonly send: RallarBlackBoxTestMessagesSendCommand;
    readonly sender: RecordedAlmConformanceParticipant;
    readonly receiver: RecordedAlmConformanceParticipant;
}

/**
 * D28: receipts are read from the same sender evidence, correlated afterwards by the handle of the send. A ws receipt
 * names no hop: its recipient lists confirm the logical recipient, which must be the session of the receiver. An rtc
 * receipt confirms hops.
 */
export function assessAlmAcknowledgedIdentity(
    { send, sender, receiver }: AlmAcknowledgedIdentityInput
): readonly string[] {
    if (!send.handleId) {
        return [];
    }
    const value = resolveAlmEndingReceiptResult(sender, send.handleId)?.value;
    const peerLists = send.carrier === 'ws' ? 'RecipientPeerIds' : 'HopPeerIds';
    const confirmed = isJsonRecordValue(value) ? value[`confirmed${peerLists}`] : undefined;
    const unconfirmed = isJsonRecordValue(value) ? value[`unconfirmed${peerLists}`] : undefined;
    if (!Array.isArray(confirmed) || !Array.isArray(unconfirmed) || unconfirmed.length !== 0) {
        return [`${send.commandId}: sender receipts are missing or still wait for a peer.`];
    }
    if (send.carrier === 'ws') {
        const receiverSessionIds = toConnectedSessionIds(receiver);
        return confirmed.length === 1 && receiverSessionIds.some((sessionId) => sessionId === confirmed[0])
            ? []
            : [`${send.commandId}: sender receipts do not confirm the receiver as the one logical recipient.`];
    }
    return confirmed.length > 0 ? [] : [`${send.commandId}: sender receipts do not confirm an acknowledged hop.`];
}

/**
 * D28: the origin reads a handle's receipt after its window and may read it earlier too, mid-window. A join describes
 * the receipt the handle ended in, so it reads the sender's ending read of the handle: the last one its recipe makes.
 */
export function resolveAlmEndingReceiptResult(
    sender: RecordedAlmConformanceParticipant,
    handleId: string
): RallarBlackBoxTestResult | undefined {
    const ending = sender.participant.recipe.commands.filter((command) =>
        command.kind === 'messages.receipts' && command.handleId === handleId
    ).at(-1);
    return ending ? sender.results.get(ending.commandId!) : undefined;
}

/** Every session the participant connected as; a reconnect of the same page keeps its session. */
export function toConnectedSessionIds(participant: RecordedAlmConformanceParticipant): readonly string[] {
    return participant.participant.recipe.commands.flatMap((command) => {
        const value = command.kind === 'rtc.connect' ? participant.results.get(command.commandId!)?.value : undefined;
        return isJsonRecordValue(value) && typeof value.sessionId === 'string' ? [value.sessionId] : [];
    });
}
