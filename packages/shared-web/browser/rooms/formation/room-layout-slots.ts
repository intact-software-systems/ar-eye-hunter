import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import { subscribeOverlaySlot } from '@shared-web/browser/state-cache/overlay-slot-subscriptions.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { readConfiguredValue } from '@shared/cache/RepositoryManager.ts';
import {
    findAcceptedOverlayById,
    findPlannedOverlayById,
    type OverlayRepositoryChangeListener
} from '@shared/repository/overlays-repository.ts';

export interface RallarRoomLayoutSlotsPort {
    readPlanned(roomRef: GroupRef): OverlayInfo | undefined;
    readAccepted(roomRef: GroupRef): OverlayInfo | undefined;
    onPlannedChange(listener: OverlayRepositoryChangeListener): RallarUnsubscribe;
    onAcceptedChange(listener: OverlayRepositoryChangeListener): RallarUnsubscribe;
}

/**
 * The overlay repositories exist only after connect configures them, and every
 * connect configures them afresh. A read before that is an ordinary "no layout
 * yet"; a subscription is kept by the slot registry and bound to the current
 * repositories whenever they are (re)configured.
 */
export function createRoomLayoutSlots(): RallarRoomLayoutSlotsPort {
    return {
        readPlanned: (roomRef) => readConfiguredValue(() => findPlannedOverlayById(toScopedOverlayId(roomRef))),
        readAccepted: (roomRef) => readConfiguredValue(() => findAcceptedOverlayById(toScopedOverlayId(roomRef))),
        onPlannedChange: (listener) => subscribeOverlaySlot('planned', listener),
        onAcceptedChange: (listener) => subscribeOverlaySlot('accepted', listener)
    };
}
