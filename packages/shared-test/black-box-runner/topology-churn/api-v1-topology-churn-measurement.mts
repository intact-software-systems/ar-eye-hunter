import { TOPOLOGY_CHURN_ROOM_SPECS } from './phases/topology-churn-room-specs.ts';
import { runTopologyChurnMeasurement } from './run-topology-churn-measurement.mts';

if (import.meta.main) {
    await runTopologyChurnMeasurement({
        rooms: TOPOLOGY_CHURN_ROOM_SPECS,
        reportFile: 'topology-churn-report.json',
        applicationNamePrefix: 'topology-churn'
    });
}
