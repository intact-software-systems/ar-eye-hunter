import { requireExactKeys, requirePositiveInteger, requireRecord } from '../exact-object-decoding.ts';
import { assertValidRallarRouteId } from '../rallar-validation.ts';
import type { RoomEvent } from './room-event.ts';

export interface EventPushSubscription {
    readonly endpoint: string;
    readonly p256dh: string;
    readonly auth: string;
}

export interface EventAlertConsent {
    readonly principalId: string;
    readonly revision: number;
    readonly subscription: EventPushSubscription;
}

export function decodePushEndpoint(value: unknown): string {
    if (typeof value !== 'string' || value.length > 2048) throw new TypeError('Invalid Web Push endpoint.');
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.href !== value) {
        throw new TypeError('Invalid Web Push endpoint.');
    }
    return value;
}

export function decodeEventPushSubscription(value: unknown): EventPushSubscription {
    const row = requireRecord(value, 'Push subscription');
    requireExactKeys(row, ['endpoint', 'p256dh', 'auth'], 'Push subscription');
    if (typeof row.p256dh !== 'string' || !/^B[A-Za-z0-9_-]{86}$/.test(row.p256dh) ||
        typeof row.auth !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(row.auth)) throw new TypeError('Invalid Web Push keys.');
    return { endpoint: decodePushEndpoint(row.endpoint), p256dh: row.p256dh, auth: row.auth };
}

export function decodeEventAlertConsent(value: unknown): EventAlertConsent {
    const row = requireRecord(value, 'Event alert consent');
    requireExactKeys(row, ['principalId', 'revision', 'subscription'], 'Event alert consent');
    requirePositiveInteger(row.revision, 'Consent revision');
    return { principalId: assertValidRallarRouteId(row.principalId), revision: Number(row.revision),
        subscription: decodeEventPushSubscription(row.subscription) };
}

export function withoutEventAlerts(event: RoomEvent, remove: (consent: EventAlertConsent) => boolean): RoomEvent {
    if (!event.alerts) return event;
    const alerts = event.alerts.filter(consent => !remove(consent));
    if (alerts.length === event.alerts.length) return event;
    const { alerts: previous, ...rest } = event;
    return alerts.length ? { ...rest, alerts } : rest;
}

export function enableEventAlerts(event: RoomEvent, principalId: string, subscription: EventPushSubscription): RoomEvent {
    const previous = event.alerts?.find(consent => consent.subscription.endpoint === subscription.endpoint);
    if (previous?.principalId === principalId && previous.subscription.auth === subscription.auth &&
        previous.subscription.p256dh === subscription.p256dh) return event;
    const alerts = event.alerts?.filter(consent => consent !== previous) ?? [];
    if (alerts.filter(consent => consent.principalId === principalId).length >= 8) throw new TypeError('Too many devices for this event.');
    return { ...event, alerts: [...alerts, { principalId, subscription, revision: event.revision + 1 }] };
}
