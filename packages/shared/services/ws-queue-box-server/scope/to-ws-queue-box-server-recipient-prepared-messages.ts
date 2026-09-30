import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALOutboundScopeAuthority } from '../../../alm/outbound/admission/al-outbound-scope-authority.ts';
import { toALOutboundTransportMessage } from '../../../alm/outbound/al-outbound-transport-message.ts';
import type { Key } from '../../../queuebox/ResourceEntry.ts';
import type { WsServerResolvedRecipient } from '../ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerPreparedMessage } from '../ws-queue-box-server-outbound-planning.ts';
import { isWsQueueBoxServerDirectScopedBroadcastRow } from './requires-ws-queue-box-server-recipient-scope.ts';

export interface ToWsQueueBoxServerRecipientPreparedMessagesInput {
    readonly message: ALMessage;
    readonly recipients: readonly WsServerResolvedRecipient[];
    readonly authority: ALOutboundScopeAuthority;
    readonly referenceKey: Key | undefined;
    readonly readConnectionGeneration: (connectionId: string) => string | undefined;
}

type ToGenerationBoundPreparedMessage = (
    recipient: WsServerResolvedRecipient,
    generationId: string
) => WsQueueBoxServerPreparedMessage;

/**
 * A recipient whose send rechecks its connection is bound to the socket generation seen at planning. Canonical room
 * fan-out keeps plain recipients, as before: only a room unicast and a direct room row recheck the group's scope.
 */
export function toWsQueueBoxServerRecipientPreparedMessages(
    input: ToWsQueueBoxServerRecipientPreparedMessagesInput
): readonly WsQueueBoxServerPreparedMessage[] {
    const { message, authority } = input;
    switch (authority.kind) {
        case 'session-invalidation':
            return toGenerationBoundPreparedMessages(input, (recipient, generationId) => ({
                kind: 'invalidated-session',
                ...recipient,
                generationId,
                sessionInvalidation: authority.sessionInvalidation,
                message: toALOutboundTransportMessage(message)
            }));
        case 'recipient-scope':
            return toGenerationBoundPreparedMessages(input, (recipient, generationId) => ({
                kind: 'scoped-recipient',
                ...recipient,
                generationId,
                recipientScope: authority.recipientScope,
                ...(authority.principalTargetId === undefined
                    ? {}
                    : { principalTargetId: authority.principalTargetId }),
                message: toALOutboundTransportMessage(message)
            }));
        case 'group-ref':
            return message.targets?.mode === 'unicast' ||
                    isWsQueueBoxServerDirectScopedBroadcastRow(message, input.referenceKey)
                ? toGenerationBoundPreparedMessages(input, (recipient, generationId) => ({
                    kind: 'room-recipient',
                    ...recipient,
                    generationId,
                    message: toALOutboundTransportMessage(message)
                }))
                : toWsQueueBoxServerUnscopedPreparedMessages(message, input.recipients);
        case 'none':
            return toWsQueueBoxServerUnscopedPreparedMessages(message, input.recipients);
    }
}

export function toWsQueueBoxServerUnscopedPreparedMessages(
    message: ALMessage,
    recipients: readonly WsServerResolvedRecipient[]
): readonly WsQueueBoxServerPreparedMessage[] {
    return recipients.map((recipient) => ({
        kind: 'recipient',
        peerId: recipient.peerId,
        connectionId: recipient.connectionId,
        message: toALOutboundTransportMessage(message)
    }));
}

function toGenerationBoundPreparedMessages(
    input: ToWsQueueBoxServerRecipientPreparedMessagesInput,
    toPrepared: ToGenerationBoundPreparedMessage
): readonly WsQueueBoxServerPreparedMessage[] {
    return input.recipients.flatMap((recipient) => {
        const generationId = input.readConnectionGeneration(recipient.connectionId);
        return generationId === undefined ? [] : [toPrepared(recipient, generationId)];
    });
}
