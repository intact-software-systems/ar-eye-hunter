import {
    RECIPE_CONSOLE_TRANSPORTS,
    RECIPE_CONSOLE_URL_STRING_MAX_BYTES,
    RECIPE_CONSOLE_VIEWS,
    type RecipeConsoleTransport,
    type RecipeConsoleView,
} from '../../../recipe-console/routing/url-state-contract.ts';

const ISSUE_LIMIT = 32;

const PROVIDERS = [
    'simulated',
    'browser-rallar',
] as const;

const CONTEXT_STRING_FIELDS = [
    'contextApplicationId',
    'contextWorkspaceId',
    'contextGroupId',
    'controlRunId',
    'distributedRunId',
    'agentId',
    'recipeId',
    'commandId',
] as const;

const RETURN_SELECTION_FIELDS = [
    'controlRunId',
    'distributedRunId',
    'agentId',
    'recipeId',
    'commandId',
] as const satisfies readonly (keyof LegacyDiagnosticContext)[];

const SENSITIVE_FIELDS = new Set([
    'agentsessionticket',
    'controltoken',
    'rallarpassword',
    'rallartoken',
    'accesstoken',
    'refreshtoken',
    'password',
    'token',
    'authorization',
    'apikey',
    'secret',
]);

const FORBIDDEN_CONTEXT_FIELDS = new Set([
    'controlUrl',
    'returnTo',
    'returnUrl',
    'returnPath',
    'applicationId',
    'workspaceId',
    'groupId',
    'roomId',
    'clientId',
    'principalId',
    'sourceView',
    'contextRoomId',
]);

export type LegacyDiagnosticProvider = typeof PROVIDERS[number];

export type LegacyDiagnosticContext = Readonly<{
    version: 1;
    provider?: LegacyDiagnosticProvider;
    contextApplicationId?: string;
    contextWorkspaceId?: string;
    contextGroupId?: string;
    controlRunId?: string;
    distributedRunId?: string;
    agentId?: string;
    recipeId?: string;
    commandId?: string;
    transport?: RecipeConsoleTransport;
    view?: RecipeConsoleView;
}>;

export type LegacyDiagnosticContextIssue = Readonly<{
    field: string;
    code:
        | 'unsupported'
        | 'duplicate'
        | 'malformed'
        | 'overlong'
        | 'invalid'
        | 'forbidden';
    message: string;
}>;

export type ParsedLegacyDiagnosticContext = Readonly<{
    status: 'absent' | 'unsupported' | 'invalid' | 'ready';
    context?: LegacyDiagnosticContext;
    issues: readonly LegacyDiagnosticContextIssue[];
    omittedIssueCount: number;
}>;

type MutableContext = {
    -readonly [Key in keyof LegacyDiagnosticContext]: LegacyDiagnosticContext[Key];
};

type IssueCollector = Readonly<{
    add(issue: LegacyDiagnosticContextIssue): void;
    result(): Pick<ParsedLegacyDiagnosticContext, 'issues' | 'omittedIssueCount'>;
}>;

export function parseLegacyDiagnosticContext(
    search: string,
): ParsedLegacyDiagnosticContext {
    const params = new URLSearchParams(normalizeSearch(search));
    const markerValues = params.getAll('diagnosticContext');
    if (markerValues.length === 0) {
        return {
            status: 'absent',
            issues: [],
            omittedIssueCount: 0,
        };
    }

    const collector = createIssueCollector();
    const malformed = malformedKnownFields(search);
    if (malformed.has('diagnosticContext')) {
        collector.add(issue(
            'diagnosticContext',
            'malformed',
            'The diagnostic context marker is malformed.',
        ));
        return withIssues('invalid', undefined, collector);
    }
    if (markerValues.length !== 1) {
        collector.add(issue(
            'diagnosticContext',
            'duplicate',
            'The diagnostic context marker must appear exactly once.',
        ));
        return withIssues('invalid', undefined, collector);
    }
    if (markerValues[0] !== '1') {
        collector.add(issue(
            'diagnosticContext',
            'unsupported',
            'This diagnostic context version is not supported.',
        ));
        return withIssues('unsupported', undefined, collector);
    }

    collectForbiddenIssues(params, collector);
    const context: MutableContext = { version: 1 };
    const provider = readSingleValue(params, 'provider', malformed, collector);
    if (provider !== undefined) {
        if (includes(PROVIDERS, provider)) {
            context.provider = provider;
        } else {
            collector.add(issue(
                'provider',
                'invalid',
                'The diagnostic provider is not allow-listed.',
            ));
        }
    }
    for (const field of CONTEXT_STRING_FIELDS) {
        const value = readSingleValue(params, field, malformed, collector);
        if (value !== undefined) {
            context[field] = value;
        }
    }
    const transport = readSingleValue(params, 'transport', malformed, collector);
    if (transport !== undefined) {
        if (includes(RECIPE_CONSOLE_TRANSPORTS, transport)) {
            context.transport = transport;
        } else {
            collector.add(issue(
                'transport',
                'invalid',
                'The diagnostic transport is not supported.',
            ));
        }
    }
    const view = readSingleValue(params, 'view', malformed, collector);
    if (view !== undefined) {
        if (includes(RECIPE_CONSOLE_VIEWS, view)) {
            context.view = view;
        } else {
            collector.add(issue(
                'view',
                'invalid',
                'The source Recipe Console view is not supported.',
            ));
        }
    }

    return withIssues('ready', context, collector);
}

export function buildLegacyDiagnosticReturnHref(
    context: LegacyDiagnosticContext | undefined,
): string | undefined {
    if (
        context?.version !== 1 ||
        !context.view ||
        !includes(RECIPE_CONSOLE_VIEWS, context.view)
    ) {
        return undefined;
    }
    if (context.provider && !includes(PROVIDERS, context.provider)) {
        return undefined;
    }

    const params = new URLSearchParams();
    if (context.provider) {
        params.set('provider', context.provider);
    }
    params.set('v', '1');
    params.set('experience', 'recipe-console');
    params.set('view', context.view);
    for (const field of RETURN_SELECTION_FIELDS) {
        const value = context[field];
        if (typeof value === 'string' && isSafeValue(value)) {
            params.set(field, value);
        }
    }
    if (
        context.transport &&
        includes(RECIPE_CONSOLE_TRANSPORTS, context.transport)
    ) {
        params.set('transport', context.transport);
    }
    return `/?${params.toString()}`;
}

function readSingleValue(
    params: URLSearchParams,
    field: string,
    malformed: ReadonlySet<string>,
    collector: IssueCollector,
): string | undefined {
    if (malformed.has(field)) {
        collector.add(issue(
            field,
            'malformed',
            `${field} is not valid URL-encoded text.`,
        ));
        return undefined;
    }
    const values = params.getAll(field);
    if (values.length === 0) {
        return undefined;
    }
    if (values.length !== 1) {
        collector.add(issue(
            field,
            'duplicate',
            `${field} must appear at most once.`,
        ));
        return undefined;
    }
    const value = values[0];
    if (new TextEncoder().encode(value).byteLength > RECIPE_CONSOLE_URL_STRING_MAX_BYTES) {
        collector.add(issue(
            field,
            'overlong',
            `${field} exceeds the 4,096-byte limit.`,
        ));
        return undefined;
    }
    if (!isSafeValue(value)) {
        collector.add(issue(
            field,
            'invalid',
            `${field} is empty or contains control characters.`,
        ));
        return undefined;
    }
    return value;
}

function isSafeValue(value: string): boolean {
    return value.length > 0 &&
        new TextEncoder().encode(value).byteLength <=
            RECIPE_CONSOLE_URL_STRING_MAX_BYTES &&
        !/[\u0000-\u001f\u007f]/u.test(value);
}

function collectForbiddenIssues(
    params: URLSearchParams,
    collector: IssueCollector,
): void {
    for (const field of params.keys()) {
        if (
            SENSITIVE_FIELDS.has(field.toLocaleLowerCase('en-US')) ||
            FORBIDDEN_CONTEXT_FIELDS.has(field)
        ) {
            collector.add(issue(
                field,
                'forbidden',
                `${field} is not accepted as diagnostic bridge context.`,
            ));
        }
    }
}

function malformedKnownFields(search: string): ReadonlySet<string> {
    const malformed = new Set<string>();
    const source = normalizeSearch(search);
    for (const part of source.split('&')) {
        if (!part) {
            continue;
        }
        const equals = part.indexOf('=');
        const rawField = equals >= 0 ? part.slice(0, equals) : part;
        const rawValue = equals >= 0 ? part.slice(equals + 1) : '';
        let field: string;
        try {
            field = decodeFormComponent(rawField);
        } catch {
            continue;
        }
        if (!isKnownValueField(field)) {
            continue;
        }
        try {
            decodeFormComponent(rawValue);
        } catch {
            malformed.add(field);
        }
    }
    return malformed;
}

function isKnownValueField(field: string): boolean {
    return field === 'diagnosticContext' ||
        field === 'provider' ||
        field === 'transport' ||
        field === 'view' ||
        (CONTEXT_STRING_FIELDS as readonly string[]).includes(field);
}

function decodeFormComponent(value: string): string {
    return decodeURIComponent(value.replaceAll('+', ' '));
}

function normalizeSearch(search: string): string {
    return search.startsWith('?') ? search.slice(1) : search;
}

function includes<const Value extends string>(
    values: readonly Value[],
    value: string,
): value is Value {
    return (values as readonly string[]).includes(value);
}

function issue(
    field: string,
    code: LegacyDiagnosticContextIssue['code'],
    message: string,
): LegacyDiagnosticContextIssue {
    return { field, code, message };
}

function createIssueCollector(): IssueCollector {
    const issues: LegacyDiagnosticContextIssue[] = [];
    let total = 0;
    return {
        add(next) {
            total += 1;
            if (issues.length < ISSUE_LIMIT) {
                issues.push(next);
            }
        },
        result() {
            return {
                issues,
                omittedIssueCount: Math.max(0, total - issues.length),
            };
        },
    };
}

function withIssues(
    status: ParsedLegacyDiagnosticContext['status'],
    context: LegacyDiagnosticContext | undefined,
    collector: IssueCollector,
): ParsedLegacyDiagnosticContext {
    return {
        status,
        ...(context ? { context } : {}),
        ...collector.result(),
    };
}
