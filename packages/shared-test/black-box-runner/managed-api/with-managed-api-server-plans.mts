import type { WaitForManagedApiReadyInput } from './api-v1-managed-api-readiness.mts';
import type {
    ManagedApiServer,
    ManagedApiServerPlan as ManagedApiProcessPlan,
    ManagedApiStopMode
} from './api-v1-managed-process-lifecycle.mts';

export interface ManagedApiServerPlan extends ManagedApiProcessPlan {
    readonly baseUrl: string;
}

export interface ManagedApiServerPlanLifecycleInput {
    readonly plans: readonly ManagedApiServerPlan[];
    readonly serverCommand: readonly string[];
    readonly repoRootPath: string;
    readonly artifactDir: string;
}

export type ManagedApiServerState = 'running' | 'suspended' | 'stopped' | 'unmanaged';

export interface ManagedApiServerLifecycleControls {
    stop(port: number, mode: ManagedApiStopMode): Promise<void>;
    restart(port: number, replacementPlan: ManagedApiServerPlan): Promise<void>;
    suspend(port: number): Promise<void>;
    resume(port: number): Promise<void>;
    getState(port: number): ManagedApiServerState;
}

export interface ManagedApiServerPlanLifecycleDependencies {
    readonly writeEmptyLogFile: (path: string) => Promise<void>;
    readonly startServer: (
        command: readonly string[],
        plan: ManagedApiServerPlan,
        repoRootPath: string
    ) => ManagedApiServer;
    readonly waitForReady: (input: WaitForManagedApiReadyInput) => Promise<void>;
    readonly toDiagnosticSecrets: (env: Record<string, string>) => readonly string[];
    readonly runRecipes: (controls: ManagedApiServerLifecycleControls) => Promise<void>;
    readonly verifyFairness: (
        artifactDir: string,
        serverLogPaths: readonly string[]
    ) => Promise<void>;
    readonly stopServer: (child: ManagedApiServer['child'], mode: ManagedApiStopMode) => Promise<void>;
}

interface ManagedApiServerGeneration {
    readonly plan: ManagedApiServerPlan;
    readonly server: ManagedApiServer;
}

/** Every process a run started, by port: the one running now and the generations it replaced. */
class ManagedApiServerGenerations implements ManagedApiServerLifecycleControls {
    private readonly generations: ManagedApiServerGeneration[] = [];
    private readonly activeServers = new Map<number, ManagedApiServer>();
    private readonly suspendedServers = new Set<ManagedApiServer>();
    private readonly logPaths = new Set<string>();
    private readonly managedPorts: ReadonlySet<number>;
    private readonly input: ManagedApiServerPlanLifecycleInput;
    private readonly dependencies: ManagedApiServerPlanLifecycleDependencies;

    constructor(input: ManagedApiServerPlanLifecycleInput, dependencies: ManagedApiServerPlanLifecycleDependencies) {
        this.input = input;
        this.dependencies = dependencies;
        this.managedPorts = new Set(input.plans.map((plan) => plan.port));
    }

    async startAll(): Promise<void> {
        for (const plan of this.input.plans) {
            await this.spawn(plan);
        }
        await Promise.all(this.generations.map((generation) => this.waitForReady(generation)));
    }

    async stopAll(): Promise<void> {
        await Promise.allSettled(
            [...this.generations]
                .reverse()
                .filter(({ plan, server }) => this.activeServers.get(plan.port) === server)
                .map(async ({ plan, server }) => {
                    if (this.suspendedServers.has(server)) {
                        try {
                            server.child.kill('SIGCONT');
                        }
                        finally {
                            this.suspendedServers.delete(server);
                        }
                    }
                    await this.dependencies.stopServer(server.child, 'graceful');
                    await server.streamsDrained;
                    this.activeServers.delete(plan.port);
                })
        );
    }

    getLogPaths(): readonly string[] {
        return this.generations.map(({ plan }) => plan.logPath);
    }

    getState(port: number): ManagedApiServerState {
        if (!this.managedPorts.has(port)) {
            return 'unmanaged';
        }
        const server = this.activeServers.get(port);
        if (server === undefined) {
            return 'stopped';
        }
        return this.suspendedServers.has(server) ? 'suspended' : 'running';
    }

    async stop(port: number, mode: ManagedApiStopMode): Promise<void> {
        const server = this.requireActiveServer(port);
        if (this.suspendedServers.has(server)) {
            server.child.kill('SIGCONT');
            this.suspendedServers.delete(server);
        }
        await this.dependencies.stopServer(server.child, mode);
        await server.streamsDrained;
        this.activeServers.delete(port);
    }

    async suspend(port: number): Promise<void> {
        const server = this.requireActiveServer(port);
        if (this.suspendedServers.has(server)) {
            throw new Error(`Managed API-v1 port ${port} is already suspended.`);
        }
        server.child.kill('SIGSTOP');
        this.suspendedServers.add(server);
    }

    async resume(port: number): Promise<void> {
        const server = this.requireActiveServer(port);
        if (!this.suspendedServers.has(server)) {
            throw new Error(`Managed API-v1 port ${port} is not suspended.`);
        }
        server.child.kill('SIGCONT');
        this.suspendedServers.delete(server);
    }

    async restart(port: number, replacementPlan: ManagedApiServerPlan): Promise<void> {
        if (!this.managedPorts.has(port)) {
            throw new Error(`Managed API-v1 port ${port} does not belong to this run.`);
        }
        if (replacementPlan.port !== port) {
            throw new Error(`Managed API-v1 replacement port ${replacementPlan.port} does not match ${port}.`);
        }
        if (this.activeServers.has(port)) {
            throw new Error(`Managed API-v1 port ${port} is already running.`);
        }
        if (this.logPaths.has(replacementPlan.logPath)) {
            throw new Error(`Managed API-v1 restart log must be distinct: ${replacementPlan.logPath}`);
        }
        await this.waitForReady(await this.spawn(replacementPlan));
    }

    private async spawn(plan: ManagedApiServerPlan): Promise<ManagedApiServerGeneration> {
        await this.dependencies.writeEmptyLogFile(plan.logPath);
        const server = this.dependencies.startServer(this.input.serverCommand, plan, this.input.repoRootPath);
        const generation = { plan, server };
        this.generations.push(generation);
        this.activeServers.set(plan.port, server);
        this.logPaths.add(plan.logPath);
        return generation;
    }

    private async waitForReady({ plan, server }: ManagedApiServerGeneration): Promise<void> {
        await this.dependencies.waitForReady({
            baseUrl: plan.baseUrl,
            logPath: plan.logPath,
            childStatus: server.child.status,
            startup: server.startup,
            streamsDrained: server.streamsDrained,
            diagnosticSecrets: this.dependencies.toDiagnosticSecrets(plan.env)
        });
    }

    private requireActiveServer(port: number): ManagedApiServer {
        const server = this.activeServers.get(port);
        if (!server) {
            throw new Error(`Managed API-v1 port ${port} is not running.`);
        }
        return server;
    }
}

export async function withManagedApiServerPlans(
    input: ManagedApiServerPlanLifecycleInput,
    dependencies: ManagedApiServerPlanLifecycleDependencies
): Promise<void> {
    const servers = new ManagedApiServerGenerations(input, dependencies);
    try {
        await servers.startAll();
        await dependencies.runRecipes(servers);
        await dependencies.verifyFairness(input.artifactDir, servers.getLogPaths());
    }
    finally {
        await servers.stopAll();
    }
}
