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

export interface ManagedApiServerLifecycleControls {
  readonly stop: (port: number) => Promise<void>;
  readonly restart: (port: number, replacementPlan: ManagedApiServerPlan) => Promise<void>;
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
  readonly runRecipes: (controls: ManagedApiServerLifecycleControls) => Promise<void>;
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
  const serverGenerations: Array<
    Readonly<{
      plan: ManagedApiServerPlan;
      server: ManagedApiServer;
    }>
  > = [];
  const activeServers = new Map<number, ManagedApiServer>();
  const managedPorts = new Set(input.plans.map((plan) => plan.port));
  const logPaths = new Set<string>();

  const start = async (plan: ManagedApiServerPlan): Promise<void> => {
    if (activeServers.has(plan.port)) {
      throw new Error(`Managed API-v1 port ${plan.port} is already running.`);
    }
    if (logPaths.has(plan.logPath)) {
      throw new Error(`Managed API-v1 restart log must be distinct: ${plan.logPath}`);
    }
    await dependencies.writeEmptyLogFile(plan.logPath);
    const server = dependencies.startServer(input.serverCommand, plan, input.repoRootPath);
    serverGenerations.push({ plan, server });
    activeServers.set(plan.port, server);
    logPaths.add(plan.logPath);
    await dependencies.waitForReady({
      baseUrl: plan.baseUrl,
      logPath: plan.logPath,
      childStatus: server.child.status,
      startup: server.startup,
      streamsDrained: server.streamsDrained,
      diagnosticSecrets: dependencies.toDiagnosticSecrets(plan.env),
    });
  };

  const stop = async (port: number): Promise<void> => {
    const server = activeServers.get(port);
    if (!server) {
      throw new Error(`Managed API-v1 port ${port} is not running.`);
    }
    await dependencies.stopServer(server.child);
    await server.streamsDrained;
    activeServers.delete(port);
  };

  const controls: ManagedApiServerLifecycleControls = {
    stop,
    restart: async (port, replacementPlan) => {
      if (!managedPorts.has(port)) {
        throw new Error(`Managed API-v1 port ${port} does not belong to this run.`);
      }
      if (replacementPlan.port !== port) {
        throw new Error(
          `Managed API-v1 replacement port ${replacementPlan.port} does not match ${port}.`,
        );
      }
      await start(replacementPlan);
    },
  };
  try {
    for (const plan of input.plans) {
      await dependencies.writeEmptyLogFile(plan.logPath);
      const server = dependencies.startServer(input.serverCommand, plan, input.repoRootPath);
      serverGenerations.push({ plan, server });
      activeServers.set(plan.port, server);
      logPaths.add(plan.logPath);
    }
    await Promise.all(
      serverGenerations.map(({ plan, server }) =>
        dependencies.waitForReady({
          baseUrl: plan.baseUrl,
          logPath: plan.logPath,
          childStatus: server.child.status,
          startup: server.startup,
          streamsDrained: server.streamsDrained,
          diagnosticSecrets: dependencies.toDiagnosticSecrets(plan.env),
        }),
      ),
    );
    await dependencies.runRecipes(controls);
    await dependencies.verifyFairness(
      input.artifactDir,
      serverGenerations.map(({ plan }) => plan.logPath),
    );
  } finally {
    await Promise.allSettled(
      [...serverGenerations]
        .reverse()
        .filter(({ plan, server }) => activeServers.get(plan.port) === server)
        .map(async ({ plan, server }) => {
          await dependencies.stopServer(server.child);
          await server.streamsDrained;
          activeServers.delete(plan.port);
        }),
    );
  }
}
