import type { RoomEvent } from '@shared/api/room-events/room-event.ts';

export function pickupStatus(view: RoomEvent.View, expired: boolean): string {
    let current = view.queue ? 'Waiting for a court.' : 'Ready to join the queue.';
    if (view.offer) {
        current = (view.offer.deadline === null ? 'Court assigned: ' : 'Your court is ready: ') + view.offer.groupId;
    }
    return expired ? 'Your earlier offer has expired. ' + current : current;
}
