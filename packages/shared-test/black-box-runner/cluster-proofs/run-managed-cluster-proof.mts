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
import {
    withManagedApiServerPlans,
    type ManagedApiServerLifecycleControls,
    type ManagedApiServerPlan
} from '../managed-api/with-managed-api-server-plans.mts';

export namespace ManagedClusterProof {
    export interface Input {
        /** The Postgres `application_name` prefix each process connects under, suffixed with its port. */
        readonly applicationNamePrefix: string;
        readonly runScenario: (scenario: ScenarioInput) => Promise<void>;
    }

    export interface ScenarioInput {
        readonly plans: readonly ManagedApiServerPlan[];
        readonly controls: ManagedApiServerLifecycleControls;
        readonly databaseUrl: string;
        readonly artifactDir: string;
    }
}

/**
 * Three api-v1 processes on one fresh migrated Postgres database, queue workers on the primary only;
 * answers the run's artifact directory once the scenario passed.
 */
export async function runManagedClusterProof(input: ManagedClusterProof.Input): Promise<string> {
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
        const plans = toManagedApiServerPlans(options, env, artifactDir)
            .map((plan, index) => labelProofPlan(plan, index, input.applicationNamePrefix));
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
            runRecipes: (controls) => input.runScenario({ plans, controls, databaseUrl, artifactDir }),
            verifyFairness: async () => {},
            stopServer: stopManagedApiServer
        });
    });
    return artifactDir;
}

function labelProofPlan(
    plan: ManagedApiServerPlan,
    index: number,
    applicationNamePrefix: string
): ManagedApiServerPlan {
    const databaseUrl = new URL(plan.env.DATABASE_URL!);
    databaseUrl.searchParams.set('application_name', `${applicationNamePrefix}-${plan.port}`);
    return {
        ...plan,
        env: {
            ...plan.env,
            DATABASE_URL: databaseUrl.toString(),
            RALLAR_API_QUEUE_WORKERS: index === 0 ? 'enabled' : 'disabled'
        }
    };
}
