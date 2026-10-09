import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { assertEquals } from '@std/assert';

import { createRallarBlackBoxControlService } from '../src/control-service.ts';
import {
    assertRight,
    toControlServiceInput,
    toRegisterEnvelope
} from './support/control-service-test-fixtures.ts';

for (const selection of ['recipe', 'step', 'omitted'] as const) {
    for (const bodyId of ['acknowledged', 'unowned', undefined]) {
        Deno.test(`reference admission preserves ${selection} capture requirement with body ${bodyId ?? 'absent'}`, () => {
            const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 100 }));
            service.receiveClientEnvelope(toRegisterEnvelope());
            const recipe: RallarBlackBoxTestRecipe = {
                schemaVersion: 1,
                recipeId: 'loaded',
                ...(selection === 'recipe' ? { rtcCaptureMode: 'native' as const } : {}),
                commands: [{ kind: 'rtc.connect', commandId: 'connect', ...(selection === 'step' ? { rallar: { rtcCaptureMode: 'native' as const } } : {}) }]
            };
            assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'load', command: { kind: 'recipe.load', recipe } }));
            service.takeDispatchableCommands('run-1', 'agent-1');
            assertEquals(
                service.receiveClientEnvelope({
                    kind: 'result',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-1',
                    commandId: 'load',
                    ok: true,
                    result: {
                        commandId: 'load',
                        kind: 'recipe.load',
                        status: 'ok',
                        ok: true,
                        startedAtEpochMs: 0,
                        endedAtEpochMs: 1,
                        durationMs: 1,
                        value: { recipeBodyId: 'acknowledged' }
                    }
                }).accepted,
                true
            );
            assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'reference', command: { kind: 'recipe.run' } }));
            const dispatch = service.takeDispatchableCommands('run-1', 'agent-1');
            assertEquals(
                dispatch[0].command.kind === 'recipe.run' && dispatch[0].command.expectedRecipeBodyId,
                selection === 'omitted' ? undefined : 'acknowledged'
            );
            const accepted = service.receiveClientEnvelope({
                kind: 'result',
                protocolVersion: 1,
                runId: 'run-1',
                agentId: 'agent-1',
                commandId: 'reference',
                ok: true,
                result: {
                    commandId: 'reference',
                    kind: 'recipe.run',
                    status: 'ok',
                    ok: true,
                    startedAtEpochMs: 2,
                    endedAtEpochMs: 3,
                    durationMs: 1,
                    value: {
                        recipeId: 'loaded',
                        invocation: {
                            invocationId: 'invocation',
                            ...(bodyId === undefined ? {} : { recipeBodyId: bodyId }),
                            ...(selection === 'recipe' ? { recipe: 'native' } : {})
                        },
                        results: []
                    }
                }
            }).accepted;
            assertEquals(accepted, selection === 'omitted');
            const snapshot = service.snapshotRun('run-1');
            assertEquals(
                snapshot?.commands.find((command) => command.envelope.commandId === 'reference')?.completedAtEpochMs !== undefined,
                selection === 'omitted'
            );
            assertEquals(snapshot?.results.some((result) => result.commandId === 'reference'), selection === 'omitted');
        });
    }
}

for (const bodyId of ['acknowledged', 'unowned', undefined]) {
    Deno.test(`native capture receipt admits only its acknowledged reference body: ${bodyId ?? 'absent'}`, () => {
        const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 100 }));
        service.receiveClientEnvelope(toRegisterEnvelope());
        const recipe: RallarBlackBoxTestRecipe = {
            schemaVersion: 1,
            recipeId: 'native-recipe',
            rtcCaptureMode: 'native',
            commands: [{ kind: 'rtc.connect', commandId: 'connect' }]
        };
        assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'load', command: { kind: 'recipe.load', recipe } }));
        service.takeDispatchableCommands('run-1', 'agent-1');
        assertEquals(
            service.receiveClientEnvelope({
                kind: 'result',
                protocolVersion: 1,
                runId: 'run-1',
                agentId: 'agent-1',
                commandId: 'load',
                ok: true,
                result: {
                    commandId: 'load',
                    kind: 'recipe.load',
                    status: 'ok',
                    ok: true,
                    startedAtEpochMs: 0,
                    endedAtEpochMs: 1,
                    durationMs: 1,
                    value: { recipeBodyId: 'acknowledged' }
                }
            }).accepted,
            true
        );
        assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'reference', command: { kind: 'recipe.run' } }));
        service.takeDispatchableCommands('run-1', 'agent-1');
        assertEquals(
            service.receiveClientEnvelope({
                kind: 'result',
                protocolVersion: 1,
                runId: 'run-1',
                agentId: 'agent-1',
                commandId: 'reference',
                ok: true,
                result: {
                    commandId: 'reference',
                    kind: 'recipe.run',
                    status: 'ok',
                    ok: true,
                    startedAtEpochMs: 2,
                    endedAtEpochMs: 3,
                    durationMs: 1,
                    value: {
                        recipeId: 'native-recipe',
                        invocation: { invocationId: 'invocation', ...(bodyId === undefined ? {} : { recipeBodyId: bodyId }), recipe: 'native' },
                        results: [{
                            commandId: 'connect',
                            kind: 'rtc.connect',
                            status: 'ok',
                            ok: true,
                            startedAtEpochMs: 2,
                            endedAtEpochMs: 3,
                            durationMs: 1,
                            value: {
                                rtcCapture: {
                                    status: 'observed',
                                    value: {
                                        configuration: { mode: 'native', origin: 'recipe' },
                                        application: { status: 'applied', mode: 'native' },
                                        configurationVersion: 1,
                                        connectionId: { status: 'observed', value: 'connection' },
                                        nativeScopeId: { status: 'observed', value: 'scope' },
                                        nativeAvailability: { status: 'observed', value: 'enabled' },
                                        nativeCoverage: 'attached'
                                    }
                                }
                            }
                        }]
                    }
                }
            }).accepted,
            bodyId === 'acknowledged'
        );
    });
}
