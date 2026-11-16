import { join } from 'node:path';

import { runManagedClusterProof } from '../cluster-proofs/run-managed-cluster-proof.mts';
import { TopologyChurnApi } from './topology-churn-api.mts';
import {
    TOPOLOGY_CHURN_REPORT_FILE,
    TopologyChurnScenario,
    type TopologyChurnClock
} from './topology-churn-scenario.mts';

async function runTopologyChurnMeasurement(): Promise<void> {
    const artifactDir = await runManagedClusterProof({
        applicationNamePrefix: 'topology-churn',
        runScenario: (scenario) =>
            new TopologyChurnScenario({
                api: new TopologyChurnApi({
                    memberPassword: 'topology-churn-password',
                    administrator: { username: 'admin', password: 'admin' }
                }),
                clock: createDefaultTopologyChurnClock(),
                artifactDir: scenario.artifactDir,
                apiBaseUrls: scenario.plans.map((plan) => plan.baseUrl)
            }).run()
    });
    console.log(
        `PASS: six rooms formed, churned and converged. Report: ${join(artifactDir, TOPOLOGY_CHURN_REPORT_FILE)}`
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

if (import.meta.main) {
    await runTopologyChurnMeasurement();
}
