import type { CourtAlertMessage } from '@shared/api/room-events/court-alert-message.ts';
import { createECDH, ECDH } from 'node:crypto';
import { generateRequestDetails } from 'web-push';
import { requireExactKeys, requireRecord } from '@shared/api/exact-object-decoding.ts';
import { isBase64UrlOfByteLength } from '@shared/encoding/base64url.ts';
import { decodePushEndpoint, type EventPushSubscription } from '@shared/api/room-events/room-event-alerts.ts';
import { roomEventCourtAlertRoute, type RoomEventCourtAlert } from './room-event-court-alert.ts';

export namespace EventWebPush {
    export interface Credentials {
        readonly subject: string;
        readonly publicKey: string;
        readonly privateKey: string;
    }
}

export function decodeWebPushCredentials(text: string): EventWebPush.Credentials {
    const row = requireRecord(JSON.parse(text), 'VAPID credentials');
    requireExactKeys(row, ['subject','publicKey','privateKey'], 'VAPID credentials');
    if (typeof row.subject !== 'string' || !/^(mailto:|https:\/\/)/.test(row.subject) ||
        typeof row.publicKey !== 'string' || !isBase64UrlOfByteLength(row.publicKey, 65) ||
        typeof row.privateKey !== 'string' || !isBase64UrlOfByteLength(row.privateKey, 32)) throw new TypeError('Invalid VAPID configuration.');
    const pair = createECDH('prime256v1');
    pair.setPrivateKey(Buffer.from(row.privateKey, 'base64url'));
    if (pair.getPublicKey().toString('base64url') !== row.publicKey) throw new TypeError('Invalid VAPID key pair.');
    return { subject: row.subject, publicKey: row.publicKey, privateKey: row.privateKey };
}

/** Browser-provided endpoints are untrusted. Never forward signed requests through redirects. */
export function assertSupportedPushDevice(subscription: EventPushSubscription): void {
    const { hostname } = new URL(decodePushEndpoint(subscription.endpoint));
    if (!hostname.endsWith('.push.apple.com') && hostname !== 'fcm.googleapis.com' && hostname !== 'updates.push.services.mozilla.com') {
        throw new TypeError('Unsupported Web Push provider.');
    }
    try { ECDH.convertKey(Buffer.from(subscription.p256dh, 'base64url'), 'prime256v1'); }
    catch { throw new TypeError('Invalid device public key.'); }
}

export class EventWebPush {
    readonly publicKey: string;
    private readonly credentials: EventWebPush.Credentials;
    private readonly request: (url: string, request: RequestInit) => Promise<Response>;
    private readonly nowEpochMs: () => number;

    constructor(credentials: EventWebPush.Credentials, request: (url: string, request: RequestInit) => Promise<Response>, nowEpochMs: () => number) {
        this.credentials = credentials;
        this.request = request;
        this.nowEpochMs = nowEpochMs;
        this.publicKey = credentials.publicKey;
    }

    async send(device: EventPushSubscription, alert: RoomEventCourtAlert, deadline: number): Promise<'accepted' | 'gone'> {
        assertSupportedPushDevice(device);
        const topic = roomEventCourtAlertRoute(alert).resourceId.slice(0, 32);
        const payload = JSON.stringify({ type: 'rallar-court-ready', lobby: alert.lobby, offerRevision: alert.offerRevision, tag: topic } satisfies CourtAlertMessage);
        const details = generateRequestDetails({ endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } }, payload, {
            vapidDetails: this.credentials, contentEncoding: 'aes128gcm', topic, urgency: 'high',
            TTL: Math.max(0, Math.ceil((deadline - this.nowEpochMs()) / 1000))
        });
        const response = await this.request(details.endpoint, { method: 'POST', headers: Object.fromEntries(
            Object.entries(details.headers).map(([key,value]) => [key,String(value)])), redirect: 'error',
            body: details.body ? new Uint8Array(details.body) : null, signal: AbortSignal.timeout(10_000) });
        await response.body?.cancel();
        if (response.status === 404 || response.status === 410) return 'gone';
        if (!response.ok) throw new Error('Web Push provider returned HTTP ' + response.status);
        return 'accepted';
    }
}
