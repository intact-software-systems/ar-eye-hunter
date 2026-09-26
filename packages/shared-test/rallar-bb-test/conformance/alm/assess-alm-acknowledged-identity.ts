import type { RallarBlackBoxTestMessagesSendCommand } from '../../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../../schema/json-schema-validation.ts';
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
    const receipts = sender.participant.recipe.commands.find((command) =>
        command.kind === 'messages.receipts' && command.handleId === send.handleId
    );
    const value = receipts ? sender.results.get(receipts.commandId!)?.value : undefined;
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

/** Every session the participant connected as; a reconnect of the same page keeps its session. */
export function toConnectedSessionIds(participant: RecordedAlmConformanceParticipant): readonly string[] {
    return participant.participant.recipe.commands.flatMap((command) => {
        const value = command.kind === 'rtc.connect' ? participant.results.get(command.commandId!)?.value : undefined;
        return isJsonRecordValue(value) && typeof value.sessionId === 'string' ? [value.sessionId] : [];
    });
}
