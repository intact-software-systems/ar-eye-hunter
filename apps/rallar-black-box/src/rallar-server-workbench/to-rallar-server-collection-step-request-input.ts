import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    RallarServerRestCollectionRequest,
    RallarServerRestCollectionStep,
    RallarServerRestCollectionVariables,
    RallarServerRestRequestInput
} from './rallar-server-workbench-contracts.ts';
import { resolveRallarServerCollectionValue } from './resolve-rallar-server-collection-value.ts';

export interface RallarServerCollectionStepRequestSource {
    readonly step: RallarServerRestCollectionStep;
    readonly apiBaseUrl: string;
    readonly variables: RallarServerRestCollectionVariables;
    readonly authSession: AuthSession | undefined;
    readonly defaultTimeoutMs: number;
    readonly forbidPlaceholderBaseUrl: boolean;
}

export function toRallarServerCollectionStepRequestInput(
    source: RallarServerCollectionStepRequestSource
): RallarServerRestRequestInput {
    const request = resolveRallarServerCollectionValue(
        source.step.request,
        source.variables
    ) as RallarServerRestCollectionRequest;
    return {
        apiBaseUrl: source.apiBaseUrl,
        method: request.method,
        path: request.path,
        headersText: request.headers ? JSON.stringify(request.headers, null, 2) : '{}',
        queryText: request.query ? JSON.stringify(request.query, null, 2) : '{}',
        bodyText: request.body === undefined || request.method === 'GET' ? '' : JSON.stringify(request.body, null, 2),
        responseBodyMode: request.responseBodyMode ?? 'auto',
        attachAuth: request.attachAuth ?? false,
        authSession: source.authSession,
        timeoutMs: request.timeoutMs ?? source.defaultTimeoutMs,
        forbidPlaceholderBaseUrl: source.forbidPlaceholderBaseUrl
    };
}
