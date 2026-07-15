import { describe, expect, it } from 'vitest';
import {
    deriveExecuteActionPolicy,
    type ExecuteActionPolicyInput,
} from '../../../apps/rallar-black-box/src/recipe-console/execute/execute-action-policy.ts';
import type { RallarBlackBoxDistributedRunState } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';

function input(
    overrides: Partial<ExecuteActionPolicyInput> = {},
): ExecuteActionPolicyInput {
    return {
        connection: 'live',
        runState: undefined,
        hasKnownRun: false,
        unknownDistributedRunId: false,
        recipeAvailable: true,
        schemaValid: true,
        preflightValid: true,
        selectedTargetsSafe: true,
        manifestValid: true,
        resolutionCurrent: true,
        ...overrides,
    };
}

describe('Recipe Console Execute action policy', () => {
    it.each([
        ['connecting'],
        ['offline'],
        ['error'],
        ['credential-trust'],
        ['auth-required'],
    ] as const)('offers only Refresh while connection truth is %s', (connection) => {
        const policy = deriveExecuteActionPolicy(input({ connection }));

        expect(policy.refresh.enabled).toBe(true);
        expect(Object.entries(policy)
            .filter(([action]) => action !== 'refresh')
            .every(([, decision]) => !decision.enabled)).toBe(true);
    });

    it('allows Resolve and known-run Export on partial truth but no mutations', () => {
        const policy = deriveExecuteActionPolicy(input({
            connection: 'partial',
            hasKnownRun: true,
            runState: 'draft',
        }));

        expect(policy.resolve.enabled).toBe(true);
        expect(policy.refresh.enabled).toBe(true);
        expect(policy.export.enabled).toBe(true);
        expect(policy.create.enabled).toBe(false);
        expect(policy.stage.enabled).toBe(false);
        expect(policy.start.enabled).toBe(false);
        expect(policy.cancel.enabled).toBe(false);
    });

    it('allows only Refresh and known-run Export on stale truth', () => {
        const policy = deriveExecuteActionPolicy(input({
            connection: 'stale',
            hasKnownRun: true,
            runState: 'running',
        }));

        expect(policy.refresh.enabled).toBe(true);
        expect(policy.export.enabled).toBe(true);
        expect(policy.resolve.enabled).toBe(false);
        expect(policy.cancel.enabled).toBe(false);
    });

    it.each([
        [undefined, 'create'],
        ['draft', 'stage'],
        ['ready', 'start'],
        ['waiting-for-ack', 'cancel'],
        ['waiting-for-barrier', 'cancel'],
        ['running', 'cancel'],
    ] as const)('enables the current lifecycle action directly for state %s', (
        runState,
        action,
    ) => {
        const policy = deriveExecuteActionPolicy(input({
            runState,
            hasKnownRun: runState !== undefined,
        }));

        expect(policy[action].enabled).toBe(true);
    });

    it.each([
        ['passed'],
        ['failed'],
        ['cancelled'],
        ['timed-out'],
    ] as const)('keeps terminal %s runs refreshable/exportable but not cancellable', (
        runState,
    ) => {
        const policy = deriveExecuteActionPolicy(input({
            runState,
            hasKnownRun: true,
        }));

        expect(policy.refresh.enabled).toBe(true);
        expect(policy.export.enabled).toBe(true);
        expect(policy.cancel).toMatchObject({
            enabled: false,
            code: 'terminal-run',
        });
    });

    it('keeps Cancel independent of recipe, schema, preflight, target, manifest, and resolution validity', () => {
        const policy = deriveExecuteActionPolicy(input({
            runState: 'running',
            hasKnownRun: true,
            recipeAvailable: false,
            schemaValid: false,
            preflightValid: false,
            selectedTargetsSafe: false,
            manifestValid: false,
            resolutionCurrent: false,
        }));

        expect(policy.cancel.enabled).toBe(true);
        expect(policy.start.enabled).toBe(false);
    });

    it.each([
        ['recipeAvailable', false, 'recipe-unavailable'],
        ['schemaValid', false, 'schema-invalid'],
        ['preflightValid', false, 'preflight-blocked'],
        ['selectedTargetsSafe', false, 'targets-unsafe'],
        ['manifestValid', false, 'manifest-invalid'],
        ['resolutionCurrent', false, 'resolution-required'],
    ] as const)('blocks guided mutations when %s is unsafe', (
        field,
        value,
        code,
    ) => {
        const policy = deriveExecuteActionPolicy(input({ [field]: value }));

        expect(policy.create).toMatchObject({ enabled: false, code });
        expect(policy.create.reason).toBeTruthy();
    });

    it('blocks Create for an unavailable explicit distributed ID', () => {
        const policy = deriveExecuteActionPolicy(input({
            unknownDistributedRunId: true,
        }));

        expect(policy.create).toMatchObject({
            enabled: false,
            code: 'run-unavailable',
        });
    });

    it('requires authoritative draft for Stage and ready for Start', () => {
        const waiting = deriveExecuteActionPolicy(input({
            runState: 'waiting-for-ack',
            hasKnownRun: true,
        }));
        const draft = deriveExecuteActionPolicy(input({
            runState: 'draft',
            hasKnownRun: true,
        }));

        expect(waiting.stage).toMatchObject({ enabled: false, code: 'run-state' });
        expect(waiting.start).toMatchObject({ enabled: false, code: 'run-state' });
        expect(draft.start).toMatchObject({ enabled: false, code: 'run-state' });
    });

    it('does not require arming for Create, Stage, Start, or Cancel', () => {
        expect(deriveExecuteActionPolicy(input()).create.enabled).toBe(true);
        expect(deriveExecuteActionPolicy(input({
            runState: 'draft',
            hasKnownRun: true,
        })).stage.enabled).toBe(true);
        expect(deriveExecuteActionPolicy(input({
            runState: 'ready',
            hasKnownRun: true,
        })).start.enabled).toBe(true);
        expect(deriveExecuteActionPolicy(input({
            runState: 'running',
            hasKnownRun: true,
        })).cancel.enabled).toBe(true);
    });

    it('disables every second action while one action is busy', () => {
        const policy = deriveExecuteActionPolicy(input({ busyAction: 'stage' }));

        expect(Object.values(policy).every((decision) =>
            !decision.enabled && decision.code === 'busy'
        )).toBe(true);
    });
});
