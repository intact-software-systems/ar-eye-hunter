import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { resolveALMessageExpireAtMs } from '@shared/al-contracts/al-policy.ts';
import type { ALInboundMessageReference } from '@shared/alm/inbound/al-inbound-canonical-message.ts';
import type { ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { GroupRef, GroupScope } from '@shared/api/group-types.ts';
import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '../protocol/json-wire-identity.ts';
import { decodeLiveWsAudience, matchesLiveWsAudience } from './live-ws-audience.ts';

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

interface EncodedLiveWsNotice {
    readonly serialized: string;
    readonly notice: LiveWsNotice;
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
    const inlineEncoded = toEncodedLiveWsNotice(inline, input.channel);
    const inlineBytes = new TextEncoder().encode(inlineEncoded.serialized).length;
    if (inlineBytes < MAX_LIVE_WS_NOTICE_BYTES) {
        return { kind: 'inline', ...inlineEncoded };
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
    const keyEncoded = toEncodedLiveWsNotice(key, input.channel);
    const keyBytes = new TextEncoder().encode(keyEncoded.serialized).length;
    if (keyBytes >= MAX_LIVE_WS_NOTICE_BYTES) {
        return { kind: 'oversize', inlineBytes, keyBytes };
    }
    return { kind: 'inbound-key', ...keyEncoded };
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
            const audience = decodeLiveWsAudience(wire.audience, wire.scope);
            if (!audience) {
                return undefined;
            }
            const decoded = decodeALMessageValue(wire.message);
            const message = decoded.right;
            if (decoded.left || !message) {
                return undefined;
            }
            const alExpiresAtMs = resolveALMessageExpireAtMs(message);
            if (
                (alExpiresAtMs !== undefined && wire.expiresAtMs > alExpiresAtMs) ||
                !matchesLiveWsAudience(message, audience)
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
                message
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

function toEncodedLiveWsNotice(
    notice: LiveWsNotice,
    channel: string
): EncodedLiveWsNotice {
    decodeJsonWireValue(notice.scope, 'Live WS scope');
    if (notice.delivery === 'inline') {
        decodeJsonWireValue(notice.audience, 'Live WS audience');
        if (decodeALMessageValue(notice.message).left) {
            throw new TypeError('Live WS message is invalid.');
        }
    }
    else {
        decodeJsonWireValue(notice.inbound, 'Live WS inbound reference');
    }
    const jsonClean = JSON.parse(JSON.stringify(notice));
    const decoded = decodeLiveWsNoticeShape(jsonClean, channel, -1);
    if (!decoded) {
        throw new TypeError('Live WS notice is invalid.');
    }
    return { serialized: JSON.stringify(decoded), notice: decoded };
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
