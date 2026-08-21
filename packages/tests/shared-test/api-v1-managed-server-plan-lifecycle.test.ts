import { describe, expect, it } from 'vitest';

import * as apiV1BlackBoxRunner from '@shared-test/black-box-runner/api-v1-black-box-run.mts';

interface TestServerPlan {
    readonly port: number;
    readonly baseUrl: string;
    readonly logPath: string;
    readonly env: Record<string, string>;
}

interface TestChild {
    readonly port: number;
    readonly status: Promise<Readonly<{ success: boolean; code: number; signal: string | null; }>>;
    readonly kill: (signal?: number | string) => void;
}

interface TestManagedServer {
    readonly child: TestChild;
    readonly startup: Promise<void>;
    readonly streamsDrained: Promise<void>;
}

interface TestReadinessInput {
    readonly baseUrl: string;
    readonly logPath: string;
    readonly diagnosticSecrets: readonly string[];
}

interface TestLifecycleDependencies {
    readonly writeEmptyLogFile: (path: string) => Promise<void>;
    readonly startServer: (
        command: readonly string[],
        plan: TestServerPlan,
        repoRootPath: string
    ) => TestManagedServer;
    readonly waitForReady: (input: TestReadinessInput) => Promise<void>;
    readonly toDiagnosticSecrets: (env: Record<string, string>) => readonly string[];
    readonly runRecipes: (controls: TestLifecycleControls) => Promise<void>;
    readonly verifyFairness: (
        artifactDir: string,
        serverLogPaths: readonly string[]
    ) => Promise<void>;
    readonly stopServer: (child: TestChild) => Promise<void>;
}

interface TestLifecycleControls {
    readonly stop: (port: number) => Promise<void>;
    readonly restart: (port: number, replacementPlan: TestServerPlan) => Promise<void>;
    readonly suspend: (port: number) => Promise<void>;
    readonly resume: (port: number) => Promise<void>;
}

type WithManagedApiServerPlans = (
    input: Readonly<{
        plans: readonly TestServerPlan[];
        serverCommand: readonly string[];
        repoRootPath: string;
        artifactDir: string;
    }>,
    dependencies: TestLifecycleDependencies
) => Promise<void>;

const plans: readonly TestServerPlan[] = [
    toPlan(18080, 'api-v1-server.log'),
    toPlan(18081, 'api-v1-server-secondary.log'),
    toPlan(18082, 'api-v1-server-tertiary.log')
];

describe('managed API-v1 server-plan lifecycle', () => {
    it('starts and readies every plan before recipes and verifies fairness with all logs', async () => {
        const withPlans = getWithManagedApiServerPlans();
        expect(withPlans).toBeTypeOf('function');
        if (!withPlans) {
            return;
        }
        const events: string[] = [];
        const readinessInputs: TestReadinessInput[] = [];

        await withPlans(toLifecycleInput(), {
            writeEmptyLogFile: async (path) => {
                events.push(`clear:${path}`);
            },
            startServer: (_command, plan, repoRootPath) => {
                events.push(`start:${plan.port}:${repoRootPath}`);
                return toServer(plan.port);
            },
            waitForReady: async (input) => {
                readinessInputs.push(input);
                events.push(`ready:${input.baseUrl}`);
            },
            toDiagnosticSecrets: (env) => [`secret-${env.PORT}`],
            runRecipes: async () => {
                events.push('recipes');
            },
            verifyFairness: async (artifactDir, serverLogPaths) => {
                events.push(`fairness:${artifactDir}:${serverLogPaths.join(',')}`);
            },
            stopServer: async (child) => {
                events.push(`stop:${child.port}`);
            }
        });

        expect(readinessInputs).toHaveLength(3);
        readinessInputs.forEach((readinessInput, index) => {
            const plan = plans[index];
            expect(readinessInput).toMatchObject({
                baseUrl: plan.baseUrl,
                logPath: plan.logPath,
                diagnosticSecrets: [`secret-${plan.port}`]
            });
        });
        expect(events).toEqual([
            'clear:/artifacts/api-v1-server.log',
            'start:18080:/repo',
            'clear:/artifacts/api-v1-server-secondary.log',
            'start:18081:/repo',
            'clear:/artifacts/api-v1-server-tertiary.log',
            'start:18082:/repo',
            'ready:http://127.0.0.1:18080',
            'ready:http://127.0.0.1:18081',
            'ready:http://127.0.0.1:18082',
            'recipes',
            'fairness:/artifacts:/artifacts/api-v1-server.log,/artifacts/api-v1-server-secondary.log,/artifacts/api-v1-server-tertiary.log',
            'stop:18082',
            'stop:18081',
            'stop:18080'
        ]);
    });

    it('reports tertiary readiness through its own diagnostics and still cleans up in reverse', async () => {
        const withPlans = getWithManagedApiServerPlans();
        expect(withPlans).toBeTypeOf('function');
        if (!withPlans) {
            return;
        }
        const events: string[] = [];
        const tertiaryFailure = new Error('tertiary readiness diagnostics');

        await expect(
            withPlans(toLifecycleInput(), {
                writeEmptyLogFile: async () => undefined,
                startServer: (_command, plan) => toServer(plan.port),
                waitForReady: async (input) => {
                    events.push(
                        `ready:${input.baseUrl}:${input.logPath}:${input.diagnosticSecrets.join(',')}`
                    );
                    if (input.baseUrl.endsWith(':18082')) {
                        throw tertiaryFailure;
                    }
                },
                toDiagnosticSecrets: (env) => [`secret-${env.PORT}`],
                runRecipes: async () => {
                    events.push('recipes');
                },
                verifyFairness: async () => {
                    events.push('fairness');
                },
                stopServer: async (child) => {
                    events.push(`stop:${child.port}`);
                }
            })
        ).rejects.toBe(tertiaryFailure);

        expect(events).toEqual([
            'ready:http://127.0.0.1:18080:/artifacts/api-v1-server.log:secret-18080',
            'ready:http://127.0.0.1:18081:/artifacts/api-v1-server-secondary.log:secret-18081',
            'ready:http://127.0.0.1:18082:/artifacts/api-v1-server-tertiary.log:secret-18082',
            'stop:18082',
            'stop:18081',
            'stop:18080'
        ]);
    });

    it('propagates fairness failure after all three logs and cleans up every process', async () => {
        const withPlans = getWithManagedApiServerPlans();
        expect(withPlans).toBeTypeOf('function');
        if (!withPlans) {
            return;
        }
        const events: string[] = [];
        const fairnessFailure = new Error('tertiary fairness evidence missing');

        await expect(
            withPlans(toLifecycleInput(), {
                writeEmptyLogFile: async () => undefined,
                startServer: (_command, plan) => toServer(plan.port),
                waitForReady: async () => undefined,
                toDiagnosticSecrets: () => [],
                runRecipes: async () => undefined,
                verifyFairness: async (_artifactDir, serverLogPaths) => {
                    events.push(`fairness:${serverLogPaths.join(',')}`);
                    throw fairnessFailure;
                },
                stopServer: async (child) => {
                    events.push(`stop:${child.port}`);
                }
            })
        ).rejects.toBe(fairnessFailure);

        expect(events).toEqual([
            'fairness:/artifacts/api-v1-server.log,/artifacts/api-v1-server-secondary.log,/artifacts/api-v1-server-tertiary.log',
            'stop:18082',
            'stop:18081',
            'stop:18080'
        ]);
    });

    it('restarts one port with a distinct log and retains both generations as evidence', async () => {
        const withPlans = getWithManagedApiServerPlans();
        expect(withPlans).toBeTypeOf('function');
        if (!withPlans) {
            return;
        }
        const events: string[] = [];
        const replacementPlan = toPlan(18082, 'api-v1-server-tertiary-restart.log');

        await withPlans(toLifecycleInput(), {
            writeEmptyLogFile: async (path) => {
                events.push(`clear:${path}`);
            },
            startServer: (_command, plan) => {
                events.push(`start:${plan.port}:${plan.logPath}`);
                return toServer(plan.port);
            },
            waitForReady: async (input) => {
                events.push(`ready:${input.logPath}`);
            },
            toDiagnosticSecrets: () => [],
            runRecipes: async (controls) => {
                await controls.stop(18082);
                await controls.restart(18082, replacementPlan);
            },
            verifyFairness: async (_artifactDir, serverLogPaths) => {
                events.push(`fairness:${serverLogPaths.join(',')}`);
            },
            stopServer: async (child) => {
                events.push(`stop:${child.port}`);
            }
        });

        expect(events).toEqual([
            'clear:/artifacts/api-v1-server.log',
            'start:18080:/artifacts/api-v1-server.log',
            'clear:/artifacts/api-v1-server-secondary.log',
            'start:18081:/artifacts/api-v1-server-secondary.log',
            'clear:/artifacts/api-v1-server-tertiary.log',
            'start:18082:/artifacts/api-v1-server-tertiary.log',
            'ready:/artifacts/api-v1-server.log',
            'ready:/artifacts/api-v1-server-secondary.log',
            'ready:/artifacts/api-v1-server-tertiary.log',
            'stop:18082',
            'clear:/artifacts/api-v1-server-tertiary-restart.log',
            'start:18082:/artifacts/api-v1-server-tertiary-restart.log',
            'ready:/artifacts/api-v1-server-tertiary-restart.log',
            'fairness:/artifacts/api-v1-server.log,/artifacts/api-v1-server-secondary.log,/artifacts/api-v1-server-tertiary.log,/artifacts/api-v1-server-tertiary-restart.log',
            'stop:18082',
            'stop:18081',
            'stop:18080'
        ]);
    });

    it('retains a server for final cleanup when an explicit stop fails', async () => {
        const withPlans = getWithManagedApiServerPlans();
        expect(withPlans).toBeTypeOf('function');
        if (!withPlans) {
            return;
        }
        const events: string[] = [];
        const stopAttempts = new Map<number, number>();
        const explicitStopFailure = new Error('explicit stop failed');

        await expect(
            withPlans(toLifecycleInput(), {
                writeEmptyLogFile: async () => undefined,
                startServer: (_command, plan) => toServer(plan.port),
                waitForReady: async () => undefined,
                toDiagnosticSecrets: () => [],
                runRecipes: async (controls) => {
                    await controls.stop(18082);
                },
                verifyFairness: async () => undefined,
                stopServer: async (child) => {
                    const attempt = (stopAttempts.get(child.port) ?? 0) + 1;
                    stopAttempts.set(child.port, attempt);
                    events.push(`stop:${child.port}:${attempt}`);
                    if (child.port === 18082 && attempt === 1) {
                        throw explicitStopFailure;
                    }
                }
            })
        ).rejects.toBe(explicitStopFailure);

        expect(events).toEqual([
            'stop:18082:1',
            'stop:18082:2',
            'stop:18081:1',
            'stop:18080:1'
        ]);
    });

    it('resumes a suspended server before failure cleanup stops it', async () => {
        const withPlans = getWithManagedApiServerPlans();
        expect(withPlans).toBeTypeOf('function');
        if (!withPlans) {
            return;
        }
        const events: string[] = [];
        const recipeFailure = new Error('proof scheduling failed');

        await expect(
            withPlans(toLifecycleInput(), {
                writeEmptyLogFile: async () => undefined,
                startServer: (_command, plan) =>
                    toServer(plan.port, (signal) => {
                        events.push(`signal:${plan.port}:${signal}`);
                    }),
                waitForReady: async () => undefined,
                toDiagnosticSecrets: () => [],
                runRecipes: async (controls) => {
                    await controls.suspend(18082);
                    throw recipeFailure;
                },
                verifyFairness: async () => undefined,
                stopServer: async (child) => {
                    events.push(`stop:${child.port}`);
                }
            })
        ).rejects.toBe(recipeFailure);

        expect(events).toEqual([
            'signal:18082:SIGSTOP',
            'signal:18082:SIGCONT',
            'stop:18082',
            'stop:18081',
            'stop:18080'
        ]);
    });
});

function getWithManagedApiServerPlans(): WithManagedApiServerPlans | undefined {
    return (apiV1BlackBoxRunner as Record<string, unknown>).withManagedApiServerPlans as WithManagedApiServerPlans | undefined;
}

function toLifecycleInput(): Parameters<WithManagedApiServerPlans>[0] {
    return {
        plans,
        serverCommand: ['deno', 'run', 'api-v1.ts'],
        repoRootPath: '/repo',
        artifactDir: '/artifacts'
    };
}

function toPlan(port: number, logName: string): TestServerPlan {
    return {
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        logPath: `/artifacts/${logName}`,
        env: { PORT: String(port) }
    };
}

function toServer(
    port: number,
    kill: (signal?: number | string) => void = () => undefined
): TestManagedServer {
    return {
        child: {
            port,
            status: Promise.resolve({ success: true, code: 0, signal: null }),
            kill
        },
        startup: Promise.resolve(),
        streamsDrained: Promise.resolve()
    };
}
