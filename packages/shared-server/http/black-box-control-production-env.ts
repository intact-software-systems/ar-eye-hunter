export interface BlackBoxControlEnvironment {
    get(key: string): string | undefined;
}

export interface BlackBoxControlProductionEnvErrorDetail {
    readonly variable: string;
    readonly message: string;
}

interface RequirePresentInput {
    readonly errors: BlackBoxControlProductionEnvErrorDetail[];
    readonly environment: BlackBoxControlEnvironment;
    readonly variable: string;
    readonly message: string;
}

interface RequireAnyListInput extends RequirePresentInput {
    readonly secondaryVariable: string;
}

export class BlackBoxControlProductionEnvError extends Error {
    public override readonly name = 'BlackBoxControlProductionEnvError';

    public readonly errors: readonly BlackBoxControlProductionEnvErrorDetail[];

    public constructor(errors: readonly BlackBoxControlProductionEnvErrorDetail[]) {
        super(formatBlackBoxControlProductionEnvMessage(errors));
        this.errors = errors;
    }
}

export function isBlackBoxControlProductionHardeningEnabled(
    environment: BlackBoxControlEnvironment
): boolean {
    return isTruthy(readEnvironmentValue(environment, 'RALLAR_PRODUCTION_HARDENING'));
}

export function collectBlackBoxControlProductionEnvErrors(
    environment: BlackBoxControlEnvironment
): readonly BlackBoxControlProductionEnvErrorDetail[] {
    if (!isBlackBoxControlProductionHardeningEnabled(environment)) {
        return [];
    }

    const errors: BlackBoxControlProductionEnvErrorDetail[] = [];
    requireExactHttpsOrigins(errors, environment, 'RALLAR_BLACK_BOX_ALLOWED_ORIGINS');
    requireTruthy(errors, environment, 'RALLAR_BLACK_BOX_REQUIRE_TLS');
    requireTruthy(errors, environment, 'RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN');
    requireTruthy(errors, environment, 'RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN');
    requirePresent({
        errors,
        environment,
        variable: 'RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET',
        message: 'Operator token verification secret is required.'
    });
    requireAnyList({
        errors,
        environment,
        variable: 'RALLAR_BLACK_BOX_HTTP_ALLOWED_HOSTS',
        secondaryVariable: 'RALLAR_BLACK_BOX_HTTP_ALLOWED_ORIGINS',
        message: 'HTTP command destinations must be restricted.'
    });
    requireAnyList({
        errors,
        environment,
        variable: 'RALLAR_BLACK_BOX_WS_ALLOWED_HOSTS',
        secondaryVariable: 'RALLAR_BLACK_BOX_WS_ALLOWED_ORIGINS',
        message: 'WebSocket command destinations must be restricted.'
    });
    requirePresent({
        errors,
        environment,
        variable: 'RALLAR_BLACK_BOX_STORAGE_DIR',
        message: 'Durable artifact storage directory is required.'
    });
    requirePositiveInteger(errors, environment, 'RALLAR_BLACK_BOX_RETENTION_MAX_RUNS');
    return errors;
}

export function assertBlackBoxControlProductionEnv(
    environment: BlackBoxControlEnvironment
): void {
    const errors = collectBlackBoxControlProductionEnvErrors(environment);
    if (errors.length > 0) {
        throw new BlackBoxControlProductionEnvError(errors);
    }
}

function formatBlackBoxControlProductionEnvMessage(
    errors: readonly BlackBoxControlProductionEnvErrorDetail[]
): string {
    const details = errors
        .map((error) => `- ${error.variable}: ${error.message}`)
        .join('\n');
    return `Black-box control production environment validation failed:\n${details}`;
}

function requirePresent({
    errors,
    environment,
    variable,
    message
}: RequirePresentInput): void {
    if (!readEnvironmentValue(environment, variable)) {
        errors.push({ variable, message });
    }
}

function requireAnyList({
    errors,
    environment,
    variable,
    secondaryVariable,
    message
}: RequireAnyListInput): void {
    if (
        readList(environment, variable).length === 0 &&
        readList(environment, secondaryVariable).length === 0
    ) {
        errors.push({
            variable,
            message: `${message} Set ${variable} or ${secondaryVariable}.`
        });
    }
}

function requireTruthy(
    errors: BlackBoxControlProductionEnvErrorDetail[],
    environment: BlackBoxControlEnvironment,
    variable: string
): void {
    if (!isTruthy(readEnvironmentValue(environment, variable))) {
        errors.push({ variable, message: 'Must be enabled.' });
    }
}

function requirePositiveInteger(
    errors: BlackBoxControlProductionEnvErrorDetail[],
    environment: BlackBoxControlEnvironment,
    variable: string
): void {
    const value = readEnvironmentValue(environment, variable);
    const parsed = value ? Number.parseInt(value, 10) : NaN;
    if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
        errors.push({ variable, message: 'Must be a positive integer.' });
    }
}

function requireExactHttpsOrigins(
    errors: BlackBoxControlProductionEnvErrorDetail[],
    environment: BlackBoxControlEnvironment,
    variable: string
): void {
    const origins = readList(environment, variable);
    if (origins.length === 0) {
        errors.push({
            variable,
            message: 'At least one exact HTTPS origin is required.'
        });
        return;
    }

    if (origins.some((origin) => !isExactHttpsProductionOrigin(origin))) {
        errors.push({
            variable,
            message: 'Only exact HTTPS origins are allowed; wildcards and localhost are not allowed.'
        });
    }
}

function isExactHttpsProductionOrigin(origin: string): boolean {
    if (origin === '*') {
        return false;
    }

    try {
        const parsed = new URL(origin);
        const hostname = parsed.hostname.toLowerCase();
        return parsed.protocol === 'https:' &&
            parsed.pathname === '/' &&
            parsed.search === '' &&
            parsed.hash === '' &&
            !hostname.includes('*') &&
            hostname !== 'localhost' &&
            hostname !== '127.0.0.1' &&
            hostname !== '0.0.0.0' &&
            hostname !== '::1' &&
            !hostname.endsWith('.localhost');
    }
    catch {
        return false;
    }
}

function readEnvironmentValue(
    environment: BlackBoxControlEnvironment,
    key: string
): string | undefined {
    const value = environment.get(key)?.trim();
    return value && value.length > 0 ? value : undefined;
}

function readList(
    environment: BlackBoxControlEnvironment,
    key: string
): readonly string[] {
    return (readEnvironmentValue(environment, key) ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
}

function isTruthy(value: string | undefined): boolean {
    const normalized = value?.trim().toLowerCase();
    return normalized === '1' ||
        normalized === 'true' ||
        normalized === 'yes' ||
        normalized === 'on';
}
