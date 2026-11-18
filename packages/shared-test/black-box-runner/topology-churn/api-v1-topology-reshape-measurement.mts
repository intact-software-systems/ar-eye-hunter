import { TOPOLOGY_RESHAPE_ROOM_SPECS } from './phases/topology-churn-room-specs.ts';
import { runTopologyChurnMeasurement } from './run-topology-churn-measurement.mts';

if (import.meta.main) {
    await runTopologyChurnMeasurement({
        rooms: TOPOLOGY_RESHAPE_ROOM_SPECS,
        reportFile: 'topology-reshape-report.json',
        applicationNamePrefix: 'topology-reshape'
    });
}
