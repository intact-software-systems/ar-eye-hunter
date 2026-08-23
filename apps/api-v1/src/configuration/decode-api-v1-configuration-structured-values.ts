import type { ApiV1ConfigurationIssue, ApiV1ConfigurationIssueSource } from './api-v1-configuration-error.ts';
import type { ApiV1AuthenticationConfiguration } from './api-v1-configuration.ts';
import type {
    ApiV1ConfigurationResolvedSourceValue,
    ApiV1ConfigurationSourceObject,
    ApiV1ConfigurationSourceValue
} from './decode-api-v1-configuration-source.ts';

export interface ApiV1ConfigurationStructuredValueAccess {
    addIssue(issue: ApiV1ConfigurationIssue): void;
    readResolvedSourceValue(path: string): ApiV1ConfigurationResolvedSourceValue;
    reportMissingValue(path: string): void;
    reportInvalidSourceValue(
        sourceValue: ApiV1ConfigurationResolvedSourceValue,
        path: string,
        code: string,
        message: string
    ): void;
}

export class ApiV1ConfigurationStructuredValueDecoder {
    readonly #values: ApiV1ConfigurationStructuredValueAccess;

    constructor(values: ApiV1ConfigurationStructuredValueAccess) {
        this.#values = values;
    }

    originSet(path: string): readonly string[] {
        const sourceValue = this.#values.readResolvedSourceValue(path);
        if (sourceValue.blocked) {
            return [];
        }
        if (!sourceValue.found) {
            this.#values.reportMissingValue(path);
            return [];
        }
        if (!Array.isArray(sourceValue.value) || sourceValue.value.length === 0) {
            this.#values.reportInvalidSourceValue(
                sourceValue,
                path,
                'invalid-origin-set',
                'Value must be a non-empty array of exact HTTP origins.'
            );
            return [];
        }
        const origins: string[] = [];
        for (const [index, originValue] of sourceValue.value.entries()) {
            if (typeof originValue !== 'string' || !isExactHttpOrigin(originValue)) {
                this.#values.reportInvalidSourceValue(
                    sourceValue,
                    `${path}.${index}`,
                    'invalid-origin',
                    'Origin must be * or an exact HTTP or HTTPS origin.'
                );
                continue;
            }
            origins.push(originValue);
        }
        if (new Set(origins).size !== origins.length) {
            this.#values.reportInvalidSourceValue(
                sourceValue,
                path,
                'duplicate-origin',
                'Origins must not contain duplicates.'
            );
        }
        return [...origins].sort();
    }

    stringSet(
        path: string,
        sourceOverride?: ApiV1ConfigurationSourceValue,
        sourceOverrideName?: ApiV1ConfigurationIssueSource
    ): readonly string[] {
        const sourceValue = sourceOverrideName === undefined
            ? this.#values.readResolvedSourceValue(path)
            : {
                found: true,
                blocked: false,
                value: sourceOverride,
                source: sourceOverrideName === 'environment' ? 'environment' : 'defaults'
            } satisfies ApiV1ConfigurationResolvedSourceValue;
        if (sourceValue.blocked) {
            return [];
        }
        if (!sourceValue.found) {
            this.#values.reportMissingValue(path);
            return [];
        }
        if (!Array.isArray(sourceValue.value)) {
            this.#values.reportInvalidSourceValue(
                sourceValue,
                path,
                'invalid-string-set',
                'Value must be an array of non-empty strings.'
            );
            return [];
        }
        const values: string[] = [];
        for (const [index, value] of sourceValue.value.entries()) {
            if (
                typeof value !== 'string' ||
                value.length === 0 ||
                value.trim() !== value
            ) {
                this.#values.reportInvalidSourceValue(
                    sourceValue,
                    `${path}.${index}`,
                    'invalid-string',
                    'Set entries must be non-empty strings without surrounding whitespace.'
                );
                continue;
            }
            values.push(value);
        }
        if (new Set(values).size !== values.length) {
            this.#values.reportInvalidSourceValue(
                sourceValue,
                path,
                'duplicate-value',
                'Set-like values must not contain duplicates.'
            );
        }
        return [...values].sort();
    }

    staticClients(
        source: ApiV1ConfigurationSourceValue | undefined,
        enabled: boolean
    ): ApiV1AuthenticationConfiguration['staticClients'] {
        if (!enabled) {
            return [];
        }
        if (!Array.isArray(source)) {
            this.#values.addIssue({
                source: 'defaults',
                path: 'authentication.staticClients',
                code: 'invalid-static-clients',
                message: 'Static clients resource must be an array.'
            });
            return [];
        }
        const clients: Array<{ clientId: string; username: string; password: string; }> = [];
        for (const [index, value] of source.entries()) {
            const path = `authentication.staticClients.${index}`;
            if (!isSourceRecord(value)) {
                this.#values.addIssue({
                    source: 'defaults',
                    path,
                    code: 'invalid-static-client',
                    message: 'Static client must be an object.'
                });
                continue;
            }
            this.#rejectUnknownStaticClientFields(value, path);
            const clientId = this.#staticClientString(value.clientId, `${path}.clientId`);
            const username = this.#staticClientString(value.username, `${path}.username`);
            const password = this.#staticClientString(value.password, `${path}.password`);
            clients.push({ clientId, username, password });
        }
        this.#rejectDuplicateClientField(clients, 'clientId');
        this.#rejectDuplicateClientField(clients, 'username');
        return clients;
    }

    #rejectUnknownStaticClientFields(
        value: ApiV1ConfigurationSourceObject,
        path: string
    ): void {
        for (const key of Object.keys(value)) {
            if (!['clientId', 'username', 'password'].includes(key)) {
                this.#values.addIssue({
                    source: 'defaults',
                    path: `${path}.${key}`,
                    code: 'unknown-property',
                    message: 'Static client contains an unknown property.'
                });
            }
        }
    }

    #staticClientString(
        value: ApiV1ConfigurationSourceValue | undefined,
        path: string
    ): string {
        if (
            typeof value === 'string' &&
            value.length > 0 &&
            value.trim() === value
        ) {
            return value;
        }
        this.#values.addIssue({
            source: 'defaults',
            path,
            code: 'invalid-static-client-field',
            message: 'Static client field must be a non-empty string without surrounding whitespace.'
        });
        return '';
    }

    #rejectDuplicateClientField(
        clients: readonly Readonly<{
            clientId: string;
            username: string;
            password: string;
        }>[],
        field: 'clientId' | 'username'
    ): void {
        const values = clients.map((client) => client[field]);
        if (new Set(values).size !== values.length) {
            this.#values.addIssue({
                source: 'defaults',
                path: `authentication.staticClients.${field}`,
                code: 'duplicate-static-client',
                message: `Static client ${field} values must be unique.`
            });
        }
    }
}

function isExactHttpOrigin(value: string): boolean {
    if (value === '*') {
        return true;
    }
    try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') &&
            url.origin === value &&
            url.username.length === 0 &&
            url.password.length === 0;
    }
    catch {
        return false;
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
