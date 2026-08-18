// @vitest-environment happy-dom

import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    resolveRallarBlackBoxBootstrapConfig,
    type RallarBlackBoxBootstrapConfig,
} from '../../shared-test/rallar-bb-test/browser-control-agent-config.ts';
import type { RallarBlackBoxTestState } from '../../shared-test/rallar-bb-test/types.ts';
import { DistributedRecipesPanel } from '../../../apps/rallar-black-box/src/legacy/runner/distributed-recipes/DistributedRecipesPanel.tsx';
import { RunManagerPanel } from '../../../apps/rallar-black-box/src/legacy/runner/run-manager/RunManagerPanel.tsx';
import { RunnerFleetPanel } from '../../../apps/rallar-black-box/src/legacy/runner/fleet/RunnerFleetPanel.tsx';
import { RunnerRecipesPanel } from '../../../apps/rallar-black-box/src/legacy/runner/recipes/RunnerRecipesPanel.tsx';
import { RunnerRunsPanel } from '../../../apps/rallar-black-box/src/legacy/runner/runs/RunnerRunsPanel.tsx';
import { TopologyGraphPanel } from '../../../apps/rallar-black-box/src/legacy/diagnostics/topology/TopologyGraphPanel.tsx';

const sigmaLifecycle = vi.hoisted(() => ({
    constructed: 0,
    killed: 0,
}));

vi.mock('sigma', () => ({
    default: class SigmaMock {
        constructor(..._args: unknown[]) {
            sigmaLifecycle.constructed += 1;
        }

        kill(): void {
            sigmaLifecycle.killed += 1;
        }
    },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

describe('legacy safe-surface effect lifetime', () => {
    let container: HTMLDivElement;
    let root: Root;
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        sigmaLifecycle.constructed = 0;
        sigmaLifecycle.killed = 0;
        window.history.replaceState(null, '', '/');
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('stops Run Manager initial refresh chaining after unmount', async () => {
        const firstResponse = deferred<Response>();
        const paths: string[] = [];
        globalThis.fetch = vi.fn(async (input) => {
            const pathname = new URL(String(input)).pathname;
            paths.push(pathname);
            if (pathname === '/runs') return firstResponse.promise;
            if (pathname === '/runs/control-a') {
                return jsonResponse(controlRunSnapshot('control-a'));
            }
            throw new Error(`Unexpected request: ${pathname}`);
        }) as typeof globalThis.fetch;

        await act(async () => {
            root.render(createElement(RunManagerPanel, {
                state: baseState(),
                bootstrap: bootstrapConfig(),
                control: controlSnapshot('control-a'),
            }));
            await Promise.resolve();
        });
        expect(paths).toEqual(['/runs']);

        await act(async () => root.render(null));
        await act(async () => {
            firstResponse.resolve(jsonResponse({
                runs: [controlRunSnapshot('control-a')],
            }));
            await flushAsyncWork();
        });

        expect(paths).toEqual(['/runs']);
    });

    it('stops Distributed Recipes initial refresh chaining after unmount', async () => {
        const runsResponse = deferred<Response>();
        const distributedResponse = deferred<Response>();
        const paths: string[] = [];
        globalThis.fetch = vi.fn(async (input) => {
            const pathname = new URL(String(input)).pathname;
            paths.push(pathname);
            if (pathname === '/runs') return runsResponse.promise;
            if (pathname === '/distributed-runs') {
                return distributedResponse.promise;
            }
            if (pathname === '/runs/control-a') {
                return jsonResponse(controlRunSnapshot('control-a'));
            }
            throw new Error(`Unexpected request: ${pathname}`);
        }) as typeof globalThis.fetch;

        await act(async () => {
            root.render(createElement(DistributedRecipesPanel, {
                state: baseState(),
                bootstrap: bootstrapConfig(),
                control: controlSnapshot('control-a'),
                globalValues: {
                    apiBaseUrl: 'http://api.test',
                    applicationId: 'application-a',
                    workspaceId: 'workspace-a',
                    clientId: 'client-a',
                    sessionId: 'session-a',
                    roomId: 'group-a',
                },
            }));
            await Promise.resolve();
        });
        expect(paths.toSorted()).toEqual(['/distributed-runs', '/runs']);

        await act(async () => root.render(null));
        await act(async () => {
            runsResponse.resolve(jsonResponse({
                runs: [controlRunSnapshot('control-a')],
            }));
            distributedResponse.resolve(jsonResponse({ distributedRuns: [] }));
            await flushAsyncWork();
        });

        expect(paths.toSorted()).toEqual(['/distributed-runs', '/runs']);
    });

    it('stops Recipes initial readiness refresh chaining after unmount', async () => {
        const runsResponse = deferred<Response>();
        const paths: string[] = [];
        globalThis.fetch = vi.fn(async (input) => {
            const pathname = new URL(String(input)).pathname;
            paths.push(pathname);
            if (pathname === '/runs') return runsResponse.promise;
            if (pathname.startsWith('/api/')) return jsonResponse({});
            if (pathname === '/runs/control-a') {
                return jsonResponse(controlRunSnapshot('control-a'));
            }
            throw new Error(`Unexpected request: ${pathname}`);
        }) as typeof globalThis.fetch;

        await act(async () => {
            root.render(createElement(RunnerRecipesPanel, {
                state: baseState(),
                bootstrap: bootstrapConfig(),
                control: controlSnapshot('control-a'),
                globalValues: globalValues(),
                busy: false,
                runState: 'idle',
                onDistributedRunStarted: vi.fn(),
                onOpenTab: vi.fn(),
            }));
            await Promise.resolve();
        });
        expect(paths).toContain('/runs');

        await act(async () => root.render(null));
        await act(async () => {
            runsResponse.resolve(jsonResponse({
                runs: [controlRunSnapshot('control-a')],
            }));
            await flushAsyncWork();
        });

        expect(paths).not.toContain('/runs/control-a');
    });

    it('stops Runs initial distributed refresh chaining after unmount', async () => {
        const distributedRunsResponse = deferred<Response>();
        const paths: string[] = [];
        globalThis.fetch = vi.fn(async (input) => {
            const pathname = new URL(String(input)).pathname;
            paths.push(pathname);
            if (pathname === '/distributed-runs') {
                return distributedRunsResponse.promise;
            }
            if (pathname === '/runs/control-a') {
                return jsonResponse(controlRunSnapshot('control-a'));
            }
            throw new Error(`Unexpected request: ${pathname}`);
        }) as typeof globalThis.fetch;

        await act(async () => {
            root.render(createElement(RunnerRunsPanel, {
                state: baseState(),
                bootstrap: bootstrapConfig(),
                control: controlSnapshot('control-a'),
            }));
            await Promise.resolve();
        });
        expect(paths).toEqual(['/distributed-runs']);

        await act(async () => root.render(null));
        await act(async () => {
            distributedRunsResponse.resolve(jsonResponse({
                distributedRuns: [distributedRunSnapshot()],
            }));
            await flushAsyncWork();
        });

        expect(paths).toEqual(['/distributed-runs']);
    });

    it('completes a Runs URL-ticket refresh after the Strict Mode effect replay', async () => {
        const paths: string[] = [];
        window.history.replaceState(
            null,
            '',
            '/?experience=legacy&workspace=black-box-runner&tab=runs' +
                '&controlRunId=control-a&distributedRunId=distributed-a',
        );
        globalThis.fetch = vi.fn(async (input) => {
            const pathname = new URL(String(input)).pathname;
            paths.push(pathname);
            if (pathname === '/distributed-runs') {
                return jsonResponse({
                    distributedRuns: [distributedRunSnapshot()],
                });
            }
            if (pathname === '/distributed-runs/distributed-a') {
                return jsonResponse(distributedRunSnapshot());
            }
            if (pathname === '/runs/control-a') {
                return jsonResponse(controlRunSnapshot('control-a'));
            }
            throw new Error(`Unexpected request: ${pathname}`);
        }) as typeof globalThis.fetch;

        await act(async () => {
            root.render(createElement(
                StrictMode,
                undefined,
                createElement(RunnerRunsPanel, {
                    state: baseState(),
                    bootstrap: bootstrapConfig(),
                    control: controlSnapshot('control-a'),
                }),
            ));
            await flushAsyncWork();
        });

        const distributedRunSelect = [...container.querySelectorAll('select')]
            .find((select) => select.previousElementSibling?.textContent ===
                'Distributed Run');
        expect(distributedRunSelect?.value).toBe('distributed-a');
        expect(paths).toContain('/distributed-runs/distributed-a');
        expect(paths).toContain('/runs/control-a');
    });

    it.each([
        [
            'Run Manager',
            () => createElement(RunManagerPanel, {
                state: baseState(),
                bootstrap: bootstrapConfig(),
                control: controlSnapshot('control-a'),
            }),
            '/runs/control-a',
        ],
        [
            'Distributed Recipes',
            () => createElement(DistributedRecipesPanel, {
                state: baseState(),
                bootstrap: bootstrapConfig(),
                control: controlSnapshot('control-a'),
                globalValues: globalValues(),
            }),
            '/runs/control-a',
        ],
        [
            'Recipes',
            () => createElement(RunnerRecipesPanel, {
                state: baseState(),
                bootstrap: bootstrapConfig(),
                control: controlSnapshot('control-a'),
                globalValues: globalValues(),
                busy: false,
                runState: 'idle',
                onDistributedRunStarted: vi.fn(),
                onOpenTab: vi.fn(),
            }),
            '/runs/control-a',
        ],
        [
            'Fleet',
            () => createElement(RunnerFleetPanel, {
                bootstrap: bootstrapConfig(),
                control: controlSnapshot('control-a'),
                globalValues: globalValues(),
            }),
            '/runs',
        ],
    ] as const)(
        'completes the %s initial refresh after the Strict Mode effect replay',
        async (_name, component, expectedFollowUpPath) => {
            const paths: string[] = [];
            globalThis.fetch = vi.fn(async (input) => {
                const pathname = new URL(String(input)).pathname;
                paths.push(pathname);
                if (pathname === '/runs') {
                    return jsonResponse({
                        runs: [controlRunSnapshot('control-a')],
                    });
                }
                if (pathname === '/runs/control-a') {
                    return jsonResponse(controlRunSnapshot('control-a'));
                }
                if (pathname === '/distributed-runs') {
                    return jsonResponse({
                        distributedRuns: [distributedRunSnapshot()],
                    });
                }
                if (pathname === '/fleet/reports') {
                    return jsonResponse(emptyFleetReportsResponse());
                }
                if (pathname.startsWith('/api/')) {
                    return jsonResponse({});
                }
                throw new Error(`Unexpected request: ${pathname}`);
            }) as typeof globalThis.fetch;

            await act(async () => {
                root.render(createElement(StrictMode, undefined, component()));
                await flushAsyncWork();
            });

            expect(paths).toContain(expectedFollowUpPath);
            if (expectedFollowUpPath === '/runs') {
                expect(paths.filter(path => path === '/runs').length)
                    .toBeGreaterThan(0);
            }
        },
    );

    it('does not let a Runs poll supersede an in-flight operator refresh', async () => {
        const operatorResponse = deferred<Response>();
        const paths: string[] = [];
        let operatorRefreshPending = false;
        let poll: (() => void) | undefined;
        vi.spyOn(window, 'setInterval').mockImplementation((
            ((handler: () => void) => {
                poll = handler;
                return 1;
            }) as typeof window.setInterval
        ));
        vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined);
        globalThis.fetch = vi.fn(async (input) => {
            const pathname = new URL(String(input)).pathname;
            paths.push(pathname);
            if (pathname === '/distributed-runs') {
                return operatorRefreshPending
                    ? operatorResponse.promise
                    : jsonResponse({
                        distributedRuns: [distributedRunSnapshot()],
                    });
            }
            if (pathname === '/distributed-runs/distributed-a') {
                return jsonResponse(distributedRunSnapshot());
            }
            if (pathname === '/runs/control-a') {
                return jsonResponse(controlRunSnapshot('control-a'));
            }
            throw new Error(`Unexpected request: ${pathname}`);
        }) as typeof globalThis.fetch;

        await act(async () => {
            root.render(createElement(RunnerRunsPanel, {
                state: baseState(),
                bootstrap: bootstrapConfig(),
                control: controlSnapshot('control-a'),
            }));
            await flushAsyncWork();
        });
        expect(poll).toBeTypeOf('function');

        const refreshButton = [...container.querySelectorAll('button')]
            .find((button) => button.textContent?.trim() === 'Refresh');
        expect(refreshButton).toBeDefined();
        operatorRefreshPending = true;
        await act(async () => {
            refreshButton?.click();
            await Promise.resolve();
        });
        expect(paths.filter((path) => path === '/distributed-runs'))
            .toHaveLength(2);

        await act(async () => {
            poll?.();
            await Promise.resolve();
        });
        const requestCount = paths.filter(
            (path) => path === '/distributed-runs',
        ).length;

        await act(async () => {
            operatorResponse.resolve(jsonResponse({
                distributedRuns: [distributedRunSnapshot()],
            }));
            await flushAsyncWork();
        });

        expect(requestCount).toBe(2);
    });

    it('stops Fleet initial refresh chaining after unmount', async () => {
        const reportsResponse = deferred<Response>();
        const paths: string[] = [];
        globalThis.fetch = vi.fn(async (input) => {
            const pathname = new URL(String(input)).pathname;
            paths.push(pathname);
            if (pathname === '/fleet/reports') return reportsResponse.promise;
            if (pathname === '/runs') {
                return jsonResponse({ runs: [] });
            }
            throw new Error(`Unexpected request: ${pathname}`);
        }) as typeof globalThis.fetch;

        await act(async () => {
            root.render(createElement(RunnerFleetPanel, {
                bootstrap: bootstrapConfig(),
                control: controlSnapshot('control-a'),
                globalValues: globalValues(),
            }));
            await Promise.resolve();
        });
        expect(paths).toEqual(['/fleet/reports']);

        await act(async () => root.render(null));
        await act(async () => {
            reportsResponse.resolve(jsonResponse({ reports: [] }));
            await flushAsyncWork();
        });

        expect(paths).toEqual(['/fleet/reports']);
    });

    it('kills the Topology Sigma renderer exactly once on unmount', async () => {
        await act(async () => {
            root.render(createElement(TopologyGraphPanel, {
                state: baseState(),
                active: true,
                onSelectCommand: vi.fn(),
            }));
        });

        expect(sigmaLifecycle.constructed).toBe(1);
        expect(sigmaLifecycle.killed).toBe(0);

        await act(async () => root.render(null));

        expect(sigmaLifecycle.constructed).toBe(1);
        expect(sigmaLifecycle.killed).toBe(1);
    });
});

function baseState(): RallarBlackBoxTestState {
    return {
        status: 'idle',
        commandHistory: [],
        events: [],
        failures: [],
        resultCache: {},
    };
}

function bootstrapConfig(): RallarBlackBoxBootstrapConfig {
    return resolveRallarBlackBoxBootstrapConfig(
        '?controlUrl=ws%3A%2F%2Fcontrol.test%2Fcontrol&provider=simulated',
        {},
        '',
    );
}

function controlSnapshot(runId: string) {
    return {
        state: 'registered',
        url: 'ws://control.test/control',
        runId,
        reconnectAttempt: 0,
        sentCount: 0,
        receivedCount: 0,
    } as const;
}

function controlRunSnapshot(runId: string) {
    return {
        runId,
        createdAtEpochMs: 1,
        updatedAtEpochMs: 2,
        agents: [],
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: [],
    } as const;
}

function distributedRunSnapshot() {
    return {
        distributedRunId: 'distributed-a',
        controlRunId: 'control-a',
        manifest: {
            schemaVersion: 1,
            distributedRunId: 'distributed-a',
            controlRunId: 'control-a',
            group: {
                applicationId: 'application-a',
                workspaceId: 'workspace-a',
                groupId: 'group-a',
            },
            recipes: [],
            targetPolicy: {
                mode: 'selected-agents',
                agentIds: [],
            },
        },
        state: 'running',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 2,
        targetAgentIds: [],
        commandLinks: [],
        rollup: {
            state: 'running',
            ok: false,
            summary: {
                participants: 0,
                requiredParticipants: 0,
                readyParticipants: 0,
                passedParticipants: 0,
                failedParticipants: 0,
                recipes: 0,
                requiredRecipes: 0,
                passedRecipes: 0,
                failedRecipes: 0,
                blockingFailures: 0,
            },
            failures: [],
        },
    } as const;
}

function globalValues() {
    return {
        apiBaseUrl: 'http://api.test',
        applicationId: 'application-a',
        workspaceId: 'workspace-a',
        clientId: 'client-a',
        sessionId: 'session-a',
        roomId: 'group-a',
    } as const;
}

function emptyFleetReportsResponse() {
    return {
        reports: [],
        aggregate: {
            generatedAtEpochMs: 1,
            reportCount: 0,
            runCount: 0,
            agentCount: 0,
            regionCount: 0,
            passRate: 0,
            staleAgentCount: 0,
            flakyAgentCount: 0,
            failureGroupCount: 0,
            timing: {
                runs: { count: 0, p95Ms: 0 },
                commands: { count: 0, p95Ms: 0 },
            },
            regions: [],
            failureSignatures: [],
        },
    } as const;
}

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function deferred<Value>() {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>(next => {
        resolve = next;
    });
    return { promise, resolve } as const;
}

async function flushAsyncWork(): Promise<void> {
    await Promise.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));
}
