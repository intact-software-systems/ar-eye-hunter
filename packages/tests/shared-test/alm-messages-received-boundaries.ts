import { validateAlmControlCommand } from '@shared-test/rallar-bb-test/alm/validate-alm-control-command.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';

/** A presence count with no claim of its own: each contract test adds the fields of the claim it covers. */
export const command = { kind: 'messages.received', typeId: 'chat', count: 20, windowMs: 600_000 };

/** The two boundaries a `messages.received` command crosses before an agent runs it. */
export function readBoundaries(candidate: ApiJsonObject) {
    return {
        schema: validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, candidate).ok,
        command: validateAlmControlCommand(candidate, 'messages.received').length === 0
    };
}
