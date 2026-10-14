import { describe, expect, it } from 'vitest';

import { toRallarBlackBoxCompositeResultFlatEntries } from '@shared-test/rallar-bb-test/composite-results.ts';
import { parseControlClientMessage } from '@shared-test/rallar-bb-test/control-protocol.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import {
    createCaptureApplicationRuntime,
    createCaptureController,
    executeSerializedControllerCommand,
    installCaptureApplicationTestEnvironment
} from './capture-application-test-runtime.ts';

installCaptureApplicationTestEnvironment();

const boundaryRecipe: RallarBlackBoxTestRecipe = {
    schemaVersion: 1,
    recipeId: 'result-depth-boundary',
    commands: [
        { kind: 'configure', commandId: 'configure-capture', config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app' } } },
        {
            kind: 'parallel',
            commandId: 'outer-parallel',
            maxConcurrency: 1,
            groups: [{
                groupId: 'outer',
                commands: [{
                    kind: 'loop',
                    commandId: 'outer-loop',
                    count: 1,
                    commands: [{
                        kind: 'parallel',
                        commandId: 'inner-parallel',
                        maxConcurrency: 1,
                        groups: [{
                            groupId: 'inner',
                            commands: [{
                                kind: 'loop',
                                commandId: 'inner-loop',
                                count: 1,
                                commands: [
                                    { kind: 'rtc.connect', commandId: 'deep-connect' },
                                    { kind: 'health', commandId: 'deep-health' }
                                ]
                            }]
                        }]
                    }]
                }]
            }]
        }
    ]
};

describe('recipe result depth admission', () => {
    it('refuses a fifth authored composite level at the control command boundary', () => {
        const validation = validateRallarBlackBoxTestCommand({
            kind: 'recipe.run',
            rtcCaptureMode: 'off',
            recipe: {
                schemaVersion: 1,
                recipeId: 'too-deep',
                commands: [
                    boundaryRecipe.commands[0],
                    { kind: 'loop', commandId: 'extra-loop', count: 1, commands: [boundaryRecipe.commands[1]] }
                ]
            }
        });
        expect(validation.ok).toBe(false);
        if (!validation.ok) {
            expect(validation.error).toContain('max composite depth 4');
        }
    });

    it('admits boundary leaves but refuses a serialized result with a fifth composite level', async () => {
        expect(validateRallarBlackBoxTestCommand({ kind: 'recipe.run', rtcCaptureMode: 'off', recipe: boundaryRecipe })).toEqual({ ok: true });
        const { page, runtime } = createCaptureApplicationRuntime();
        const controller = createCaptureController();
        controller.receiveClientEnvelope({
            kind: 'register',
            protocolVersion: 1,
            runId: 'depth-run',
            agentId: 'depth-agent',
            atEpochMs: 1_000,
            identity: { sessionLabel: 'depth-agent', updatedAtEpochMs: 1_000 },
            resume: { completedCommandIds: [] }
        });
        try {
            const queued = controller.enqueueCommand({
                runId: 'depth-run',
                agentId: 'depth-agent',
                commandId: 'boundary-run',
                command: { kind: 'recipe.run', rtcCaptureMode: 'off', recipe: boundaryRecipe }
            });
            expect(queued.left).toBeUndefined();
            const [dispatch] = controller.takeDispatchableCommands('depth-run', 'depth-agent');
            if (dispatch === undefined) {
                throw new Error('Boundary recipe was not dispatched.');
            }
            const { result, envelope } = await executeSerializedControllerCommand(runtime, dispatch);
            expect(result.ok).toBe(true);
            const overDepthEnvelope = structuredClone(envelope);
            if (overDepthEnvelope.result === undefined) {
                throw new Error('Boundary result was not serialized.');
            }
            const overDepthHealth = toRallarBlackBoxCompositeResultFlatEntries([overDepthEnvelope.result])
                .find((entry) => entry.commandId.endsWith(':deep-health'))?.result;
            if (overDepthHealth === undefined) {
                throw new Error('Boundary health leaf was not recorded.');
            }
            Reflect.set(overDepthHealth, 'kind', 'loop');
            Reflect.set(overDepthHealth, 'value', {
                results: [{
                    commandId: 'illegal-child',
                    parentCommandId: overDepthHealth.commandId,
                    path: '$.iterations[1].commands[0]',
                    sourceRecipePath: '$.commands[0]',
                    childIndex: 0,
                    commandIndex: 0,
                    iteration: 1,
                    result: {
                        commandId: 'illegal-child',
                        kind: 'health',
                        status: 'ok',
                        ok: true,
                        startedAtEpochMs: 1,
                        endedAtEpochMs: 1,
                        durationMs: 0
                    }
                }]
            });
            const parsedOverDepth = parseControlClientMessage(JSON.stringify(overDepthEnvelope));
            expect(parsedOverDepth.ok).toBe(true);
            if (!parsedOverDepth.ok || parsedOverDepth.envelope.kind !== 'result') {
                throw new Error('Over-depth result did not remain a parseable control envelope.');
            }
            if (parsedOverDepth.envelope.result === undefined) {
                throw new Error('Over-depth control envelope lost its result.');
            }
            const overDepthEntries = toRallarBlackBoxCompositeResultFlatEntries([parsedOverDepth.envelope.result]);
            expect(overDepthEntries.at(-1)?.childDecodeIssues).toEqual([{ valuePath: 'value', invalidFields: ['depth-limit'] }]);
            expect(overDepthEntries.some((entry) => entry.commandId === 'illegal-child')).toBe(false);
            expect(overDepthEntries.find((entry) => entry.kind === 'rtc.connect')?.result.value).toMatchObject({
                rtcCapture: { status: 'observed', value: { application: { status: 'applied', mode: 'off' } } }
            });
            expect(controller.receiveClientEnvelope(parsedOverDepth.envelope).accepted).toBe(false);
            expect(controller.snapshotRun('depth-run')?.results).toEqual([]);
            expect(controller.snapshotCommand('depth-run', 'boundary-run')?.completedAtEpochMs).toBeUndefined();
            expect(controller.receiveClientEnvelope(envelope).accepted).toBe(true);
            const stored = controller.snapshotRun('depth-run')?.results[0]?.result;
            if (stored === undefined) {
                throw new Error('Admitted boundary result was not retained.');
            }
            const entries = toRallarBlackBoxCompositeResultFlatEntries([stored]);
            expect(entries.map((entry) => [entry.commandId, entry.depth, entry.childDecodeIssues])).toEqual([
                ['boundary-run', 0, []],
                ['configure-capture', 1, []],
                ['outer-parallel', 1, []],
                ['outer-parallel:g1:outer:c1:outer-loop', 2, []],
                ['outer-parallel:g1:outer:c1:outer-loop:i1:c1:inner-parallel', 3, []],
                ['outer-parallel:g1:outer:c1:outer-loop:i1:c1:inner-parallel:g1:inner:c1:inner-loop', 4, []],
                ['outer-parallel:g1:outer:c1:outer-loop:i1:c1:inner-parallel:g1:inner:c1:inner-loop:i1:c1:deep-connect', 5, []],
                ['outer-parallel:g1:outer:c1:outer-loop:i1:c1:inner-parallel:g1:inner:c1:inner-loop:i1:c2:deep-health', 5, []]
            ]);
            expect(entries.slice(-2).map((entry) => [entry.kind, entry.status, entry.ok])).toEqual([
                ['rtc.connect', 'ok', true],
                ['health', 'ok', true]
            ]);
            expect(entries.find((entry) => entry.result.kind === 'rtc.connect')?.result.value).toMatchObject({
                rtcCapture: { status: 'observed', value: { configuration: { mode: 'off', origin: 'run' }, application: { status: 'applied', mode: 'off' } } }
            });
        }
        finally {
            await page.close();
        }
    });
});
