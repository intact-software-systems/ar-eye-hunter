import type { ResolvedWsMessageInput } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import type { RallarWsSendInput } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import {
    toBrowserMessageSendDefaults,
    type BrowserTypedChannelPolicy
} from '@shared-web/browser/messages/to-browser-message-send-defaults.ts';
import {
    newALRoute,
    type ALMessage,
    type newALUnicastMessage
} from '@shared/al-contracts/al-contract.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';

export interface CreateBrowserWsUnicastMessageInput<T> {
    readonly creation: Readonly<{ createUnicast: typeof newALUnicastMessage; newResourceId(): string; }>;
    readonly resolved: ResolvedWsMessageInput<T>;
    readonly peerId: string;
    /** The payload as the validator captured it; the message carries this copy, never the caller's object. */
    readonly serializedPayload: string;
    readonly senderId: string;
    readonly channel: BrowserTypedChannelPolicy | undefined;
    readonly laneTtlMs: number;
}

/**
 * A WS send to one peer (Q11): a unicast that names the room it resolved, so the room's authority admits it and the
 * room's router delivers it (D53). The channel's purpose fills what the send left out, with the addressee as the
 * logical audience when a room is named, so a `command` asks the addressee's receipt.
 */
export function createBrowserWsUnicastMessage<T>(
    input: CreateBrowserWsUnicastMessageInput<T>
): ALMessage {
    const { resolved } = input;
    const send = resolved.input;
    const defaults = toBrowserMessageSendDefaults({
        send,
        channel: input.channel,
        hasLogicalAudience: resolved.roomRef !== undefined,
        laneTtlMs: input.laneTtlMs
    });
    return input.creation.createUnicast(
        input.senderId,
        newALRoute(
            send.topicId ?? send.typeId,
            send.contextId ?? resolved.roomId ?? resolved.scope,
            send.resourceId ?? input.creation.newResourceId()
        ),
        input.peerId,
        send.typeId,
        JSON.parse(input.serializedPayload),
        {
            groupRef: resolved.roomRef,
            ttlMs: defaults.ttlMs,
            reliability: defaults.reliability,
            ack: defaults.ack,
            ownership: send.ownership ?? 'shared',
            qos: defaults.qos
        }
    );
}

/**
 * A peer-addressed WS send names its peer and carries no exclusions, no ordering, no snapshot floor and no hop limit:
 * the unicast it builds has no field for them, so they are refused rather than dropped (R-S3c-i-23).
 */
export function validateBrowserWsPeerInput<T>(
    input: RallarWsSendInput<T>
): readonly RallarValidationIssue[] {
    if (input.peerId === undefined) {
        return [];
    }
    const issues: RallarValidationIssue[] = [];
    if (input.peerId.length === 0) {
        issues.push({
            path: '$.peerId',
            code: 'missing-peer-id',
            message: 'A peer-addressed send names its peer.'
        });
    }
    if (
        input.exceptPeerIds !== undefined || input.orderingKey !== undefined ||
        input.seq !== undefined
    ) {
        issues.push({
            path: '$.peerId',
            code: 'unsupported',
            message: 'A peer-addressed send carries no exclusions and no ordering.'
        });
    }
    if (input.minSnapshotVersion !== undefined || input.ttlHops !== undefined) {
        issues.push({
            path: '$.peerId',
            code: 'unsupported',
            message: 'A peer-addressed send carries no snapshot floor and no hop limit.'
        });
    }
    return issues;
}
