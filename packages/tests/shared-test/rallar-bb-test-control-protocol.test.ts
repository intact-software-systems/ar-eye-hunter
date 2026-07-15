import { describe, expect, it } from 'vitest';
import {
    type ControlCommandEnvelope,
    parseControlServerMessage,
    validateRallarBlackBoxTestCommand,
} from '../../../packages/shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxTestCommand } from '../../../packages/shared-test/rallar-bb-test/types.ts';

function envelope(commandId: string, command: RallarBlackBoxTestCommand): ControlCommandEnvelope {
    return {
        kind: 'command',
        protocolVersion: 1,
        runId: 'run-1',
        agentId: 'agent-1',
        commandId,
        command,
    };
}

describe('rallar-bb-test control protocol', () => {
    it('accepts the RTC diagnostics option on health commands', () => {
        expect(validateRallarBlackBoxTestCommand({
            kind: 'health',
            includeRtcDiagnostics: true,
        })).toEqual({ ok: true });

        expect(validateRallarBlackBoxTestCommand({
            kind: 'health',
            includeRtcDiagnostics: 'yes',
        } as never)).toEqual({
            ok: false,
            error: 'health.includeRtcDiagnostics must be a boolean.',
        });
    });

    it('accepts recipe.load containing rtc.connect readiness', () => {
        const parsed = parseControlServerMessage(
            JSON.stringify(envelope('recipe-load-rtc-readiness-1', {
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
                                intervalMs: 100,
                            },
                        },
                    ],
                },
            })),
            { runId: 'run-1', agentId: 'agent-1' },
        );

        expect(parsed.ok).toBe(true);
    });

    it('rejects malformed rtc.connect readiness in recipe.load', () => {
        const parsed = parseControlServerMessage(
            JSON.stringify(envelope('recipe-load-rtc-readiness-invalid-1', {
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
                                timeoutMs: 0,
                            },
                        },
                    ],
                },
            })),
            { runId: 'run-1', agentId: 'agent-1' },
        );

        expect(parsed).toEqual({
            ok: false,
            error: 'Control command payload is invalid: recipe.load.recipe.commands[0]: rtc.readiness.timeoutMs must be >= 1.',
        });
    });

    it('accepts recipe.load containing rtc.stream', () => {
        const parsed = parseControlServerMessage(
            JSON.stringify(envelope('recipe-load-rtc-stream-1', {
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
                                    seq: '{stream.index}',
                                },
                            },
                            thresholds: {
                                minSendSuccessRatio: 0.99,
                                maxDroppedFrames: 0,
                            },
                        },
                    ],
                },
            })),
            { runId: 'run-1', agentId: 'agent-1' },
        );

        expect(parsed.ok).toBe(true);
    });

    it('rejects malformed rtc.stream in recipe.load', () => {
        const parsed = parseControlServerMessage(
            JSON.stringify(envelope('recipe-load-rtc-stream-invalid-1', {
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
                            send: {},
                        },
                    ],
                },
            })),
            { runId: 'run-1', agentId: 'agent-1' },
        );

        expect(parsed).toEqual({
            ok: false,
            error: 'Control command payload is invalid: recipe.load.recipe.commands[0]: rtc.stream requires count or durationMs.',
        });
    });

    it('accepts schema-supported loop thresholds in recipe.load', () => {
        const parsed = parseControlServerMessage(
            JSON.stringify(envelope('recipe-load-loop-thresholds', {
                kind: 'recipe.load',
                recipe: {
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
                            failOnBackpressure: true,
                        },
                        commands: [{ kind: 'health' }],
                    }],
                },
            })),
            { runId: 'run-1', agentId: 'agent-1' },
        );

        expect(parsed.ok).toBe(true);
    });

    it('rejects malformed loop thresholds in recipe.load', () => {
        const parsed = parseControlServerMessage(
            JSON.stringify(envelope('recipe-load-loop-thresholds-invalid', {
                kind: 'recipe.load',
                recipe: {
                    recipeId: 'loop-thresholds-invalid',
                    commands: [{
                        kind: 'loop',
                        count: 2,
                        thresholds: { minSendSuccessRatio: 1.1 },
                        commands: [{ kind: 'health' }],
                    }],
                },
            })),
            { runId: 'run-1', agentId: 'agent-1' },
        );

        expect(parsed).toEqual({
            ok: false,
            error: 'Control command payload is invalid: recipe.load.recipe.commands[0]: loop.thresholds.minSendSuccessRatio must be between 0 and 1.',
        });
    });

    it.each([
        [{ minAchievedRateHz: Number.NaN }, 'loop.thresholds.minAchievedRateHz must be a finite number.'],
        [{ maxStartDriftMs: Number.POSITIVE_INFINITY }, 'loop.thresholds.maxStartDriftMs must be a finite number.'],
        [{ minSendSuccessRatio: Number.NaN }, 'loop.thresholds.minSendSuccessRatio must be a finite number.'],
        [{ unknown: 1 }, 'loop.thresholds has unsupported field: unknown.'],
        ['invalid', 'loop.thresholds must be an object.'],
        [{ failOnBackpressure: 'yes' }, 'loop.thresholds.failOnBackpressure must be a boolean.'],
    ])('rejects direct malformed loop threshold input %#', (thresholds, error) => {
        expect(validateRallarBlackBoxTestCommand({
            kind: 'loop', commands: [{ kind: 'health' }], thresholds,
        } as never)).toEqual({ ok: false, error });
    });
});
