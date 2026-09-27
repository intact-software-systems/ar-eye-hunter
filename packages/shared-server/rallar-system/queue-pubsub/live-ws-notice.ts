import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALInboundMessageReference } from '@shared/alm/inbound/al-inbound-canonical-message.ts';
import type { ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { GroupRef, GroupScope } from '@shared/api/group-types.ts';
import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '../protocol/json-wire-identity.ts';

export const MAX_LIVE_WS_NOTICE_BYTES = 8_000;
const BASE_NOTICE_KEYS = [
    'kind',
    'version',
    'channel',
    'publisherId',
    'scope',
    'expiresAtMs',
    'delivery'
] as const;

export type LiveWsAudience =
    | { readonly mode: 'room'; readonly groupRef: GroupRef; readonly recipientSessionIds: readonly string[]; }
    | { readonly mode: 'peer'; readonly recipientSessionIds: readonly string[]; }
    | {
        readonly mode: 'principal';
        readonly principalRef: ClientPrincipalRef;
        readonly recipientSessionIds: readonly string[];
    }
    | { readonly mode: 'broad'; readonly targetMode: 'all' | 'world'; };

export interface LiveWsInboundReference {
    readonly namespace: string;
    readonly reference: ALInboundMessageReference;
}

interface LiveWsNoticeBase {
    readonly kind: 'live-ws';
    readonly version: 1;
    readonly channel: string;
    readonly publisherId: string;
    readonly scope: GroupScope;
    readonly expiresAtMs: number;
}

export type LiveWsNotice =
    | (LiveWsNoticeBase & {
        readonly delivery: 'inline';
        readonly audience: LiveWsAudience;
        readonly message: ALMessage;
    })
    | (LiveWsNoticeBase & {
        readonly delivery: 'inbound-key';
        readonly audienceMode: LiveWsAudience['mode'];
        readonly inbound: LiveWsInboundReference;
    });

export interface LiveWsPublicationInput {
    readonly channel: string;
    readonly publisherId: string;
    readonly scope: GroupScope;
    readonly expiresAtMs: number;
    readonly audience: LiveWsAudience;
    readonly message: ALMessage;
    readonly inbound?: LiveWsInboundReference;
}

export type EncodeLiveWsNoticeResult =
    | { readonly kind: 'inline' | 'inbound-key'; readonly serialized: string; readonly notice: LiveWsNotice; }
    | { readonly kind: 'oversize'; readonly inlineBytes: number; readonly keyBytes: number | undefined; };

export interface LiveWsNoticeTransport {
    publish(notice: LiveWsNotice): Promise<void>;
    subscribe(channel: string, onNotice: (notice: LiveWsNotice) => Promise<void> | void): Promise<void>;
}

export function encodeLiveWsNotice(input: LiveWsPublicationInput): EncodeLiveWsNoticeResult {
    const common = {
        kind: 'live-ws' as const,
        version: 1 as const,
        channel: input.channel,
        publisherId: input.publisherId,
        scope: input.scope,
        expiresAtMs: input.expiresAtMs
    };
    const inline = { ...common, delivery: 'inline' as const, audience: input.audience, message: input.message };
    const inlineSerialized = serializeLiveWsNotice(inline, input.channel);
    const inlineBytes = new TextEncoder().encode(inlineSerialized).length;
    if (inlineBytes < MAX_LIVE_WS_NOTICE_BYTES) {
        return { kind: 'inline', serialized: inlineSerialized, notice: inline };
    }

    if (input.inbound === undefined) {
        return { kind: 'oversize', inlineBytes, keyBytes: undefined };
    }
    if (
        input.inbound.reference.senderId !== input.message.id.senderId ||
        input.inbound.reference.msgId !== input.message.id.msgId
    ) {
        throw new TypeError('Live WS inbound reference does not identify the final message.');
    }
    const key = {
        ...common,
        delivery: 'inbound-key' as const,
        audienceMode: input.audience.mode,
        inbound: input.inbound
    };
    const keySerialized = serializeLiveWsNotice(key, input.channel);
    const keyBytes = new TextEncoder().encode(keySerialized).length;
    if (keyBytes >= MAX_LIVE_WS_NOTICE_BYTES) {
        return { kind: 'oversize', inlineBytes, keyBytes };
    }
    return { kind: 'inbound-key', serialized: keySerialized, notice: key };
}

export function decodeLiveWsNotice(value: unknown, expectedChannel: string, nowMs: number): LiveWsNotice | undefined {
    let serialized: string;
    try {
        decodeJsonWireValue(value, 'Live WS notice');
        serialized = JSON.stringify(value);
    }
    catch {
        return undefined;
    }
    if (new TextEncoder().encode(serialized).length >= MAX_LIVE_WS_NOTICE_BYTES) {
        return undefined;
    }
    return decodeLiveWsNoticeShape(value, expectedChannel, nowMs);
}

function decodeLiveWsNoticeShape(value: unknown, expectedChannel: string, nowMs: number): LiveWsNotice | undefined {
    try {
        const wire = decodeJsonWireValue(value, 'Live WS notice');
        if (
            !isRecord(wire) ||
            wire.kind !== 'live-ws' || wire.version !== 1 || wire.channel !== expectedChannel ||
            !isNonEmptyString(wire.publisherId) || !isScope(wire.scope) ||
            !Number.isSafeInteger(wire.expiresAtMs) || typeof wire.expiresAtMs !== 'number' ||
            wire.expiresAtMs <= nowMs
        ) {
            return undefined;
        }
        if (wire.delivery === 'inline' && hasKeys(wire, [...BASE_NOTICE_KEYS, 'audience', 'message'])) {
            const audience = decodeAudience(wire.audience, wire.scope);
            if (!audience) {
                return undefined;
            }
            const decoded = decodeALMessageValue(wire.message);
            if (
                decoded.left || decoded.right?.constraints?.expiresAtMs !== wire.expiresAtMs ||
                !matchesAudience(decoded.right, audience)
            ) {
                return undefined;
            }
            return {
                kind: 'live-ws',
                version: 1,
                channel: expectedChannel,
                publisherId: wire.publisherId,
                scope: wire.scope,
                expiresAtMs: wire.expiresAtMs,
                audience,
                delivery: 'inline',
                message: decoded.right
            };
        }
        if (
            wire.delivery === 'inbound-key' && hasKeys(wire, [...BASE_NOTICE_KEYS, 'audienceMode', 'inbound']) &&
            isAudienceMode(wire.audienceMode) && isInboundReference(wire.inbound)
        ) {
            return {
                kind: 'live-ws',
                version: 1,
                channel: expectedChannel,
                publisherId: wire.publisherId,
                scope: wire.scope,
                expiresAtMs: wire.expiresAtMs,
                delivery: 'inbound-key',
                audienceMode: wire.audienceMode,
                inbound: wire.inbound
            };
        }
        return undefined;
    }
    catch {
        return undefined;
    }
}

function serializeLiveWsNotice(notice: LiveWsNotice, channel: string): string {
    const serialized = JSON.stringify(decodeJsonWireValue(notice, 'Live WS notice'));
    if (!decodeLiveWsNoticeShape(notice, channel, -1)) {
        throw new TypeError('Live WS notice is invalid.');
    }
    return serialized;
}

function decodeAudience(value: JsonWireValue, scope: GroupScope): LiveWsAudience | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    if (
        value.mode === 'room' && hasKeys(value, ['mode', 'groupRef', 'recipientSessionIds']) &&
        isGroupRef(value.groupRef, scope) && isSessionIds(value.recipientSessionIds)
    ) {
        return { mode: 'room', groupRef: value.groupRef, recipientSessionIds: value.recipientSessionIds };
    }
    if (
        value.mode === 'peer' && hasKeys(value, ['mode', 'recipientSessionIds']) &&
        isSessionIds(value.recipientSessionIds) && value.recipientSessionIds.length === 1
    ) {
        return { mode: 'peer', recipientSessionIds: value.recipientSessionIds };
    }
    if (
        value.mode === 'principal' && hasKeys(value, ['mode', 'principalRef', 'recipientSessionIds']) &&
        isPrincipalRef(value.principalRef, scope) && isSessionIds(value.recipientSessionIds)
    ) {
        return { mode: 'principal', principalRef: value.principalRef, recipientSessionIds: value.recipientSessionIds };
    }
    if (
        value.mode === 'broad' && hasKeys(value, ['mode', 'targetMode']) &&
        (value.targetMode === 'all' || value.targetMode === 'world')
    ) {
        return { mode: 'broad', targetMode: value.targetMode };
    }
    return undefined;
}

function matchesAudience(message: ALMessage, audience: LiveWsAudience): boolean {
    if (audience.mode === 'room') {
        const target = message.targets;
        return target !== undefined &&
            (target.mode === 'multicast' || (target.mode === 'broadcast' && target.scope === 'room')) &&
            target.groupRef?.applicationId === audience.groupRef.applicationId &&
            target.groupRef.workspaceId === audience.groupRef.workspaceId &&
            target.groupRef.groupId === audience.groupRef.groupId;
    }
    if (audience.mode === 'peer') {
        return message.targets?.mode === 'unicast' &&
            message.targets.toPeerId === audience.recipientSessionIds[0];
    }
    if (audience.mode === 'principal') {
        return message.targets?.mode === 'broadcast' && message.targets.scope === 'principal' &&
            message.targets.principalRef?.applicationId === audience.principalRef.applicationId &&
            message.targets.principalRef.workspaceId === audience.principalRef.workspaceId &&
            message.targets.principalRef.principalId === audience.principalRef.principalId;
    }
    return message.targets?.mode === 'broadcast' && message.targets.scope === audience.targetMode;
}

function isInboundReference(value: JsonWireValue): value is JsonWireObject & LiveWsInboundReference {
    return isRecord(value) && hasKeys(value, ['namespace', 'reference']) &&
        isNonEmptyString(value.namespace) && isRecord(value.reference) &&
        hasKeys(value.reference, ['senderId', 'msgId']) &&
        isNonEmptyString(value.reference.senderId) && isNonEmptyString(value.reference.msgId);
}

function isScope(value: JsonWireValue): value is JsonWireObject & GroupScope {
    return isRecord(value) && hasKeys(value, ['applicationId', 'workspaceId']) &&
        isNonEmptyString(value.applicationId) && isNonEmptyString(value.workspaceId);
}

function isGroupRef(value: JsonWireValue, scope: GroupScope): value is JsonWireObject & GroupRef {
    return isRecord(value) && hasKeys(value, ['applicationId', 'workspaceId', 'groupId']) &&
        value.applicationId === scope.applicationId && value.workspaceId === scope.workspaceId &&
        isNonEmptyString(value.groupId);
}

function isPrincipalRef(value: JsonWireValue, scope: GroupScope): value is JsonWireObject & ClientPrincipalRef {
    return isRecord(value) && hasKeys(value, ['applicationId', 'workspaceId', 'principalId']) &&
        value.applicationId === scope.applicationId && value.workspaceId === scope.workspaceId &&
        isNonEmptyString(value.principalId);
}

function isSessionIds(value: JsonWireValue): value is readonly string[] {
    return Array.isArray(value) && value.every(isNonEmptyString) && new Set(value).size === value.length;
}

function isAudienceMode(value: JsonWireValue): value is LiveWsAudience['mode'] {
    return value === 'room' || value === 'peer' || value === 'principal' || value === 'broad';
}

function isRecord(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasKeys(value: JsonWireObject, required: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === required.length && required.every((key) => Object.hasOwn(value, key));
}

function isNonEmptyString(value: JsonWireValue): value is string {
    return typeof value === 'string' && value.length > 0;
}
