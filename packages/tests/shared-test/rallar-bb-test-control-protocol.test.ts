import { describe, expect, it } from 'vitest';
import {
    type ControlCommandEnvelope,
    parseControlServerMessage,
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
});
