import { describe, expect, it } from 'vitest';
import {
    createMonitorCancelArmContext,
    deriveMonitorActionPolicy,
    monitorConnectionTruth,
    type MonitorActionPolicyInput
} from '../../../apps/rallar-black-box/src/recipe-console/monitor/monitor-action-policy.ts';

function arm(overrides: Record<string, unknown> = {}) {
    return createMonitorCancelArmContext({
        baseUrl: 'https://control.test/root/',
        controlRunId: 'run-a',
        distributedRunId: 'distributed-a',
        runState: 'running',
        updatedAtEpochMs: 100,
        ...overrides
    });
}

function input(
    overrides: Partial<MonitorActionPolicyInput> = {}
): MonitorActionPolicyInput {
    return {
        connection: 'live',
        evidence: 'current',
        runState: 'running',
        cancelArmKey: arm().key,
        armedKey: arm().key,
        ...overrides
    };
}

describe('Recipe Console Monitor action policy', () => {
    it('enables current live reads and exact armed non-terminal cancellation', () => {
        const policy = deriveMonitorActionPolicy(input());

        expect(policy).toEqual({
            refresh: { enabled: true },
            cancel: { enabled: true },
            'load-artifact': { enabled: true },
            'export-artifact': { enabled: true }
        });
    });

    it('requires exact arming and binds the key to every destructive context field', () => {
        const unarmed = deriveMonitorActionPolicy(input({ armedKey: undefined }));
        const baseline = arm();
        const variants = [
            arm({ baseUrl: 'https://control.other/root' }),
            arm({ controlRunId: 'run-b' }),
            arm({ distributedRunId: 'distributed-b' }),
            arm({ runState: 'waiting-for-ack' }),
            arm({ updatedAtEpochMs: 101 })
        ];

        expect(unarmed.cancel).toMatchObject({
            enabled: false,
            code: 'arming-required'
        });
        expect(variants.every((value) => value.key !== baseline.key)).toBe(true);
        expect(baseline.label).toContain('distributed-a');
        expect(baseline.label).toContain('https://control.test/root');
    });

    it.each(
        [
            ['passed'],
            ['failed'],
            ['cancelled'],
            ['timed-out']
        ] as const
    )('keeps terminal %s evidence readable but not cancellable', (runState) => {
        const policy = deriveMonitorActionPolicy(input({ runState }));

        expect(policy.refresh.enabled).toBe(true);
        expect(policy['load-artifact'].enabled).toBe(true);
        expect(policy['export-artifact'].enabled).toBe(true);
        expect(policy.cancel).toMatchObject({
            enabled: false,
            code: 'terminal-run'
        });
    });

    it('allows read-only artifact operations on coherent current partial truth', () => {
        const policy = deriveMonitorActionPolicy(input({ connection: 'partial' }));

        expect(policy.refresh.enabled).toBe(true);
        expect(policy['load-artifact'].enabled).toBe(true);
        expect(policy['export-artifact'].enabled).toBe(true);
        expect(policy.cancel).toMatchObject({
            enabled: false,
            code: 'connection'
        });
    });

    it.each(
        [
            ['connecting'],
            ['stale'],
            ['offline'],
            ['error'],
            ['auth-required'],
            ['credential-trust']
        ] as const
    )('offers only Refresh while connection truth is %s', (connection) => {
        const policy = deriveMonitorActionPolicy(input({ connection }));

        expect(policy.refresh.enabled).toBe(true);
        expect(
            Object.entries(policy)
                .filter(([action]) => action !== 'refresh')
                .every(([, decision]) => !decision.enabled)
        ).toBe(true);
    });

    it.each(['none', 'last-known'] as const)(
        'blocks remote actions for %s selected-run evidence',
        (evidence) => {
            const policy = deriveMonitorActionPolicy(input({ evidence }));

            expect(policy.refresh.enabled).toBe(true);
            expect(policy.cancel.enabled).toBe(false);
            expect(policy['load-artifact'].enabled).toBe(false);
            expect(policy['export-artifact'].enabled).toBe(false);
        }
    );

    it('disables every action while an operation is busy', () => {
        const policy = deriveMonitorActionPolicy(input({ busyAction: 'cancel' }));

        expect(Object.values(policy).every((decision) => !decision.enabled && decision.code === 'busy')).toBe(true);
    });

    it('keeps credential trust and authorization distinct from reachable protocol errors', () => {
        expect(monitorConnectionTruth({
            status: 'partial',
            reachability: 'reachable',
            authorization: 'required'
        })).toBe('auth-required');
        expect(monitorConnectionTruth({
            status: 'offline',
            reachability: 'reachable',
            authorization: 'required',
            lastError: {
                kind: 'http',
                message: 'credentials withheld',
                credentialTrustRequired: true
            }
        })).toBe('credential-trust');
        expect(monitorConnectionTruth({
            status: 'offline',
            reachability: 'reachable',
            authorization: 'ready'
        })).toBe('error');
    });
});
