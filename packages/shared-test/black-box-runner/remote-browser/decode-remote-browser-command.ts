import type { ApiJsonObject } from '../../../shared/api/api-json-value.ts';
import { Either } from '../../../shared/resilience/Either.ts';

import { validateRallarBlackBoxTestCommand } from '../../rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type { RallarBlackBoxTestCommand } from '../../rallar-bb-test/rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA } from '../../rallar-bb-test/schema.ts';
import {
    formatJsonSchemaValidationErrors,
    validateJsonSchema
} from '../../rallar-bb-test/schema/json-schema-validation.ts';
import { isRecord } from '../execution/black-box-redaction.ts';
import { decodeScenarioText } from '../scenario-value-decoding.ts';

/** A runner step as the remote-browser command translations read it: its request is the recipe JSON. */
export interface RemoteBrowserCommandInteraction {
    readonly request: ApiJsonObject;
}

/** Decodes a command translated from a step into a control command the agent accepts. */
export function decodeRemoteBrowserCommand(candidate: unknown): Either<Error, RallarBlackBoxTestCommand> {
    // CRDT has a canonical schema, but is absent from the control protocol's kind switch.
    if (isRecord(candidate) && typeof candidate.kind === 'string' && candidate.kind.startsWith('crdt.')) {
        const validation = validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, candidate);
        return validation.ok
            ? Either.ofRight(candidate as RallarBlackBoxTestCommand)
            : Either.ofLeft(new Error(formatJsonSchemaValidationErrors(validation.errors)));
    }
    const validation = validateRallarBlackBoxTestCommand(candidate);
    return validation.ok
        ? Either.ofRight(candidate as RallarBlackBoxTestCommand)
        : Either.ofLeft(new Error(validation.error));
}

/** The first of connection, actor and name the step sets names the connection; a step that sets none uses `default`. */
export function toRemoteBrowserConnectionName(request: ApiJsonObject): Either<Error, string> {
    const value = [request.connection, request.actor, request.name].find((entry) => entry !== undefined);
    const name = value === undefined ? 'default' : decodeScenarioText(value);
    return name === undefined
        ? Either.ofLeft(new Error('Remote command connection must be a scalar identifier.'))
        : Either.ofRight(name);
}
