import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { readConfiguredValue } from '@shared/cache/RepositoryManager.ts';
import {
    onAcceptedOverlayChange,
    onPlannedOverlayChange,
    readableAcceptedOverlayCache,
    readablePlannedOverlayCache,
    type OverlayRepositoryChangeListener
} from '@shared/repository/overlays-repository.ts';

export interface RallarRoomLayoutSlotsPort {
    readPlanned(roomRef: GroupRef): OverlayInfo | undefined;
    readAccepted(roomRef: GroupRef): OverlayInfo | undefined;
    onPlannedChange(listener: OverlayRepositoryChangeListener): RallarUnsubscribe;
    onAcceptedChange(listener: OverlayRepositoryChangeListener): RallarUnsubscribe;
}

/**
 * The overlay repositories exist only after connect configures them. A read
 * before that is an ordinary "no layout yet", and a subscription before that
 * observes nothing until the state cache change that follows connect re-reads
 * the slots through this same port.
 */
export function createRoomLayoutSlots(): RallarRoomLayoutSlotsPort {
    return {
        readPlanned: (roomRef) =>
            readConfiguredValue(() => readablePlannedOverlayCache().read(toScopedOverlayId(roomRef))),
        readAccepted: (roomRef) =>
            readConfiguredValue(() => readableAcceptedOverlayCache().read(toScopedOverlayId(roomRef))),
        onPlannedChange: (listener) => readConfiguredValue(() => onPlannedOverlayChange(listener)) ?? (() => {}),
        onAcceptedChange: (listener) => readConfiguredValue(() => onAcceptedOverlayChange(listener)) ?? (() => {})
    };
}
