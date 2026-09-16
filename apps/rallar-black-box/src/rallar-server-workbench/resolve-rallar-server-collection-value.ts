import type { RallarServerRestCollectionVariables } from './rallar-server-workbench-contracts.ts';
import { resolveRallarServerJsonPath } from './resolve-rallar-server-json-path.ts';

const VARIABLE_REFERENCE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}|\$\{([A-Za-z0-9_.-]+)\}/g;

/** Substitutes `{{name}}` and `${name}` references in every string of a collection value; an unresolved reference stays. */
export function resolveRallarServerCollectionValue(
    value: unknown,
    variables: RallarServerRestCollectionVariables
): unknown {
    if (typeof value === 'string') {
        return value.replace(
            VARIABLE_REFERENCE,
            (match, moustacheKey: string | undefined, dollarKey: string | undefined) => {
                const resolved = resolveRallarServerJsonPath(variables, moustacheKey ?? dollarKey);
                return resolved === undefined || resolved === null ? match : String(resolved);
            }
        );
    }
    if (Array.isArray(value)) {
        return value.map((item) => resolveRallarServerCollectionValue(item, variables));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, resolveRallarServerCollectionValue(entry, variables)])
        );
    }
    return value;
}
