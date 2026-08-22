import { buildDiagnosticBridgeReturnHref } from '../../app/diagnostic-bridge-return-href.ts';
import {
    DIAGNOSTIC_BRIDGE_PROVIDERS,
    DIAGNOSTIC_BRIDGE_URL_QUERY_MAX_BYTES,
    DIAGNOSTIC_BRIDGE_URL_STRING_MAX_BYTES
} from '../../app/diagnostic-bridge-url-contract.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { RECIPE_CONSOLE_TRANSPORTS, RECIPE_CONSOLE_VIEWS } from '../routing/url-state-contract.ts';
import { resolveAdvancedSurface } from './advanced-surface-catalog.ts';

export const ADVANCED_DIAGNOSTIC_CONTEXT_MAX_BYTES = DIAGNOSTIC_BRIDGE_URL_STRING_MAX_BYTES;
export const ADVANCED_DIAGNOSTIC_QUERY_MAX_BYTES = DIAGNOSTIC_BRIDGE_URL_QUERY_MAX_BYTES;

const RUN_CONTEXT_FIELDS = [
    'controlRunId',
    'distributedRunId',
    'agentId',
    'recipeId',
    'commandId'
] as const satisfies readonly (keyof RecipeConsoleUrlState)[];
const SOURCE_CONTEXT_FIELDS = [
    ['applicationId', 'contextApplicationId'],
    ['workspaceId', 'contextWorkspaceId'],
    ['groupId', 'contextGroupId']
] as const;

export type CreateAdvancedLegacyHrefInput = Readonly<{
    surface: string;
    state: RecipeConsoleUrlState;
    sourceSearch?: string;
}>;

export function createAdvancedLegacyHref({
    surface: surfaceValue,
    state,
    sourceSearch = ''
}: CreateAdvancedLegacyHrefInput): string | undefined {
    const surface = resolveAdvancedSurface(surfaceValue);
    if (!surface) {
        return undefined;
    }

    const params = new URLSearchParams();
    params.set('experience', 'legacy');
    params.set('workspace', surface.route.workspace);
    params.set('tab', surface.route.tab);
    if ('advancedSurface' in surface.route) {
        params.set('advancedSurface', surface.route.advancedSurface);
    }
    params.set('legacySurface', surface.id);
    params.set('diagnosticContext', '1');
    params.set('view', allowedValue(state.view, RECIPE_CONSOLE_VIEWS) ?? 'advanced');

    const source = new URLSearchParams(sourceSearch);
    appendAllowed(
        params,
        'provider',
        singleAllowedParam(
            source,
            'provider',
            DIAGNOSTIC_BRIDGE_PROVIDERS
        )
    );
    for (const field of RUN_CONTEXT_FIELDS) {
        appendBounded(params, field, state[field]);
    }
    appendAllowed(
        params,
        'transport',
        allowedValue(state.transport, RECIPE_CONSOLE_TRANSPORTS)
    );
    for (const [sourceField, targetField] of SOURCE_CONTEXT_FIELDS) {
        appendBounded(params, targetField, singleParam(source, sourceField));
    }

    return `/?${params.toString()}`;
}

export function createAdvancedRecipeConsoleReturnHref(
    search: string | URLSearchParams
): string {
    const source = search instanceof URLSearchParams
        ? search
        : new URLSearchParams(search);
    if (singleParam(source, 'diagnosticContext') !== '1') {
        return genericAdvancedHref();
    }

    const view = singleAllowedParam(source, 'view', RECIPE_CONSOLE_VIEWS) ??
        'advanced';
    return buildDiagnosticBridgeReturnHref({
        version: 1,
        provider: singleAllowedParam(
            source,
            'provider',
            DIAGNOSTIC_BRIDGE_PROVIDERS
        ),
        view,
        controlRunId: boundedContextValue(singleParam(source, 'controlRunId')),
        distributedRunId: boundedContextValue(singleParam(
            source,
            'distributedRunId'
        )),
        agentId: boundedContextValue(singleParam(source, 'agentId')),
        recipeId: boundedContextValue(singleParam(source, 'recipeId')),
        commandId: boundedContextValue(singleParam(source, 'commandId')),
        transport: singleAllowedParam(
            source,
            'transport',
            RECIPE_CONSOLE_TRANSPORTS
        ),
        legacySurface: view === 'advanced'
            ? resolveAdvancedSurface(singleParam(source, 'legacySurface'))?.id
            : undefined
    }) ?? genericAdvancedHref();
}

function genericAdvancedHref(): string {
    return '/?v=1&experience=recipe-console&view=advanced';
}

function appendAllowed<const Value extends string>(
    params: URLSearchParams,
    field: string,
    value: Value | undefined
): void {
    if (value !== undefined) {
        appendIfQueryFits(params, field, value);
    }
}

function appendBounded(
    params: URLSearchParams,
    field: string,
    value: unknown
): void {
    const normalized = boundedContextValue(value);
    if (normalized !== undefined) {
        appendIfQueryFits(params, field, normalized);
    }
}

function appendIfQueryFits(
    params: URLSearchParams,
    field: string,
    value: string
): void {
    const candidate = new URLSearchParams(params);
    candidate.set(field, value);
    if (utf8Bytes(candidate.toString()) <= ADVANCED_DIAGNOSTIC_QUERY_MAX_BYTES) {
        params.set(field, value);
    }
}

function boundedContextValue(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const normalized = value.trim();
    if (
        !normalized ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(normalized) ||
        utf8Bytes(normalized) > ADVANCED_DIAGNOSTIC_CONTEXT_MAX_BYTES
    ) {
        return undefined;
    }
    return normalized;
}

function singleParam(
    params: URLSearchParams,
    field: string
): string | undefined {
    const values = params.getAll(field);
    return values.length === 1 ? values[0] : undefined;
}

function singleAllowedParam<const Value extends string>(
    params: URLSearchParams,
    field: string,
    allowed: readonly Value[]
): Value | undefined {
    return allowedValue(singleParam(params, field), allowed);
}

function allowedValue<const Value extends string>(
    value: unknown,
    allowed: readonly Value[]
): Value | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const normalized = value.trim();
    return (allowed as readonly string[]).includes(normalized)
        ? normalized as Value
        : undefined;
}

function utf8Bytes(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}
