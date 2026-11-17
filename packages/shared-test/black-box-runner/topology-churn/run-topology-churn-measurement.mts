import { join } from 'node:path';

import { runManagedClusterProof } from '../cluster-proofs/run-managed-cluster-proof.mts';
import type { TopologyChurnRoomSpec } from './phases/topology-churn-room-specs.ts';
import { TopologyChurnApi } from './topology-churn-api.mts';
import {
    TOPOLOGY_CHURN_REQUEST_TIMEOUT_MS,
    TopologyChurnScenario,
    type TopologyChurnClock
} from './topology-churn-scenario.mts';

interface RunTopologyChurnMeasurementInput {
    readonly rooms: readonly TopologyChurnRoomSpec[];
    /** The report's file name in the run's artifact directory. */
    readonly reportFile: string;
    /** The Postgres `application_name` prefix of the cluster's API processes. */
    readonly applicationNamePrefix: string;
}

export async function runTopologyChurnMeasurement(input: RunTopologyChurnMeasurementInput): Promise<void> {
    const artifactDir = await runManagedClusterProof({
        applicationNamePrefix: input.applicationNamePrefix,
        runScenario: (scenario) =>
            new TopologyChurnScenario({
                api: new TopologyChurnApi({
                    memberPassword: 'topology-churn-password',
                    administrator: { username: 'admin', password: 'admin' },
                    requestTimeoutMs: TOPOLOGY_CHURN_REQUEST_TIMEOUT_MS
                }),
                clock: createDefaultTopologyChurnClock(),
                artifactDir: scenario.artifactDir,
                apiBaseUrls: scenario.plans.map((plan) => plan.baseUrl),
                rooms: input.rooms,
                reportFile: input.reportFile
            }).run()
    });
    console.log(
        `PASS: ${input.rooms.length} rooms formed, ran their phases and converged. ` +
            `Report: ${join(artifactDir, input.reportFile)}`
    );
}

function createDefaultTopologyChurnClock(): TopologyChurnClock {
    return {
        nowEpochMs: () => Date.now(),
        sleep: (durationMs, signal) =>
            new Promise<void>((resolve) => {
                if (signal.aborted) {
                    resolve();
                    return;
                }
                const finish = (): void => {
                    clearTimeout(timer);
                    signal.removeEventListener('abort', finish);
                    resolve();
                };
                const timer = setTimeout(finish, durationMs);
                signal.addEventListener('abort', finish, { once: true });
            })
    };
}
