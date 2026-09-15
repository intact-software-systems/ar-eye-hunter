import { describe, expect, it } from 'vitest';
import { parseControlServerMessage, type ControlCommandEnvelope } from '../../shared-test/rallar-bb-test/control-protocol.ts';
import { validateRallarBlackBoxTestCommand } from '../../shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecord
} from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_COMMAND_CAPABILITIES } from '../../shared-test/rallar-bb-test/schema/rallar-black-box-command-capabilities.ts';

function toControlEnvelope(commandId: string, command: RallarBlackBoxTestCommand): ControlCommandEnvelope {
    return {
        kind: 'command',
        protocolVersion: 1,
        runId: 'run-1',
        agentId: 'agent-1',
        commandId,
        command
    };
}

describe('rallar-bb-test control protocol', () => {
    it.each([
        {
            kind: 'formation.command',
            commandId: 'formation-plan',
            command: 'plan',
            roomId: 'room-1',
            applicationId: 'app-1',
            timeoutMs: 5_000
        },
        {
            kind: 'formation.command',
            commandId: 'formation-connect',
            command: 'connect',
            layout: { groupRevision: 4, presenceRevision: 5, version: 2, state: 'active' },
            roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
            timeoutMs: 5_000
        },
        {
            kind: 'formation.readiness',
            commandId: 'formation-ready',
            roomId: 'room-1',
            applicationId: 'app-1',
            timeoutMs: 5_000
        }
    ])('accepts $commandId', (command) => {
        expect(validateRallarBlackBoxTestCommand(command)).toEqual({ ok: true });
    });

    it.each([
        {
            kind: 'formation.command',
            commandId: 'formation-bad-1',
            command: 'explode',
            roomId: 'room-1',
            applicationId: 'app-1',
            timeoutMs: 5_000
        },
        {
            kind: 'formation.command',
            commandId: 'formation-bad-2',
            command: 'plan',
            landing: 'hold',
            roomId: 'room-1',
            applicationId: 'app-1',
            timeoutMs: 5_000
        },
        // A formation command that names no room has nothing to address; `rtc.connect` tolerates
        // that today, so this rule is written for the family rather than borrowed from it.
        { kind: 'formation.readiness', commandId: 'formation-bad-3', timeoutMs: 5_000 },
        {
            kind: 'formation.command',
            commandId: 'formation-bad-4',
            roomId: 'room-1',
            applicationId: 'app-1',
            timeoutMs: 5_000
        }
    ])('rejects $commandId', (command) => {
        expect(validateRallarBlackBoxTestCommand(command).ok).toBe(false);
    });

    it('accepts the RTC diagnostics option on health commands', () => {
        expect(validateRallarBlackBoxTestCommand({
            kind: 'health',
            includeRtcDiagnostics: true
        })).toEqual({ ok: true });

        expect(validateRallarBlackBoxTestCommand({
            kind: 'health',
            includeRtcDiagnostics: 'yes'
        })).toEqual({
            ok: false,
            error: 'health.includeRtcDiagnostics must be a boolean.',
            messages: ['health.includeRtcDiagnostics must be a boolean.']
        });
    });

    it('accepts recipe.load containing rtc.connect readiness', () => {
        const parsed = parseControlServerMessage(
            JSON.stringify(toControlEnvelope('recipe-load-rtc-readiness-1', {
                kind: 'recipe.load',
                commandId: 'recipe-load-rtc-readiness-1',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'rtc-readiness',
                    commands: [
                        {
                            kind: 'rtc.connect',
                            commandId: 'rtc-connect-ready',
                            connection: 'rtc',
                            roomId: 'room-1',
                            applicationId: 'rallar-server',
                            workspaceId: 'default',
                            transport: 'realtime',
                            readiness: {
                                minReadyPeers: 1,
                                timeoutMs: 10_000,
                                intervalMs: 100
                            }
                        }
                    ]
                }
            })),
            { runId: 'run-1', agentId: 'agent-1' }
        );

        expect(parsed.ok).toBe(true);
    });

    it('rejects malformed rtc.connect readiness in recipe.load', () => {
        const parsed = parseControlServerMessage(
            JSON.stringify(toControlEnvelope('recipe-load-rtc-readiness-invalid-1', {
                kind: 'recipe.load',
                commandId: 'recipe-load-rtc-readiness-invalid-1',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'rtc-readiness-invalid',
                    commands: [
                        {
                            kind: 'rtc.connect',
                            commandId: 'rtc-connect-invalid-ready',
                            connection: 'rtc',
                            readiness: {
                                timeoutMs: 0
                            }
                        }
                    ]
                }
            })),
            { runId: 'run-1', agentId: 'agent-1' }
        );

        expect(parsed).toEqual({
            ok: false,
            error: 'Control command payload is invalid: recipe.load.recipe.commands[0]: rtc.readiness.timeoutMs must be >= 1.'
        });
    });

    it('accepts recipe.load containing rtc.stream', () => {
        const parsed = parseControlServerMessage(
            JSON.stringify(toControlEnvelope('recipe-load-rtc-stream-1', {
                kind: 'recipe.load',
                commandId: 'recipe-load-rtc-stream-1',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'rtc-stream',
                    commands: [
                        {
                            kind: 'rtc.stream',
                            commandId: 'stream-position',
                            connection: 'rtcRealtime',
                            transport: 'realtime',
                            roomId: 'arena-1',
                            applicationId: 'rallar-server',
                            workspaceId: 'default',
                            count: 100,
                            intervalMs: 50,
                            maxInFlight: 64,
                            drainTimeoutMs: 5_000,
                            send: {
                                roomId: 'arena-1',
                                data: {
                                    topic: 'room.black-box.rtc-realtime.position',
                                    seq: '{stream.index}'
                                }
                            },
                            thresholds: {
                                minSendSuccessRatio: 0.99,
                                maxDroppedFrames: 0
                            }
                        }
                    ]
                }
            })),
            { runId: 'run-1', agentId: 'agent-1' }
        );

        expect(parsed.ok).toBe(true);
    });

    it('rejects malformed rtc.stream in recipe.load', () => {
        const parsed = parseControlServerMessage(
            JSON.stringify(toControlEnvelope('recipe-load-rtc-stream-invalid-1', {
                kind: 'recipe.load',
                commandId: 'recipe-load-rtc-stream-invalid-1',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'rtc-stream-invalid',
                    commands: [
                        {
                            kind: 'rtc.stream',
                            commandId: 'stream-invalid',
                            intervalMs: 50,
                            send: {}
                        }
                    ]
                }
            })),
            { runId: 'run-1', agentId: 'agent-1' }
        );

        expect(parsed).toEqual({
            ok: false,
            error: 'Control command payload is invalid: recipe.load.recipe.commands[0]: rtc.stream requires count or durationMs.'
        });
    });

    it('accepts schema-supported loop thresholds in recipe.load', () => {
        const parsed = parseControlServerMessage(
            JSON.stringify(toControlEnvelope('recipe-load-loop-thresholds', {
                kind: 'recipe.load',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'loop-thresholds',
                    commands: [{
                        kind: 'loop',
                        count: 2,
                        intervalMs: 50,
                        thresholds: {
                            minAchievedRateHz: 10,
                            maxAverageStartDriftMs: 25,
                            maxStartDriftMs: 50,
                            maxJitterMs: 20,
                            minSendSuccessRatio: 0.95,
                            failOnBackpressure: true
                        },
                        commands: [{ kind: 'health' }]
                    }]
                }
            })),
            { runId: 'run-1', agentId: 'agent-1' }
        );

        expect(parsed.ok).toBe(true);
    });

    it('rejects malformed loop thresholds in recipe.load', () => {
        const parsed = parseControlServerMessage(
            JSON.stringify(toControlEnvelope('recipe-load-loop-thresholds-invalid', {
                kind: 'recipe.load',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'loop-thresholds-invalid',
                    commands: [{
                        kind: 'loop',
                        count: 2,
                        thresholds: { minSendSuccessRatio: 1.1 },
                        commands: [{ kind: 'health' }]
                    }]
                }
            })),
            { runId: 'run-1', agentId: 'agent-1' }
        );

        expect(parsed).toEqual({
            ok: false,
            error: 'Control command payload is invalid: recipe.load.recipe.commands[0]: loop.thresholds.minSendSuccessRatio must be between 0 and 1.'
        });
    });

    it.each([
        [{ minAchievedRateHz: Number.NaN }, 'loop.thresholds.minAchievedRateHz must be a finite number.'],
        [{ maxStartDriftMs: Number.POSITIVE_INFINITY }, 'loop.thresholds.maxStartDriftMs must be a finite number.'],
        [{ minSendSuccessRatio: Number.NaN }, 'loop.thresholds.minSendSuccessRatio must be a finite number.'],
        [{ unknown: 1 }, 'loop.thresholds has unsupported field: unknown.'],
        ['invalid', 'loop.thresholds must be an object.'],
        [{ failOnBackpressure: 'yes' }, 'loop.thresholds.failOnBackpressure must be a boolean.']
    ])('rejects direct malformed loop threshold input %#', (thresholds, error) => {
        expect(validateRallarBlackBoxTestCommand({
            kind: 'loop',
            commands: [{ kind: 'health' }],
            thresholds
        })).toEqual({ ok: false, error, messages: [error] });
    });

    it('accepts the rtc.stream backpressure threshold', () => {
        expect(validateRallarBlackBoxTestCommand({
            kind: 'rtc.stream',
            send: {},
            count: 2,
            intervalMs: 50,
            thresholds: { maxBackpressureCount: 0 }
        })).toEqual({ ok: true });
    });

    it('rejects a ws.send that carries no data', () => {
        expect(validateRallarBlackBoxTestCommand({ kind: 'ws.send', connection: 'control' })).toEqual({
            ok: false,
            error: 'ws.send.data is required.',
            messages: ['ws.send.data is required.']
        });
    });

    it('reports every issue in a command, prefixing nested issues with their path', () => {
        expect(validateRallarBlackBoxTestCommand({
            kind: 'recipe.load',
            recipe: {
                schemaVersion: 1,
                recipeId: 'several-issues',
                commands: [{
                    kind: 'loop',
                    count: 0,
                    commands: [{ kind: 'health' }],
                    thresholds: { maxJitterMs: -1, bogus: true }
                }]
            }
        })).toEqual({
            ok: false,
            error: [
                'recipe.load.recipe.commands[0]: loop.count must be >= 1.',
                'recipe.load.recipe.commands[0]: loop.thresholds has unsupported field: bogus.',
                'recipe.load.recipe.commands[0]: loop.thresholds.maxJitterMs must be >= 0.'
            ].join('\n'),
            messages: [
                'recipe.load.recipe.commands[0]: loop.count must be >= 1.',
                'recipe.load.recipe.commands[0]: loop.thresholds has unsupported field: bogus.',
                'recipe.load.recipe.commands[0]: loop.thresholds.maxJitterMs must be >= 0.'
            ]
        });
    });

    it('admits the capability catalog fields and requires each of its required fields', () => {
        const controlCapabilities = RALLAR_BLACK_BOX_COMMAND_CAPABILITIES
            .filter((capability) => !capability.kind.startsWith('crdt.'));
        for (const capability of controlCapabilities) {
            const example: RallarBlackBoxTestRecord = { ...capability.example };
            expect(validateRallarBlackBoxTestCommand(example), capability.kind).toEqual({ ok: true });
            expect(validateRallarBlackBoxTestCommand({ ...example, undeclared: true }), capability.kind).toMatchObject({
                ok: false,
                error: expect.stringContaining(`${capability.kind} has unsupported field: undeclared.`)
            });
            for (const field of [...capability.requiredFields, ...capability.optionalFields]) {
                const withField = validateRallarBlackBoxTestCommand({ ...example, [field]: example[field] ?? null });
                const error = withField.ok ? '' : withField.error;
                expect(error, `${capability.kind}.${field}`).not.toContain('has unsupported field');
            }
            for (const field of capability.requiredFields) {
                const withoutField = { ...example };
                Reflect.deleteProperty(withoutField, field);
                expect(validateRallarBlackBoxTestCommand(withoutField).ok, `${capability.kind} without ${field}`).toBe(false);
            }
        }
    });
});
