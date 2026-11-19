import { describe, expect, it } from 'vitest';

import { ManagedApiServerFaults } from '@shared-test/black-box-runner/server-faults/managed-api-server-faults.mts';
import {
    answerServerFaultRequest
} from '@shared-test/black-box-runner/server-faults/with-managed-api-server-fault-endpoint.mts';

type ServerState = 'running' | 'suspended' | 'stopped';

interface Plan {
    readonly port: number;
    readonly baseUrl: string;
    readonly logPath: string;
    readonly env: Record<string, string>;
}

const PLANS: readonly Plan[] = [18080, 18081, 18082].map((port) => ({
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    logPath: `api-${port}.log`,
    env: {}
}));

/** Stands in for the processes: it holds each port's state and the plan a restart started. */
function createProcesses(plans: readonly Plan[] = PLANS) {
    const states = new Map<number, ServerState>(plans.map((plan) => [plan.port, 'running']));
    const stops: Array<readonly [number, string]> = [];
    const restartedLogPaths: string[] = [];
    return {
        states,
        stops,
        restartedLogPaths,
        controls: {
            getState: (port: number) => states.get(port) ?? ('unmanaged' as const),
            stop: async (port: number, mode: 'crash' | 'graceful') => {
                stops.push([port, mode]);
                states.set(port, 'stopped');
            },
            suspend: async (port: number) => {
                states.set(port, 'suspended');
            },
            resume: async (port: number) => {
                states.set(port, 'running');
            },
            restart: async (port: number, replacement: Plan) => {
                restartedLogPaths.push(replacement.logPath);
                states.set(port, 'running');
            }
        }
    };
}

function createFaults(processes = createProcesses(), plans: readonly Plan[] = PLANS) {
    return new ManagedApiServerFaults({ plans, controls: processes.controls, cutDatabaseSessions: undefined });
}

describe('the faults a recipe may name against its run\'s API servers', () => {
    it('crashes the server its target names and no other', async () => {
        const processes = createProcesses();

        const applied = await createFaults(processes).apply({ action: 'stop', target: 'secondary', mode: 'crash' });

        expect(applied.right).toEqual({ action: 'stop' });
        expect(processes.stops).toEqual([[18081, 'crash']]);
        expect([...processes.states.values()]).toEqual(['running', 'stopped', 'running']);
    });

    it('refuses, as a value, a fault the target\'s state cannot take', async () => {
        const processes = createProcesses();
        const faults = createFaults(processes);
        await faults.apply({ action: 'stop', target: 'primary', mode: 'graceful' });
        await faults.apply({ action: 'suspend', target: 'secondary' });

        expect((await faults.apply({ action: 'stop', target: 'primary', mode: 'crash' })).left).toBe('not-running');
        expect((await faults.apply({ action: 'suspend', target: 'primary' })).left).toBe('not-running');
        expect((await faults.apply({ action: 'suspend', target: 'secondary' })).left).toBe('already-suspended');
        expect((await faults.apply({ action: 'resume', target: 'tertiary' })).left).toBe('not-suspended');
        expect((await faults.apply({ action: 'restart', target: 'tertiary' })).left).toBe('already-running');
        expect(processes.stops).toEqual([[18080, 'graceful']]);
    });

    it('refuses a target the run does not manage', async () => {
        const single = PLANS.slice(0, 1);
        const faults = createFaults(createProcesses(single), single);

        expect((await faults.apply({ action: 'suspend', target: 'tertiary' })).left).toBe('unmanaged-target');
    });

    it('starts every replacement under a log of its own', async () => {
        const processes = createProcesses();
        const faults = createFaults(processes);

        for (const target of ['primary', 'primary', 'tertiary'] as const) {
            await faults.apply({ action: 'stop', target, mode: 'crash' });
            await faults.apply({ action: 'restart', target });
        }

        expect(new Set(processes.restartedLogPaths).size).toBe(3);
        expect(processes.restartedLogPaths.every((path) => !PLANS.some((plan) => plan.logPath === path))).toBe(true);
    });

    it('restores every stopped or suspended server and names them', async () => {
        const processes = createProcesses();
        const faults = createFaults(processes);
        await faults.apply({ action: 'stop', target: 'primary', mode: 'crash' });
        await faults.apply({ action: 'suspend', target: 'tertiary' });

        const restored = await faults.apply({ action: 'restore' });

        expect(restored.right).toEqual({ action: 'restore', restored: ['primary', 'tertiary'] });
        expect([...processes.states.values()]).toEqual(['running', 'running', 'running']);
        expect((await faults.apply({ action: 'restore' })).right).toEqual({ action: 'restore', restored: [] });
    });

    it('cuts the database sessions of the target\'s process and answers how many ended', async () => {
        const cutPorts: number[] = [];
        const faults = new ManagedApiServerFaults({
            plans: PLANS,
            controls: createProcesses().controls,
            cutDatabaseSessions: async (plan) => {
                cutPorts.push(plan.port);
                return 4;
            }
        });

        const applied = await faults.apply({ action: 'cut-database-sessions', target: 'secondary' });

        expect(applied.right).toEqual({ action: 'cut-database-sessions', terminatedSessions: 4 });
        expect(cutPorts).toEqual([18081]);
    });

    it('refuses a session cut where the run\'s backend holds no sessions to lose', async () => {
        const applied = await createFaults().apply({ action: 'cut-database-sessions', target: 'primary' });

        expect(applied.left).toBe('no-database-sessions');
    });
});

describe('the loopback endpoint a recipe process reaches the faults through', () => {
    function post(body: string): Request {
        return new Request('http://127.0.0.1:1/', { method: 'POST', body });
    }

    it('answers an applied fault with what was applied', async () => {
        const processes = createProcesses();

        const response = await answerServerFaultRequest(
            createFaults(processes),
            post(JSON.stringify({ action: 'suspend', target: 'tertiary' }))
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ outcome: 'applied', applied: { action: 'suspend' } });
        expect(processes.states.get(18082)).toBe('suspended');
    });

    it('answers a refused fault with its refusal and applies nothing', async () => {
        const processes = createProcesses();

        const response = await answerServerFaultRequest(
            createFaults(processes),
            post(JSON.stringify({ action: 'resume', target: 'primary' }))
        );

        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ outcome: 'refused', refusal: 'not-suspended' });
    });

    it.each([
        ['a target the vocabulary lacks', JSON.stringify({ action: 'stop', target: 'quaternary', mode: 'crash' })],
        ['a stop with no mode', JSON.stringify({ action: 'stop', target: 'primary' })],
        ['an action the vocabulary lacks', JSON.stringify({ action: 'reboot', target: 'primary' })],
        ['a body that is not JSON', '{']
    ])('answers %s as invalid and applies nothing', async (_label, body) => {
        const processes = createProcesses();

        const response = await answerServerFaultRequest(createFaults(processes), post(body));

        expect(response.status).toBe(400);
        expect((await response.json()).outcome).toBe('invalid');
        expect(processes.stops).toEqual([]);
    });

    it('answers a request that is not a POST as invalid', async () => {
        const response = await answerServerFaultRequest(createFaults(), new Request('http://127.0.0.1:1/'));

        expect(response.status).toBe(400);
    });
});
