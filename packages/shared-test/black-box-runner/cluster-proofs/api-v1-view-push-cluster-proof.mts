import { assert, assertEquals } from '@std/assert';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    parseApiV1BlackBoxArgs,
    toApiV1BlackBoxEnvironment,
    toApiV1ServerCommand,
    toManagedApiServerPlans
} from '../api-v1-black-box-run.mts';
import { managedApiDiagnosticSecrets, waitForManagedApiReady } from '../managed-api/api-v1-managed-api-readiness.mts';
import { withManagedPostgresRunDatabase } from '../managed-api/api-v1-managed-postgres-run-database.mts';
import { startManagedApiServer, stopManagedApiServer } from '../managed-api/api-v1-managed-process-lifecycle.mts';
import { withManagedApiServerPlans, type ManagedApiServerPlan } from '../managed-api/with-managed-api-server-plans.mts';
import { ViewPushClusterScenario } from './view-push/view-push-cluster-scenario.mts';

async function runViewPushClusterProof(): Promise<void> {
    const options = parseApiV1BlackBoxArgs(Deno.args);
    assert(options.backend === 'postgres' && options.secondaryPort && options.tertiaryPort && !options.recipesOnly);
    const environment = toApiV1BlackBoxEnvironment(options, Deno.env.toObject());
    const artifactDir = resolve(options.artifactDir, environment.RALLAR_BB_EXECUTION_TOKEN!);
    const repoRootPath = fileURLToPath(new URL('../../../../', import.meta.url));
    await Deno.mkdir(artifactDir, { recursive: true });
    await withManagedPostgresRunDatabase(environment.DATABASE_URL!, options.runId, async (databaseUrl) => {
        const env = { ...environment, DATABASE_URL: databaseUrl };
        const migration = await new Deno.Command('npm', {
            args: ['run', 'db:migrate'],
            cwd: repoRootPath,
            env,
            stdout: 'null',
            stderr: 'inherit'
        }).output();
        assertEquals(migration.code, 0);
        const plans = toManagedApiServerPlans(options, env, artifactDir).map(labelProofPlan);
        await withManagedApiServerPlans({
            plans,
            serverCommand: toApiV1ServerCommand(options),
            repoRootPath,
            artifactDir
        }, {
            writeEmptyLogFile: (path) => Deno.writeTextFile(path, ''),
            startServer: startManagedApiServer,
            waitForReady: waitForManagedApiReady,
            toDiagnosticSecrets: managedApiDiagnosticSecrets,
            runRecipes: (controls) => new ViewPushClusterScenario({ plans, controls, databaseUrl, artifactDir }).run(),
            verifyFairness: async () => {},
            stopServer: stopManagedApiServer
        });
    });
    console.log(
        `PASS: private A → B push, C recovery, and missed LISTEN recovery without websocket reconnect. Artifacts: ${artifactDir}`
    );
}

function labelProofPlan(plan: ManagedApiServerPlan, index: number): ManagedApiServerPlan {
    const databaseUrl = new URL(plan.env.DATABASE_URL!);
    databaseUrl.searchParams.set('application_name', `view-push-proof-${plan.port}`);
    return {
        ...plan,
        env: {
            ...plan.env,
            DATABASE_URL: databaseUrl.toString(),
            RALLAR_API_QUEUE_WORKERS: index === 0 ? 'enabled' : 'disabled'
        }
    };
}

if (import.meta.main) {
    await runViewPushClusterProof();
}
