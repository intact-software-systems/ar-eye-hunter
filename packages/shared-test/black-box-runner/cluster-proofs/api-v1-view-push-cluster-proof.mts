import { runManagedClusterProof } from './run-managed-cluster-proof.mts';
import { ViewPushClusterScenario } from './view-push/view-push-cluster-scenario.mts';

async function runViewPushClusterProof(): Promise<void> {
    const artifactDir = await runManagedClusterProof({
        applicationNamePrefix: 'view-push-proof',
        runScenario: (scenario) => new ViewPushClusterScenario(scenario).run()
    });
    console.log(
        `PASS: private A → B push, C recovery, and missed LISTEN recovery without websocket reconnect. Artifacts: ${artifactDir}`
    );
}

if (import.meta.main) {
    await runViewPushClusterProof();
}
