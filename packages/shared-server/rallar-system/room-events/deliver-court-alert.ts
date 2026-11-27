import type { GroupRef } from '@shared/api/group-types.ts';
import { playerOffer } from '@shared/api/room-events/room-event-courts.ts';
import type { EventPushSubscription } from '@shared/api/room-events/room-event-alerts.ts';
import type { RoomEvent } from '@shared/api/room-events/room-event.ts';
import type { RoomEventCourtAlert } from './room-event-court-alert.ts';

export interface CourtAlertDelivery {
    readonly nowEpochMs: () => number;
    readonly readEvent: (lobby: GroupRef) => Promise<RoomEvent | null>;
    readonly canReceive: (lobby: GroupRef, principalId: string, now: number) => Promise<boolean>;
    readonly send: (subscription: EventPushSubscription, alert: RoomEventCourtAlert, deadline: number) => Promise<'accepted' | 'gone'>;
    readonly retireDevice: (alert: RoomEventCourtAlert) => Promise<void>;
}

export async function deliverCourtAlert(alert: RoomEventCourtAlert, delivery: CourtAlertDelivery): Promise<void> {
    const member = await delivery.canReceive(alert.lobby, alert.principalId, delivery.nowEpochMs());
    if (!member) return;
    const event = await delivery.readEvent(alert.lobby);
    if (!event || event.closed) return;
    const consent = event.alerts?.find(device => device.revision === alert.consentRevision && device.principalId === alert.principalId);
    const offer = playerOffer(event, alert.principalId);
    if (!consent || !offer || offer.offerRevision !== alert.offerRevision || offer.deadline === null || offer.deadline <= delivery.nowEpochMs()) return;
    if (await delivery.send(consent.subscription, alert, offer.deadline) === 'gone') await delivery.retireDevice(alert);
}
