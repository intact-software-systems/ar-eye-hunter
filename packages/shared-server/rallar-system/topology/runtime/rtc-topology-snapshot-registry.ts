import { compareOverlayTopologyCausalTuple, type RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import { rtcTopologySemanticEqual } from '../persistence/rtc-topology-semantic-equal.ts';

export class RtcTopologySnapshotRegistry {
    private readonly snapshotsByOverlayId = new Map<string, RallarOverlayTopologySnapshot>();

    observe(snapshot: RallarOverlayTopologySnapshot): boolean {
        const current = this.snapshotsByOverlayId.get(snapshot.overlayId);
        const comparison = current ? compareOverlayTopologyCausalTuple(snapshot, current) : null;
        if (!current || comparison === 'dominates') {
            this.snapshotsByOverlayId.set(snapshot.overlayId, snapshot);
            return true;
        }
        if (comparison === 'equal' && !rtcTopologySemanticEqual(snapshot, current)) {
            throw new Error(`RTC topology process-cache revision conflict: ${snapshot.overlayId}`);
        }
        if (comparison === 'incomparable') {
            throw new Error(`RTC topology process-cache causal conflict: ${snapshot.overlayId}`);
        }
        return false;
    }

    get(overlayId: string): RallarOverlayTopologySnapshot | undefined {
        return this.snapshotsByOverlayId.get(overlayId);
    }

    has(overlayId: string): boolean {
        return this.snapshotsByOverlayId.has(overlayId);
    }

    remove(overlayId: string): boolean {
        return this.snapshotsByOverlayId.delete(overlayId);
    }

    get size(): number {
        return this.snapshotsByOverlayId.size;
    }
}
