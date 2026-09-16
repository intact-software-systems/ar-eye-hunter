import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { Either } from '@shared/resilience/Either.ts';
import type {
    RallarServerRestCollection,
    RallarServerRestCollectionVariables
} from '../../../rallar-server-workbench/rallar-server-workbench-contracts.ts';

export interface RallarServerCollectionDraftValues {
    readonly collection: RallarServerRestCollection;
    readonly variables: RallarServerRestCollectionVariables;
}

export function decodeRallarServerCollectionText(text: string): Either<string, RallarServerRestCollection> {
    try {
        const value = JSON.parse(text);
        if (!isJsonRecordValue(value)) {
            return Either.ofLeft('Collection JSON must be an object.');
        }
        return isRallarServerRestCollection(value)
            ? Either.ofRight(value)
            : Either.ofLeft('Collection JSON requires collectionId, name, and steps.');
    }
    catch (error) {
        return Either.ofLeft(error instanceof Error ? error.message : String(error));
    }
}

export function decodeRallarServerCollectionVariablesText(
    text: string
): Either<string, RallarServerRestCollectionVariables> {
    try {
        const value = JSON.parse(text || '{}');
        return isJsonRecordValue(value)
            ? Either.ofRight(value)
            : Either.ofLeft('Collection variables must be a JSON object.');
    }
    catch (error) {
        return Either.ofLeft(error instanceof Error ? error.message : String(error));
    }
}

export function decodeRallarServerCollectionDraftText(
    collectionText: string,
    variablesText: string
): Either<string, RallarServerCollectionDraftValues> {
    return decodeRallarServerCollectionText(collectionText).flatMap(
        (error) => Either.ofLeft(error),
        (collection) =>
            decodeRallarServerCollectionVariablesText(variablesText).mapRight((variables) => ({
                collection,
                variables
            }))
    );
}

function isRallarServerRestCollection(value: unknown): value is RallarServerRestCollection {
    return isJsonRecordValue(value) && Boolean(value.collectionId) && Boolean(value.name) && Array.isArray(value.steps);
}
