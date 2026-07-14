import type {
    RallarServerRestCollection,
    RallarServerRestCollectionVariables,
} from '../../../rallar-server-workbench.ts';

export function parseRallarServerCollectionText(
    text: string,
): RallarServerRestCollection {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Collection JSON must be an object.');
    }
    const collection = value as RallarServerRestCollection;
    if (
        !collection.collectionId ||
        !collection.name ||
        !Array.isArray(collection.steps)
    ) {
        throw new Error(
            'Collection JSON requires collectionId, name, and steps.',
        );
    }
    return collection;
}

export function parseRallarServerCollectionVariablesText(
    text: string,
): RallarServerRestCollectionVariables {
    const value = JSON.parse(text || '{}') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Collection variables must be a JSON object.');
    }
    return value as RallarServerRestCollectionVariables;
}
