import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { RallarServerRestCollection } from './rallar-server-workbench-contracts.ts';

/** An authored collection value: an object that names a collection, a name, and its steps. */
export function decodeRallarServerRestCollection(
    value: unknown
): Either<string, RallarServerRestCollection> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft('Collection JSON must be an object.');
    }
    return isRallarServerRestCollection(value)
        ? Either.ofRight(value)
        : Either.ofLeft('Collection JSON requires collectionId, name, and steps.');
}

function isRallarServerRestCollection(value: unknown): value is RallarServerRestCollection {
    return isJsonRecordValue(value) && Boolean(value.collectionId) && Boolean(value.name) &&
        Array.isArray(value.steps);
}
