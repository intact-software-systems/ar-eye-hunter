import {
    DIAGNOSTIC_BRIDGE_LEGACY_SURFACE_IDS,
    DIAGNOSTIC_BRIDGE_PROVIDERS,
    DIAGNOSTIC_BRIDGE_SOURCE_VIEWS,
    DIAGNOSTIC_BRIDGE_TRANSPORTS,
    DIAGNOSTIC_BRIDGE_URL_QUERY_MAX_BYTES,
    DIAGNOSTIC_BRIDGE_URL_STRING_MAX_BYTES,
    type DiagnosticBridgeLegacySurfaceId,
    type DiagnosticBridgeProvider,
    type DiagnosticBridgeSourceView,
    type DiagnosticBridgeTransport,
} from './diagnostic-bridge-url-contract.ts';

const SELECTION_FIELDS = [
    'controlRunId',
    'distributedRunId',
    'agentId',
    'recipeId',
    'commandId',
] as const satisfies readonly (keyof DiagnosticBridgeReturnInput)[];

export type DiagnosticBridgeReturnInput = Readonly<{
    version: 1;
    provider?: DiagnosticBridgeProvider;
    view?: DiagnosticBridgeSourceView;
    controlRunId?: string;
    distributedRunId?: string;
    agentId?: string;
    recipeId?: string;
    commandId?: string;
    transport?: DiagnosticBridgeTransport;
    legacySurface?: DiagnosticBridgeLegacySurfaceId;
}>;

export function buildDiagnosticBridgeReturnHref(
    input: DiagnosticBridgeReturnInput | undefined,
): string | undefined {
    if (
        input?.version !== 1
        || !input.view
        || !includes(DIAGNOSTIC_BRIDGE_SOURCE_VIEWS, input.view)
        || (input.provider
            && !includes(DIAGNOSTIC_BRIDGE_PROVIDERS, input.provider))
    ) {
        return undefined;
    }

    const params = new URLSearchParams();
    appendAllowed(params, 'provider', input.provider);
    params.set('v', '1');
    params.set('experience', 'recipe-console');
    params.set('view', input.view);
    if (
        input.view === 'advanced'
        && input.legacySurface
        && includes(
            DIAGNOSTIC_BRIDGE_LEGACY_SURFACE_IDS,
            input.legacySurface,
        )
    ) {
        appendAllowed(params, 'legacySurface', input.legacySurface);
    }
    for (const field of SELECTION_FIELDS) {
        appendBounded(params, field, input[field]);
    }
    if (
        input.transport
        && includes(DIAGNOSTIC_BRIDGE_TRANSPORTS, input.transport)
    ) {
        appendAllowed(params, 'transport', input.transport);
    }
    return `/?${params.toString()}`;
}

function appendAllowed(
    params: URLSearchParams,
    field: string,
    value: string | undefined,
): void {
    if (value !== undefined) appendIfQueryFits(params, field, value);
}

function appendBounded(
    params: URLSearchParams,
    field: string,
    value: unknown,
): void {
    if (typeof value !== 'string' || !safeValue(value)) return;
    appendIfQueryFits(params, field, value);
}

function appendIfQueryFits(
    params: URLSearchParams,
    field: string,
    value: string,
): void {
    const candidate = new URLSearchParams(params);
    candidate.set(field, value);
    if (utf8Bytes(candidate.toString()) <= DIAGNOSTIC_BRIDGE_URL_QUERY_MAX_BYTES) {
        params.set(field, value);
    }
}

function safeValue(value: string): boolean {
    return value.length > 0
        && utf8Bytes(value) <= DIAGNOSTIC_BRIDGE_URL_STRING_MAX_BYTES
        && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function includes<const Value extends string>(
    values: readonly Value[],
    value: string,
): value is Value {
    return (values as readonly string[]).includes(value);
}

function utf8Bytes(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}
