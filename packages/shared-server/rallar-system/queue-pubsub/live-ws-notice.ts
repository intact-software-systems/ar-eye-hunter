import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALInboundMessageReference } from '@shared/alm/inbound/al-inbound-canonical-message.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { GroupRef, GroupScope } from '@shared/api/group-types.ts';
import { decodeJsonWireValue } from '../protocol/json-wire-identity.ts';
import { decodeLiveWsNoticeShape } from './decode-live-ws-notice-shape.ts';

export const MAX_LIVE_WS_NOTICE_BYTES = 8_000;

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
    readonly expiresAtMs: number;
}

type ScopedLiveWsAudience = Exclude<LiveWsAudience, { readonly mode: 'broad'; }>;
type ScopedLiveWsAudienceMode = ScopedLiveWsAudience['mode'];

export type LiveWsNotice =
    | (LiveWsNoticeBase & {
        readonly delivery: 'inline';
        readonly audience: Extract<LiveWsAudience, { readonly mode: 'broad'; }>;
        readonly scope?: never;
        readonly message: ALMessage;
    })
    | (LiveWsNoticeBase & {
        readonly delivery: 'inline';
        readonly scope: GroupScope;
        readonly audience: ScopedLiveWsAudience;
        readonly message: ALMessage;
    })
    | (LiveWsNoticeBase & {
        readonly delivery: 'inbound-key';
        readonly audienceMode: 'broad';
        readonly targetMode: 'all' | 'world';
        readonly scope?: never;
        readonly inbound: LiveWsInboundReference;
    })
    | (LiveWsNoticeBase & {
        readonly delivery: 'inbound-key';
        readonly scope: GroupScope;
        readonly audienceMode: ScopedLiveWsAudienceMode;
        readonly inbound: LiveWsInboundReference;
    });

interface LiveWsPublicationBase {
    readonly channel: string;
    readonly publisherId: string;
    readonly expiresAtMs: number;
    readonly message: ALMessage;
    readonly inbound?: LiveWsInboundReference;
}

export type LiveWsPublicationInput =
    | (LiveWsPublicationBase & {
        readonly audience: Extract<LiveWsAudience, { readonly mode: 'broad'; }>;
        readonly scope?: never;
    })
    | (LiveWsPublicationBase & {
        readonly audience: ScopedLiveWsAudience;
        readonly scope: GroupScope;
    });

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
    if (input.audience.mode === 'broad' && Object.hasOwn(input, 'scope')) {
        throw new TypeError('Broad live WS notice cannot carry a scope.');
    }
    const inlineEncoded = toEncodedLiveWsNotice(toInlineLiveWsNotice(input), input.channel);
    const inlineBytes = new TextEncoder().encode(inlineEncoded.serialized).length;
    if (inlineBytes < MAX_LIVE_WS_NOTICE_BYTES) {
        return { kind: 'inline', ...inlineEncoded };
    }

    if (
        input.inbound === undefined || input.audience.mode === 'principal' ||
        (input.audience.mode === 'peer' && !isRtcSignalingPeerNotice(input))
    ) {
        return { kind: 'oversize', inlineBytes, keyBytes: undefined };
    }
    if (
        input.inbound.reference.senderId !== input.message.id.senderId ||
        input.inbound.reference.msgId !== input.message.id.msgId
    ) {
        throw new TypeError('Live WS inbound reference does not identify the final message.');
    }
    const keyEncoded = toEncodedLiveWsNotice(toKeyLiveWsNotice(input, input.inbound), input.channel);
    const keyBytes = new TextEncoder().encode(keyEncoded.serialized).length;
    if (keyBytes >= MAX_LIVE_WS_NOTICE_BYTES) {
        return { kind: 'oversize', inlineBytes, keyBytes };
    }
    return { kind: 'inbound-key', ...keyEncoded };
}

function toInlineLiveWsNotice(input: LiveWsPublicationInput): LiveWsNotice {
    const base = toLiveWsNoticeBase(input);
    if (input.audience.mode === 'broad') {
        return { ...base, delivery: 'inline', audience: input.audience, message: input.message };
    }
    if (input.scope === undefined) {
        throw new TypeError('Scoped live WS notice requires a scope.');
    }
    return { ...base, scope: input.scope, delivery: 'inline', audience: input.audience, message: input.message };
}

function toKeyLiveWsNotice(input: LiveWsPublicationInput, inbound: LiveWsInboundReference): LiveWsNotice {
    const base = toLiveWsNoticeBase(input);
    if (input.audience.mode === 'broad') {
        return {
            ...base,
            delivery: 'inbound-key',
            audienceMode: 'broad',
            targetMode: input.audience.targetMode,
            inbound
        };
    }
    if (input.scope === undefined) {
        throw new TypeError('Scoped live WS notice requires a scope.');
    }
    return {
        ...base,
        scope: input.scope,
        delivery: 'inbound-key',
        audienceMode: input.audience.mode === 'peer' ? 'peer' : 'room',
        inbound
    };
}

function isRtcSignalingPeerNotice(input: LiveWsPublicationInput): boolean {
    return input.audience.mode === 'peer' && input.message.route.topicId === AppTopics.rtcSignaling &&
        input.message.payload.typeId === AppTopics.rtcSignaling;
}

function toLiveWsNoticeBase(input: LiveWsPublicationInput): LiveWsNoticeBase {
    return {
        kind: 'live-ws',
        version: 1,
        channel: input.channel,
        publisherId: input.publisherId,
        expiresAtMs: input.expiresAtMs
    };
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

function toEncodedLiveWsNotice(
    notice: LiveWsNotice,
    channel: string
): EncodedLiveWsNotice {
    if (Object.hasOwn(notice, 'scope')) {
        decodeJsonWireValue(notice.scope, 'Live WS scope');
    }
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
