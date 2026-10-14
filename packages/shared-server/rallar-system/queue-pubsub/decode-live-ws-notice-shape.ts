import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { resolveALMessageExpireAtMs } from '@shared/al-contracts/al-policy.ts';
import type { GroupScope } from '@shared/api/group-types.ts';
import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '../protocol/json-wire-identity.ts';
import { decodeBroadLiveWsAudience, decodeLiveWsAudience, matchesLiveWsAudience } from './live-ws-audience.ts';
import type { LiveWsAudience, LiveWsInboundReference, LiveWsNotice } from './live-ws-notice.ts';

const BASE_NOTICE_KEYS = [
    'kind',
    'version',
    'channel',
    'publisherId',
    'expiresAtMs',
    'delivery'
] as const;
type LiveWsNoticeBase = Pick<LiveWsNotice, 'kind' | 'version' | 'channel' | 'publisherId' | 'expiresAtMs'>;

export function decodeLiveWsNoticeShape(
    value: unknown,
    expectedChannel: string,
    nowMs: number
): LiveWsNotice | undefined {
    try {
        const wire = decodeJsonWireValue(value, 'Live WS notice');
        if (
            !isRecord(wire) ||
            wire.kind !== 'live-ws' || wire.version !== 1 || wire.channel !== expectedChannel ||
            !isNonEmptyString(wire.publisherId) ||
            !Number.isSafeInteger(wire.expiresAtMs) || typeof wire.expiresAtMs !== 'number' ||
            wire.expiresAtMs <= nowMs
        ) {
            return undefined;
        }
        const base: LiveWsNoticeBase = {
            kind: 'live-ws',
            version: 1,
            channel: expectedChannel,
            publisherId: wire.publisherId,
            expiresAtMs: wire.expiresAtMs
        };
        if (wire.delivery === 'inline') {
            return decodeInlineLiveWsNotice(wire, base);
        }
        return wire.delivery === 'inbound-key' ? decodeKeyLiveWsNotice(wire, base) : undefined;
    }
    catch {
        return undefined;
    }
}

function decodeInlineLiveWsNotice(wire: JsonWireObject, base: LiveWsNoticeBase): LiveWsNotice | undefined {
    if (!isRecord(wire.audience)) {
        return undefined;
    }
    const unscoped = wire.audience.mode === 'broad' && wire.audience.targetMode === 'all';
    if (!hasKeys(wire, [...BASE_NOTICE_KEYS, ...(unscoped ? [] : ['scope']), 'audience', 'message'])) {
        return undefined;
    }
    const scope = unscoped ? undefined : (isScope(wire.scope) ? wire.scope : undefined);
    const audience = decodeLiveWsAudience(wire.audience, scope);
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
        (alExpiresAtMs !== undefined && base.expiresAtMs > alExpiresAtMs) ||
        !matchesLiveWsAudience(message, audience)
    ) {
        return undefined;
    }
    const common = { ...base, delivery: 'inline' as const, message };
    if (audience.mode === 'broad' && audience.targetMode === 'all') {
        return { ...common, audience };
    }
    if (!scope) {
        return undefined;
    }
    return { ...common, scope, audience };
}

function decodeKeyLiveWsNotice(wire: JsonWireObject, base: LiveWsNoticeBase): LiveWsNotice | undefined {
    if (!isAudienceMode(wire.audienceMode) || !isInboundReference(wire.inbound)) {
        return undefined;
    }
    const broad = wire.audienceMode === 'broad';
    const scoped = !broad || wire.targetMode === 'world';
    if (
        !hasKeys(wire, [
            ...BASE_NOTICE_KEYS,
            ...(broad ? ['targetMode'] : []),
            ...(scoped ? ['scope'] : []),
            'audienceMode',
            'inbound'
        ])
    ) {
        return undefined;
    }
    const common = { ...base, delivery: 'inbound-key' as const, inbound: wire.inbound };
    const scope = isScope(wire.scope) ? wire.scope : undefined;
    if (wire.audienceMode === 'broad') {
        const audience = decodeBroadLiveWsAudience(wire.targetMode, scope);
        if (audience?.targetMode === 'all') {
            return { ...common, audienceMode: 'broad', targetMode: 'all' };
        }
        return audience && scope ? { ...common, scope, audienceMode: 'broad', targetMode: 'world' } : undefined;
    }
    return scope ? { ...common, scope, audienceMode: wire.audienceMode } : undefined;
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
