import { OrderingClusterScenario } from './ordering/ordering-cluster-scenario.mts';
import { runManagedClusterProof } from './run-managed-cluster-proof.mts';

async function runOrderingClusterProof(): Promise<void> {
    const artifactDir = await runManagedClusterProof({
        applicationNamePrefix: 'ordering-proof',
        runScenario: (scenario) => new OrderingClusterScenario(scenario).run()
    });
    console.log(
        'PASS: remote receiver recorded and entered, closed session outside by the retry with the relayed receipt complete, ' +
            `granted omission read as omitted. Artifacts: ${artifactDir}`
    );
}

if (import.meta.main) {
    await runOrderingClusterProof();
}
