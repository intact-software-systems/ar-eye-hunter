import {
    formatJsonSchemaValidationErrors,
    RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA,
    validateJsonSchema
} from '@shared-test/rallar-bb-test/schema.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/types.ts';

export function parseRunManagerCommandText(text: string): RallarBlackBoxTestCommand {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Command JSON must be an object.');
    }
    const result = validateJsonSchema(
        RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA,
        value
    );
    if (!result.ok) {
        throw new Error(
            `Command JSON failed schema validation:\n${formatJsonSchemaValidationErrors(result.errors)}`
        );
    }
    return value as RallarBlackBoxTestCommand;
}

export function runManagerCommandPrefix(command: RallarBlackBoxTestCommand): string {
    const base = command.commandId ?? command.kind;
    return `${base.replace(/[^A-Za-z0-9_.:-]+/g, '-')}-${Date.now()}`;
}
