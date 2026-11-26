import { validateAlmControlCommand } from '@shared-test/rallar-bb-test/alm/validate-alm-control-command.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';

/** Whether each of the two boundaries a `messages.received` command crosses before an agent runs it admits it. */
export interface AlmMessagesReceivedBoundaryAdmission {
    readonly schema: boolean;
    readonly command: boolean;
}

/** A presence count that carries the fields of the claim a contract test covers, and no claim of its own. */
export function toAlmMessagesReceivedCommand(claim: ApiJsonObject) {
    return { kind: 'messages.received', typeId: 'chat', count: 20, windowMs: 600_000, ...claim };
}

export function computeAlmMessagesReceivedBoundaryAdmission(
    candidate: ApiJsonObject
): AlmMessagesReceivedBoundaryAdmission {
    return {
        schema: validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, candidate).ok,
        command: validateAlmControlCommand(candidate, 'messages.received').length === 0
    };
}
