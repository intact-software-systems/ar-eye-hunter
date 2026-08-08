import type {
  ManagedApiServer,
  ManagedApiServerPlan as ManagedApiProcessPlan,
} from './api-v1-managed-process-lifecycle.mts';
import type { WaitForManagedApiReadyInput } from './api-v1-managed-api-readiness.mts';

export interface ManagedApiServerPlan extends ManagedApiProcessPlan {
  readonly baseUrl: string;
}

export interface ManagedApiServerPlanLifecycleInput {
  readonly plans: readonly ManagedApiServerPlan[];
  readonly serverCommand: readonly string[];
  readonly repoRootPath: string;
  readonly artifactDir: string;
}

export interface ManagedApiServerPlanLifecycleDependencies {
  readonly writeEmptyLogFile: (path: string) => Promise<void>;
  readonly startServer: (
    command: readonly string[],
    plan: ManagedApiServerPlan,
    repoRootPath: string,
  ) => ManagedApiServer;
  readonly waitForReady: (input: WaitForManagedApiReadyInput) => Promise<void>;
  readonly toDiagnosticSecrets: (env: Record<string, string>) => readonly string[];
  readonly runRecipes: () => Promise<void>;
  readonly verifyFairness: (
    artifactDir: string,
    serverLogPaths: readonly string[],
  ) => Promise<void>;
  readonly stopServer: (child: ManagedApiServer['child']) => Promise<void>;
}

export async function withManagedApiServerPlans(
  input: ManagedApiServerPlanLifecycleInput,
  dependencies: ManagedApiServerPlanLifecycleDependencies,
): Promise<void> {
  const servers: Array<
    Readonly<{
      plan: ManagedApiServerPlan;
      server: ManagedApiServer;
    }>
  > = [];
  try {
    for (const plan of input.plans) {
      await dependencies.writeEmptyLogFile(plan.logPath);
      servers.push({
        plan,
        server: dependencies.startServer(input.serverCommand, plan, input.repoRootPath),
      });
    }
    await Promise.all(
      servers.map(({ plan, server }) =>
        dependencies.waitForReady({
          baseUrl: plan.baseUrl,
          logPath: plan.logPath,
          childStatus: server.child.status,
          startup: server.startup,
          streamsDrained: server.streamsDrained,
          diagnosticSecrets: dependencies.toDiagnosticSecrets(plan.env),
        })
      ),
    );
    await dependencies.runRecipes();
    await dependencies.verifyFairness(
      input.artifactDir,
      servers.map(({ plan }) => plan.logPath),
    );
  } finally {
    await Promise.allSettled(
      [...servers].reverse().map(({ server }) => dependencies.stopServer(server.child)),
    );
  }
}
