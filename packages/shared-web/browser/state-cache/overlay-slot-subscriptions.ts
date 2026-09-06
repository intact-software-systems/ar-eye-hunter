import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import { readConfiguredValue } from '@shared/cache/RepositoryManager.ts';
import {
    onAcceptedOverlayChange,
    onPlannedOverlayChange,
    type OverlayRepositoryChangeListener
} from '@shared/repository/overlays-repository.ts';

export type OverlaySlotRole = 'planned' | 'accepted';

interface OverlaySlotRegistry {
    readonly listeners: Set<OverlayRepositoryChangeListener>;
    readonly bindings: Map<OverlayRepositoryChangeListener, RallarUnsubscribe>;
}

const registries: Readonly<Record<OverlaySlotRole, OverlaySlotRegistry>> = {
    planned: { listeners: new Set(), bindings: new Map() },
    accepted: { listeners: new Set(), bindings: new Map() }
};

/**
 * Connect replaces the overlay repositories, and a listener bound to a replaced
 * instance never fires again. The registry keeps every listener for the life
 * of its subscription and binds it to whichever instance is current: at
 * subscribe time when the repositories exist, and again each time
 * `rebindOverlaySlotSubscriptions` follows a configuration.
 */
export function subscribeOverlaySlot(
    role: OverlaySlotRole,
    listener: OverlayRepositoryChangeListener
): RallarUnsubscribe {
    const registry = registries[role];
    registry.listeners.add(listener);
    bind(role, listener);
    return () => {
        registry.listeners.delete(listener);
        registry.bindings.get(listener)?.();
        registry.bindings.delete(listener);
    };
}

export function rebindOverlaySlotSubscriptions(): void {
    for (const role of Object.keys(registries) as OverlaySlotRole[]) {
        const registry = registries[role];
        for (const unbind of registry.bindings.values()) {
            unbind();
        }
        registry.bindings.clear();
        for (const listener of registry.listeners) {
            bind(role, listener);
        }
    }
}

function bind(role: OverlaySlotRole, listener: OverlayRepositoryChangeListener): void {
    const unbind = readConfiguredValue(() =>
        role === 'planned' ? onPlannedOverlayChange(listener) : onAcceptedOverlayChange(listener)
    );
    if (unbind !== undefined) {
        registries[role].bindings.set(listener, unbind);
    }
}
