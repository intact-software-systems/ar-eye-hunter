import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import {
    decodeALAdmissionNumber,
    decodeALAdmissionRecord,
    decodeALAdmissionString
} from '../../al-admission-value-validation.ts';

/** Auth owns this session-global authority; a payload type alone never grants it. */
export interface ALSessionInvalidationAuthority {
    readonly kind: 'auth-session-invalidation';
    readonly sessionId: string;
    readonly requestId: string;
    readonly invalidatedAtMs: number;
    readonly issuedAtMs: number;
    readonly expiresAtMs: number;
}

export function decodeALSessionInvalidationAuthority(value: unknown): ALSessionInvalidationAuthority {
    const authority = decodeALAdmissionRecord(value, [
        'kind',
        'sessionId',
        'requestId',
        'invalidatedAtMs',
        'issuedAtMs',
        'expiresAtMs'
    ]);
    if (authority.kind !== 'auth-session-invalidation') {
        throw new TypeError('Unsupported session-global authority');
    }
    const decoded: ALSessionInvalidationAuthority = {
        kind: authority.kind,
        sessionId: decodeALAdmissionString(authority.sessionId),
        requestId: decodeALAdmissionString(authority.requestId),
        invalidatedAtMs: decodeALAdmissionNumber(authority.invalidatedAtMs),
        issuedAtMs: decodeALAdmissionNumber(authority.issuedAtMs),
        expiresAtMs: decodeALAdmissionNumber(authority.expiresAtMs)
    };
    if (decoded.issuedAtMs > decoded.invalidatedAtMs || decoded.invalidatedAtMs >= decoded.expiresAtMs) {
        throw new TypeError('Invalid session invalidation lifetime');
    }
    return decoded;
}

export function validateALSessionInvalidationMessage(
    message: ALMessage,
    authority: ALSessionInvalidationAuthority
): readonly string[] {
    return message.targets?.mode === 'unicast' && message.targets.toPeerId === authority.sessionId &&
            message.route.topicId === 'auth.session.logout' && message.route.resourceId === authority.requestId &&
            message.route.contextId === authority.sessionId &&
            message.id.msgId === `auth-logout:${authority.requestId}` &&
            message.id.ts === authority.invalidatedAtMs && message.constraints?.expiresAtMs === authority.expiresAtMs &&
            message.payload.typeId === 'auth.session.logout.v1' && message.payload.contentType === 'application/json' &&
            message.payload.resource ===
                JSON.stringify({ sessionId: authority.sessionId, closeCode: 1000, reason: 'auth-logout' })
        ? []
        : ['Logout row differs from its exact session invalidation'];
}
