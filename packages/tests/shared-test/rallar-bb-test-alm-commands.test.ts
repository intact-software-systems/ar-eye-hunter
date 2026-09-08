import { describe, expect, it } from 'vitest';
import { validateRallarBlackBoxTestCommand } from '../../shared-test/rallar-bb-test/control-protocol.ts';
import {
    formatJsonSchemaValidationErrors,
    RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
    validateJsonSchema
} from '../../shared-test/rallar-bb-test/schema.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_KINDS } from '../../shared-test/rallar-bb-test/types.ts';

const ALM_COMMAND_KINDS = [
    'messages.send',
    'messages.observe',
    'messages.cancel',
    'messages.received',
    'messages.receipts',
    'fault.inject',
    'storage.counters',
    'agent.reload'
] as const;

function recipeWithCommand(commandId: string, command: Record<string, unknown>) {
    return {
        recipeId: 'alm-send',
        name: 'alm send',
        commands: [{ commandId, timeoutMs: 5_000, ...command }]
    };
}

describe('ALM recipe commands', () => {
    it('registers every ALM command kind', () => {
        for (const kind of ALM_COMMAND_KINDS) {
            expect(RALLAR_BLACK_BOX_TEST_COMMAND_KINDS).toContain(kind);
        }
    });

    it('accepts a valid messages.send and rejects a send without a carrier', () => {
        const valid = validateJsonSchema(
            RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
            recipeWithCommand('send-1', {
                kind: 'messages.send',
                carrier: 'ws',
                typeId: 'alm.conformance',
                payload: { n: 1 },
                handleId: 'h-1'
            })
        );
        expect(valid.ok, valid.ok ? undefined : formatJsonSchemaValidationErrors(valid.errors)).toBe(true);

        const invalid = validateJsonSchema(
            RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
            recipeWithCommand('send-2', {
                kind: 'messages.send',
                typeId: 'x',
                payload: {}
            })
        );
        expect(invalid.ok).toBe(false);
        if (!invalid.ok) {
            expect(formatJsonSchemaValidationErrors(invalid.errors)).toContain('carrier');
        }
    });

    it('rejects a control-protocol messages.send without a carrier', () => {
        const result = validateRallarBlackBoxTestCommand({
            kind: 'messages.send',
            commandId: 'send-3',
            typeId: 'x',
            payload: {}
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('carrier');
        }
    });
});
