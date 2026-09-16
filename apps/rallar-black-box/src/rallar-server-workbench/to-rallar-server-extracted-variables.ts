import type {
    RallarServerRestCollectionExtraction,
    RallarServerRestCollectionVariables,
    RallarServerRestResponse
} from './rallar-server-workbench-contracts.ts';
import { resolveRallarServerJsonPath } from './resolve-rallar-server-json-path.ts';
import { toLowerCaseRallarServerHeaders } from './to-lower-case-rallar-server-headers.ts';

export function toRallarServerExtractedVariables(
    response: RallarServerRestResponse,
    extractions: readonly RallarServerRestCollectionExtraction[] | undefined
): RallarServerRestCollectionVariables {
    const headers = toLowerCaseRallarServerHeaders(response.headers);
    return Object.fromEntries(
        (extractions ?? []).map((extraction) => {
            const value = extraction.from === 'status'
                ? response.status
                : extraction.from === 'headers'
                ? headers[(extraction.header ?? extraction.path ?? '').toLowerCase()]
                : resolveRallarServerJsonPath(response.bodyJson, extraction.path ?? '$');
            return [extraction.name, value === undefined ? extraction.fallback : value];
        })
    );
}
