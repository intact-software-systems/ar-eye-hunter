import { describe, expect, it } from 'vitest';
import {
    createExecuteActionArmContext,
    deriveExecuteActionPolicy,
    type ExecuteActionPolicyInput,
    type ExecuteArmedAction,
} from '../../../apps/rallar-black-box/src/recipe-console/execute/execute-action-policy.ts';
import type { RallarBlackBoxDistributedRunState } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';

function arm(action: ExecuteArmedAction, overrides: Record<string, unknown> = {}) {
    return createExecuteActionArmContext({
        action,
        controlBaseUrl: 'https://control.test/root',
        controlRunId: 'run-a',
        distributedRunId: 'distributed-a',
        recipeIds: ['recipe-a'],
        targetAgentIds: ['agent-b', 'agent-a'],
        manifestFingerprint: '{"manifest":"a"}',
        ...overrides,
    });
}

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
        armKeys: {
            create: arm('create').key,
            stage: arm('stage').key,
            start: arm('start').key,
            cancel: arm('cancel').key,
        },
        armedKey: arm('create').key,
        ...overrides,
    };
}

describe('Recipe Console Execute action policy', () => {
    it.each([
        ['connecting'],
        ['offline'],
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
    ] as const)('enables the armed lifecycle action for state %s', (
        runState,
        action,
    ) => {
        const armedKey = arm(action).key;
        const policy = deriveExecuteActionPolicy(input({
            runState,
            hasKnownRun: runState !== undefined,
            armedKey,
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
            armedKey: arm('cancel').key,
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
            armedKey: arm('cancel').key,
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
            armedKey: arm('start').key,
        }));
        const draft = deriveExecuteActionPolicy(input({
            runState: 'draft',
            hasKnownRun: true,
            armedKey: arm('start').key,
        }));

        expect(waiting.stage).toMatchObject({ enabled: false, code: 'run-state' });
        expect(waiting.start).toMatchObject({ enabled: false, code: 'run-state' });
        expect(draft.start).toMatchObject({ enabled: false, code: 'run-state' });
    });

    it('requires a matching explicit arm context for every live mutation', () => {
        const policy = deriveExecuteActionPolicy(input({ armedKey: undefined }));

        expect(policy.create).toMatchObject({
            enabled: false,
            code: 'arming-required',
        });
        expect(policy.create.reason).toContain('arm');
    });

    it('changes the arm key for every action or operational context field', () => {
        const baseline = arm('stage');
        const variants = [
            arm('create'),
            arm('stage', { controlBaseUrl: 'https://other-control.test' }),
            arm('stage', { controlRunId: 'run-b' }),
            arm('stage', { distributedRunId: 'distributed-b' }),
            arm('stage', { recipeIds: ['recipe-b'] }),
            arm('stage', { targetAgentIds: ['agent-a'] }),
            arm('stage', { manifestFingerprint: '{"manifest":"b"}' }),
        ];

        expect(new Set(variants.map((variant) => variant.key)).size)
            .toBe(variants.length);
        expect(variants.every((variant) => variant.key !== baseline.key)).toBe(true);
        expect(baseline.label).toContain('https://control.test/root');
        expect(baseline.label).toContain('distributed-a');
        expect(baseline.label).toContain('recipe-a');
        expect(baseline.label).toContain('2 targets');
    });

    it('disables every second action while one action is busy', () => {
        const policy = deriveExecuteActionPolicy(input({ busyAction: 'stage' }));

        expect(Object.values(policy).every((decision) =>
            !decision.enabled && decision.code === 'busy'
        )).toBe(true);
    });
});
