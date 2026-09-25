import type { RallarBlackBoxTestMessagesSendCommand } from '../../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../../schema/json-schema-validation.ts';
import type { RecordedAlmConformanceParticipant } from './assess-alm-conformance-identity.ts';

export interface AlmAcknowledgedIdentityInput {
    readonly send: RallarBlackBoxTestMessagesSendCommand;
    readonly sender: RecordedAlmConformanceParticipant;
    readonly receiver: RecordedAlmConformanceParticipant;
}

/**
 * D28: receipts are read from the same sender evidence, correlated afterwards by the send's handle. A ws receipt
 * confirms the logical recipient, which must be the receiver's own session; an rtc receipt confirms hops.
 */
export function assessAlmAcknowledgedIdentity(
    { send, sender, receiver }: AlmAcknowledgedIdentityInput
): readonly string[] {
    if (!send.handleId) {
        return [];
    }
    const receipts = sender.participant.recipe.commands.find((command) =>
        command.kind === 'messages.receipts' && command.handleId === send.handleId
    );
    const value = receipts ? sender.results.get(receipts.commandId!)?.value : undefined;
    const confirmed = isJsonRecordValue(value) ? value.confirmedHopPeerIds : undefined;
    const unconfirmed = isJsonRecordValue(value) ? value.unconfirmedHopPeerIds : undefined;
    if (!Array.isArray(confirmed) || !Array.isArray(unconfirmed) || unconfirmed.length !== 0) {
        return [`${send.commandId}: sender receipts are missing or still wait for a peer.`];
    }
    if (send.carrier === 'ws') {
        const receiverSessionIds = toReceiverSessionIds(receiver);
        return confirmed.length === 1 && receiverSessionIds.some((sessionId) => sessionId === confirmed[0])
            ? []
            : [`${send.commandId}: sender receipts do not confirm the receiver as the one logical recipient.`];
    }
    return confirmed.length > 0 ? [] : [`${send.commandId}: sender receipts do not confirm an acknowledged hop.`];
}

function toReceiverSessionIds(receiver: RecordedAlmConformanceParticipant): readonly string[] {
    return receiver.participant.recipe.commands.flatMap((command) => {
        const value = command.kind === 'rtc.connect' ? receiver.results.get(command.commandId!)?.value : undefined;
        return isJsonRecordValue(value) && typeof value.sessionId === 'string' ? [value.sessionId] : [];
    });
}
