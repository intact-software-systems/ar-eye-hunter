import type { ResolvedWsMessageInput } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import type {
    RallarMessagePayload,
    RallarTypedMessageSendStrategy,
    RallarWsSendInput
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import {
    toBrowserMessageSendDefaults,
    type BrowserTypedChannelPolicy
} from '@shared-web/browser/messages/to-browser-message-send-defaults.ts';
import {
    newALRoute,
    type ALMessage,
    type newALUnicastMessage
} from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    validateRallarRouteId,
    type RallarValidationIssue
} from '@shared/api/rallar-validation.ts';

export type BrowserPeerSendStrategy = Exclude<RallarTypedMessageSendStrategy, 'ws-then-rtc'>;

export interface CreateBrowserUnicastMessageInput<T> {
    readonly creation: Readonly<{ createUnicast: typeof newALUnicastMessage; newResourceId(): string; }>;
    readonly resolved: ResolvedWsMessageInput<T>;
    readonly peerId: string;
    readonly payload: RallarMessagePayload;
    readonly senderId: string;
    readonly channel: BrowserTypedChannelPolicy | undefined;
    readonly laneTtlMs: number;
}

export interface ValidateBrowserPeerInput<T> {
    readonly send: RallarWsSendInput<T>;
    readonly roomRef: GroupRef | undefined;
}

export interface ValidateBrowserPeerServerInput {
    readonly peerId: string | undefined;
    readonly strategy: BrowserPeerSendStrategy;
    readonly serverPeerId: string | undefined;
}

export function createBrowserUnicastMessage<T>(
    input: CreateBrowserUnicastMessageInput<T>
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
        input.payload,
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

export function validateBrowserPeerInput<T>(
    input: ValidateBrowserPeerInput<T>
): readonly RallarValidationIssue[] {
    const { send } = input;
    if (send.peerId === undefined) {
        return [];
    }
    return [
        ...validatePeerId(send.peerId),
        ...validatePeerCarriage(send),
        ...validatePeerContext(send.contextId, input.roomRef)
    ];
}

export function validateBrowserPeerServer(
    input: ValidateBrowserPeerServerInput
): readonly RallarValidationIssue[] {
    if (input.peerId === undefined) {
        return [];
    }
    if (input.strategy !== 'ws' && input.peerId === input.serverPeerId) {
        return [{
            path: '$.peerId',
            code: 'unsupported',
            message: 'The server is addressed over WS: a peer-addressed send to it takes the ws strategy.'
        }];
    }
    return input.strategy === 'rtc' || input.serverPeerId !== undefined ? [] : [{
        path: '$.peerId',
        code: 'unsupported',
        message: 'A peer-addressed send needs a server that names its peer id; this server names none.'
    }];
}

function validatePeerId(peerId: string): readonly RallarValidationIssue[] {
    return peerId.length === 0
        ? [{
            path: '$.peerId',
            code: 'missing-peer-id',
            message: 'A peer-addressed send names its peer.'
        }]
        : validateRallarRouteId(peerId, '$.peerId', 'Peer ID').issues;
}

function validatePeerCarriage<T>(send: RallarWsSendInput<T>): readonly RallarValidationIssue[] {
    const issues: RallarValidationIssue[] = [];
    if (
        send.exceptPeerIds !== undefined || send.orderingKey !== undefined || send.seq !== undefined
    ) {
        issues.push({
            path: '$.peerId',
            code: 'unsupported',
            message: 'A peer-addressed send carries no exclusions and no ordering.'
        });
    }
    if (send.minSnapshotVersion !== undefined || send.ttlHops !== undefined) {
        issues.push({
            path: '$.peerId',
            code: 'unsupported',
            message: 'A peer-addressed send carries no snapshot floor and no hop limit.'
        });
    }
    return issues;
}

function validatePeerContext(
    contextId: string | undefined,
    roomRef: GroupRef | undefined
): readonly RallarValidationIssue[] {
    return roomRef === undefined || contextId === undefined || contextId === roomRef.groupId
        ? []
        : [{
            path: '$.contextId',
            code: 'context-room-mismatch',
            message: 'A peer-addressed send routes in the room it names: contextId must equal the room id.'
        }];
}
