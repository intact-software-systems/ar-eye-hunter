import { ApiV1ConfigurationError, type ApiV1ConfigurationIssue } from './api-v1-configuration-error.ts';
import type { ApiV1ConfigurationProfile } from './api-v1-configuration.ts';
import {
    apiV1ConfigurationEnvironmentName,
    readApiV1ConfigurationSourcePath,
    type ApiV1ConfigurationResolvedSourceValue,
    type ApiV1ConfigurationSource,
    type ApiV1ConfigurationSourceObject,
    type ApiV1ConfigurationSourceValue
} from './decode-api-v1-configuration-source.ts';
import type { ApiV1ConfigurationInvariantCollector } from './validate-api-v1-configuration-invariants.ts';

export interface ApiV1ConfigurationSecrets {
    readonly authenticationCredentialSecret: string | undefined;
    readonly blackBoxOperatorTokenSecret: string | undefined;
    readonly databaseUrl: string | undefined;
    readonly meteredApiKey: string | undefined;
}

const SECRET_ENVIRONMENT_NAME_BY_KEY = {
    authenticationCredentialSecret: 'RALLAR_AUTH_CREDENTIAL_SECRET',
    blackBoxOperatorTokenSecret: 'RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET',
    databaseUrl: 'DATABASE_URL',
    meteredApiKey: 'METERED_API_KEY'
} as const;

const SECRET_PATH_BY_KEY = {
    authenticationCredentialSecret: 'authentication.credentialSecret',
    blackBoxOperatorTokenSecret: 'blackBox.operatorToken.secret',
    databaseUrl: 'database.url',
    meteredApiKey: 'ice.apiKey'
} as const;

export function readApiV1ConfigurationSecrets(
    source: ApiV1ConfigurationSourceValue | undefined,
    decoder: ApiV1ConfigurationValueDecoder
): ApiV1ConfigurationSecrets {
    const keys = new Set(Object.keys(SECRET_ENVIRONMENT_NAME_BY_KEY));
    if (!isSourceRecord(source)) {
        decoder.secretIssue(
            'authenticationCredentialSecret',
            'invalid-secret-source',
            'Secret source must be an object.'
        );
        return {
            authenticationCredentialSecret: undefined,
            blackBoxOperatorTokenSecret: undefined,
            databaseUrl: undefined,
            meteredApiKey: undefined
        };
    }
    for (const key of Object.keys(source)) {
        if (!keys.has(key)) {
            decoder.addIssue({
                source: 'secret',
                path: key,
                code: 'unknown-secret',
                message: 'Secret source contains an unknown property.'
            });
        }
    }
    return {
        authenticationCredentialSecret: decoder.optionalSecret(
            'authenticationCredentialSecret',
            source.authenticationCredentialSecret
        ),
        blackBoxOperatorTokenSecret: decoder.optionalSecret(
            'blackBoxOperatorTokenSecret',
            source.blackBoxOperatorTokenSecret
        ),
        databaseUrl: decoder.optionalSecret('databaseUrl', source.databaseUrl),
        meteredApiKey: decoder.optionalSecret('meteredApiKey', source.meteredApiKey)
    };
}

export class ApiV1ConfigurationValueDecoder implements ApiV1ConfigurationInvariantCollector {
    readonly #sources: readonly ApiV1ConfigurationSource[];
    readonly #issues: ApiV1ConfigurationIssue[];
    readonly #invalidPaths = new Set<string>();

    constructor(
        sources: readonly ApiV1ConfigurationSource[],
        initialIssues: readonly ApiV1ConfigurationIssue[]
    ) {
        this.#sources = sources;
        this.#issues = [...initialIssues];
    }

    addIssue(issue: ApiV1ConfigurationIssue): void {
        this.#issues.push(issue);
    }

    profileName(
        value: ApiV1ConfigurationSourceValue | undefined
    ): ApiV1ConfigurationProfile['name'] {
        if (value === 'dev' || value === 'prod' || value === 'prod-in-memory') {
            return value;
        }
        this.#issues.push({
            source: 'profile',
            path: 'profile.name',
            environmentName: 'RALLAR_API_CONFIGURATION_PROFILE',
            code: 'invalid-profile',
            message: 'Profile name must be dev, prod, or prod-in-memory.'
        });
        return 'dev';
    }

    boolean(path: string): boolean {
        const sourceValue = this.readResolvedSourceValue(path);
        if (sourceValue.blocked) {
            return false;
        }
        if (!sourceValue.found) {
            this.reportMissingValue(path);
            return false;
        }
        if (typeof sourceValue.value !== 'boolean') {
            this.reportInvalidSourceValue(
                sourceValue,
                path,
                'invalid-boolean',
                'Value must be a boolean.'
            );
            return false;
        }
        return sourceValue.value;
    }

    enumeration<const T extends readonly string[]>(path: string, values: T): T[number] {
        const sourceValue = this.readResolvedSourceValue(path);
        if (sourceValue.blocked) {
            return values[0];
        }
        if (!sourceValue.found) {
            this.reportMissingValue(path);
            return values[0];
        }
        if (
            typeof sourceValue.value !== 'string' ||
            !values.includes(sourceValue.value)
        ) {
            this.reportInvalidSourceValue(
                sourceValue,
                path,
                'invalid-enum',
                `Value must be one of ${values.join(', ')}.`
            );
            return values[0];
        }
        return sourceValue.value as T[number];
    }

    integer(path: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
        const sourceValue = this.readResolvedSourceValue(path);
        if (sourceValue.blocked) {
            return minimum;
        }
        if (!sourceValue.found) {
            this.reportMissingValue(path);
            return minimum;
        }
        const value = sourceValue.value;
        if (
            typeof value !== 'number' ||
            !Number.isSafeInteger(value) ||
            value < minimum ||
            value > maximum
        ) {
            this.reportInvalidSourceValue(
                sourceValue,
                path,
                'invalid-integer',
                maximum === Number.MAX_SAFE_INTEGER
                    ? `Value must be a safe integer greater than or equal to ${minimum}.`
                    : `Value must be a safe integer from ${minimum} through ${maximum}.`
            );
            return minimum;
        }
        return value;
    }

    ratio(path: string): number {
        const sourceValue = this.readResolvedSourceValue(path);
        if (sourceValue.blocked) {
            return 0;
        }
        if (!sourceValue.found) {
            this.reportMissingValue(path);
            return 0;
        }
        const value = sourceValue.value;
        if (
            typeof value !== 'number' ||
            !Number.isFinite(value) ||
            value < 0 ||
            value > 1
        ) {
            this.reportInvalidSourceValue(
                sourceValue,
                path,
                'invalid-ratio',
                'Value must be a finite number from 0 through 1.'
            );
            return 0;
        }
        return value;
    }

    nonEmptyString(path: string): string {
        const sourceValue = this.readResolvedSourceValue(path);
        if (sourceValue.blocked) {
            return '';
        }
        if (!sourceValue.found) {
            this.reportMissingValue(path);
            return '';
        }
        if (
            typeof sourceValue.value !== 'string' ||
            sourceValue.value.length === 0 ||
            sourceValue.value.trim() !== sourceValue.value
        ) {
            this.reportInvalidSourceValue(
                sourceValue,
                path,
                'invalid-string',
                'Value must be a non-empty string without surrounding whitespace.'
            );
            return '';
        }
        return sourceValue.value;
    }

    sourceValue(path: string): ApiV1ConfigurationSourceValue | undefined {
        const sourceValue = this.readResolvedSourceValue(path);
        if (sourceValue.blocked) {
            return undefined;
        }
        if (!sourceValue.found) {
            this.reportMissingValue(path);
            return undefined;
        }
        return sourceValue.value;
    }

    optionalSecret(
        key: keyof typeof SECRET_ENVIRONMENT_NAME_BY_KEY,
        value: ApiV1ConfigurationSourceValue | undefined
    ): string | undefined {
        if (value === undefined) {
            return undefined;
        }
        if (typeof value !== 'string' || value.trim().length === 0) {
            this.secretIssue(key, 'invalid-secret', 'Secret must be a non-empty string.');
            return undefined;
        }
        return value;
    }

    requireSecret(
        key: keyof typeof SECRET_ENVIRONMENT_NAME_BY_KEY,
        value: string | undefined
    ): string {
        if (value !== undefined) {
            return value;
        }
        this.secretIssue(key, 'missing-secret', 'Required secret is missing.');
        return '';
    }

    secretIssue(
        key: keyof typeof SECRET_ENVIRONMENT_NAME_BY_KEY,
        code: string,
        message: string
    ): void {
        this.#issues.push({
            source: 'secret',
            path: SECRET_PATH_BY_KEY[key],
            environmentName: SECRET_ENVIRONMENT_NAME_BY_KEY[key],
            code,
            message
        });
    }

    sourceIssue(path: string, code: string, message: string): void {
        const sourceValue = this.readResolvedSourceValue(path);
        const source = sourceValue.found ? sourceValue.source : 'defaults';
        this.#issues.push({
            source,
            path,
            environmentName: source === 'environment'
                ? apiV1ConfigurationEnvironmentName(path)
                : undefined,
            code,
            message
        });
    }

    invariant(path: string, code: string, message: string): void {
        this.#issues.push({
            source: 'invariant',
            path,
            environmentName: apiV1ConfigurationEnvironmentName(path),
            code,
            message
        });
    }

    hasValue(path: string): boolean {
        const sourceValue = this.readResolvedSourceValue(path);
        return sourceValue.found && !sourceValue.blocked;
    }

    hasExplicitOverlay(path: string): boolean {
        return this.#sources
            .filter((source) => source.name !== 'defaults')
            .some((source) => readApiV1ConfigurationSourcePath(source.value, path).found);
    }

    isValid(...paths: readonly string[]): boolean {
        return paths.every((path) => !this.#invalidPaths.has(path));
    }

    throwIfIssues(): void {
        if (this.#issues.length > 0) {
            throw new ApiV1ConfigurationError(this.#issues);
        }
    }

    readResolvedSourceValue(path: string): ApiV1ConfigurationResolvedSourceValue {
        let result: ApiV1ConfigurationResolvedSourceValue = {
            found: false,
            blocked: false,
            value: undefined,
            source: 'defaults'
        };
        for (const source of this.#sources) {
            const candidate = readApiV1ConfigurationSourcePath(source.value, path);
            if (candidate.found) {
                result = {
                    found: true,
                    blocked: candidate.blocked,
                    value: candidate.value,
                    source: source.name
                };
            }
        }
        return result;
    }

    reportMissingValue(path: string): void {
        this.#invalidPaths.add(path);
        this.#issues.push({
            source: 'defaults',
            path,
            code: 'missing-property',
            message: 'Required configuration property is missing.'
        });
    }

    reportInvalidSourceValue(
        sourceValue: ApiV1ConfigurationResolvedSourceValue,
        path: string,
        code: string,
        message: string
    ): void {
        this.#invalidPaths.add(path);
        this.#issues.push({
            source: sourceValue.source,
            path,
            environmentName: sourceValue.source === 'environment'
                ? apiV1ConfigurationEnvironmentName(path)
                : undefined,
            code,
            message
        });
    }
}

function isSourceRecord(
    value: ApiV1ConfigurationSourceValue | undefined
): value is ApiV1ConfigurationSourceObject {
    return typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype;
}
