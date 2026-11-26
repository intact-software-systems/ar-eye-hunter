import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { decodeCourtAlertMessage, type CourtAlertMessage } from '@shared/api/room-events/court-alert-message.ts';
import type { RoomEvent } from '@shared/api/room-events/room-event.ts';

export function courtReadyNotification(value: unknown) {
    const message = decodeCourtAlertMessage(value);
    return { title: 'Your court is ready', options: { body: 'Open the event to see your assignment.',
        tag: message.tag, data: message } satisfies NotificationOptions };
}

/** Always navigate within the worker registration. The payload has no user-supplied navigation URL. */
export function courtAlertLaunchUrl(scope: string, value: unknown): URL {
    const target = new URL('./', scope);
    target.hash = new URLSearchParams({ courtAlert: JSON.stringify(decodeCourtAlertMessage(value)) }).toString();
    return target;
}

export function readCourtAlertLaunch(location: URL): CourtAlertMessage | null {
    const raw = new URLSearchParams(location.hash.slice(1)).get('courtAlert');
    return raw === null ? null : decodeCourtAlertMessage(JSON.parse(raw));
}

export function courtAlertStatus(launch: CourtAlertMessage | null, view: Pick<RoomEvent.View, 'offer' | 'lobby'>,
    serverTime: number | undefined): 'current' | 'expired' | 'unknown' | null {
    if (!launch || !isSameGroupRef(launch.lobby, view.lobby)) return null;
    if (!view.offer || view.offer.offerRevision !== launch.offerRevision) return 'expired';
    if (view.offer.deadline === null) return 'current';
    if (serverTime === undefined) return 'unknown';
    return serverTime >= view.offer.deadline ? 'expired' : 'current';
}
