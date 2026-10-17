import type { ControlDistributedRunArtifactBundle, ControlRunSnapshotBounds } from '@shared-test/rallar-bb-test/control-snapshots.ts';

import { createControlDistributedRunArtifactBundle } from '../../src/control-artifacts.ts';
import type { RallarBlackBoxControlService } from '../../src/control-service.ts';

/** The bundle the distributed-run artifact route builds, from a live control run's snapshot. */
export function createDistributedRunArtifactBundle(
    service: Pick<RallarBlackBoxControlService, 'snapshotDistributedRun' | 'snapshotRun'>,
    distributedRunId: string,
    bounds: ControlRunSnapshotBounds = {}
): ControlDistributedRunArtifactBundle | undefined {
    const distributedRun = service.snapshotDistributedRun(distributedRunId);
    return distributedRun
        ? createControlDistributedRunArtifactBundle(distributedRun, service.snapshotRun(distributedRun.controlRunId, bounds))
        : undefined;
}
