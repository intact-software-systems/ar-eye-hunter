import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import {
    isSameGroupLayoutIdentity,
    resolveGroupLayoutRole,
    toGroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

/**
 * Holds, per group, the newest layout that arrived before the cached group
 * snapshot admitted the own session. The layout and group-state paths are not
 * ordered against each other, and the server does not republish a layout it
 * already delivered, so a dropped layout would otherwise be lost.
 */
export class DeferredOverlayTopologies {
    readonly #topologiesByOverlayId = new Map<string, RallarOverlayTopologySnapshot>();

    /** Reports false when a newer layout is already kept for the group. */
    keep(topology: RallarOverlayTopologySnapshot): boolean {
        const overlayId = toScopedOverlayId(topology.groupRef);
        const kept = this.#topologiesByOverlayId.get(overlayId);
        if (kept === undefined || isNewerLayout(topology, kept)) {
            this.#topologiesByOverlayId.set(overlayId, topology);
            return true;
        }
        return isSameGroupLayoutIdentity(toGroupLayoutIdentity(topology), toGroupLayoutIdentity(kept));
    }

    find(groupRef: GroupRef): RallarOverlayTopologySnapshot | undefined {
        return this.#topologiesByOverlayId.get(toScopedOverlayId(groupRef));
    }

    discard(groupRef: GroupRef): void {
        this.#topologiesByOverlayId.delete(toScopedOverlayId(groupRef));
    }

    /** Discards the kept layout unless it is newer than the one just adopted. */
    discardThrough(adopted: RallarOverlayTopologySnapshot): void {
        const kept = this.find(adopted.groupRef);
        if (kept !== undefined && !isNewerLayout(kept, adopted)) {
            this.discard(adopted.groupRef);
        }
    }

    clear(): void {
        this.#topologiesByOverlayId.clear();
    }
}

function isNewerLayout(
    candidate: RallarOverlayTopologySnapshot,
    reference: RallarOverlayTopologySnapshot
): boolean {
    return resolveGroupLayoutRole({
        publication: toGroupLayoutIdentity(candidate),
        accepted: toGroupLayoutIdentity(reference)
    }) === 'planned';
}
