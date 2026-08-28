import type {
    ApiV1Configuration,
    ApiV1ConfigurationProfile,
    ApiV1HttpConfiguration
} from '@api-v1/src/configuration/api-v1-configuration.ts';
import {
    readApiV1Configuration,
    type ReadApiV1ConfigurationInput
} from '@api-v1/src/configuration/read-api-v1-configuration.ts';
import { toApiV1PublicConfiguration } from '@api-v1/src/configuration/to-api-v1-public-configuration.ts';
import type { ApiConfig } from '@shared/api/api-config.ts';

export type RelicRestAuthorizationMode = 'authenticated' | 'group-policy';

export type RelicAiExpeditionMode = 'off' | 'mock' | 'ollama';

export interface RelicAiExpeditionConfiguration {
    readonly mode: RelicAiExpeditionMode;
    readonly timeoutMs: number;
    readonly ollamaBaseUrl: string;
    readonly ollamaModel: string;
}

export interface RelicRestAuthorizationConfiguration {
    readonly mode: RelicRestAuthorizationMode;
}

export interface RelicHunterServerConfiguration {
    readonly apiV1: ApiV1Configuration;
    readonly http: ApiV1HttpConfiguration;
    readonly browser: ApiConfig;
    readonly restAuthorization: RelicRestAuthorizationConfiguration;
    readonly expeditionAi: RelicAiExpeditionConfiguration;
}

export interface ReadRelicHunterServerConfigurationInput extends ReadApiV1ConfigurationInput {
    readonly relicDefaultsUrl: URL;
    readonly relicProfileUrls: Readonly<Partial<Record<ApiV1ConfigurationProfile['name'], URL>>>;
}

interface RelicHunterServerEnvironmentSource {
    readonly restAuthorizationMode: string | undefined;
    readonly expeditionAiMode: string | undefined;
    readonly expeditionAiTimeoutMs: string | undefined;
    readonly expeditionAiOllamaBaseUrl: string | undefined;
    readonly expeditionAiOllamaModel: string | undefined;
}

type JsonPrimitive = boolean | number | string | null;

interface JsonObject {
    readonly [key: string]: JsonValue;
}

type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export const RELIC_AI_EXPEDITION_DEFAULT_CONFIGURATION: RelicAiExpeditionConfiguration = Object.freeze({
    mode: 'off',
    timeoutMs: 15_000,
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'llama-test'
});

export async function readRelicHunterServerConfiguration(
    input: ReadRelicHunterServerConfigurationInput
): Promise<RelicHunterServerConfiguration> {
    const apiV1 = await readApiV1Configuration(input);
    const source = readRelicHunterServerEnvironmentSource(input.environment);
    const restAuthorization = await readRelicRestAuthorization(input, apiV1.profile.name, source);
    const expeditionAi = decodeRelicAiExpeditionConfiguration(source);
    if (apiV1.profile.productionHardening && restAuthorization.mode !== 'group-policy') {
        throw new Error(
            'RELIC_REST_AUTH_MODE must be group-policy when production hardening is enabled.'
        );
    }

    const configuration: RelicHunterServerConfiguration = {
        apiV1,
        http: apiV1.http,
        browser: toApiV1PublicConfiguration(apiV1.publicApi),
        restAuthorization,
        expeditionAi
    };
    recursivelyFreeze(configuration);
    return configuration;
}

async function readRelicRestAuthorization(
    input: ReadRelicHunterServerConfigurationInput,
    profileName: ApiV1ConfigurationProfile['name'],
    environment: RelicHunterServerEnvironmentSource
): Promise<RelicRestAuthorizationConfiguration> {
    const defaultsMode = await readRelicRestAuthorizationMode(
        input,
        input.relicDefaultsUrl,
        'Relic defaults'
    );
    const profileUrl = input.relicProfileUrls[profileName];
    const profileMode = profileUrl === undefined
        ? undefined
        : await readRelicRestAuthorizationMode(input, profileUrl, `Relic ${profileName} profile`);
    return decodeRelicRestAuthorization(
        environment.restAuthorizationMode ?? profileMode ?? defaultsMode,
        environment.restAuthorizationMode === undefined
            ? 'restAuthorization.mode'
            : 'RELIC_REST_AUTH_MODE'
    );
}

async function readRelicRestAuthorizationMode(
    input: ReadRelicHunterServerConfigurationInput,
    url: URL,
    resourceName: string
): Promise<string> {
    let value: JsonValue;
    try {
        value = JSON.parse(await input.readTextFile(url)) as JsonValue;
    }
    catch {
        throw new Error(`${resourceName} configuration must be readable JSON.`);
    }
    if (!isObject(value) || !hasOnlyKeys(value, ['restAuthorization'])) {
        throw new Error(`${resourceName} configuration must contain only restAuthorization.`);
    }
    const restAuthorization = value.restAuthorization;
    if (
        !isObject(restAuthorization) ||
        !hasOnlyKeys(restAuthorization, ['mode']) ||
        typeof restAuthorization.mode !== 'string'
    ) {
        throw new Error(`${resourceName} restAuthorization must contain one string mode.`);
    }
    return restAuthorization.mode;
}

function readRelicHunterServerEnvironmentSource(
    environment: ReadApiV1ConfigurationInput['environment']
): RelicHunterServerEnvironmentSource {
    return {
        restAuthorizationMode: environment.get('RELIC_REST_AUTH_MODE'),
        expeditionAiMode: environment.get('RELIC_AI_EXPEDITION_MODE'),
        expeditionAiTimeoutMs: environment.get('RELIC_AI_EXPEDITION_TIMEOUT_MS'),
        expeditionAiOllamaBaseUrl: environment.get('RELIC_AI_EXPEDITION_OLLAMA_BASE_URL'),
        expeditionAiOllamaModel: environment.get('RELIC_AI_EXPEDITION_OLLAMA_MODEL')
    };
}

function decodeRelicRestAuthorization(
    rawMode: string,
    sourceName: string
): RelicRestAuthorizationConfiguration {
    if (rawMode === 'authenticated') {
        return { mode: 'authenticated' };
    }
    if (rawMode === 'group-policy') {
        return { mode: 'group-policy' };
    }
    throw new Error(`${sourceName} must be exactly authenticated or group-policy.`);
}

function decodeRelicAiExpeditionConfiguration(
    source: RelicHunterServerEnvironmentSource
): RelicAiExpeditionConfiguration {
    return {
        mode: decodeRelicAiExpeditionMode(source.expeditionAiMode),
        timeoutMs: decodeRelicAiExpeditionTimeoutMs(source.expeditionAiTimeoutMs),
        ollamaBaseUrl: decodeRelicAiExpeditionOllamaBaseUrl(
            source.expeditionAiOllamaBaseUrl
        ),
        ollamaModel: decodeRelicAiExpeditionOllamaModel(source.expeditionAiOllamaModel)
    };
}

function decodeRelicAiExpeditionMode(rawMode: string | undefined): RelicAiExpeditionMode {
    if (rawMode === undefined) {
        return 'off';
    }
    if (rawMode === 'off' || rawMode === 'mock' || rawMode === 'ollama') {
        return rawMode;
    }
    throw new Error('RELIC_AI_EXPEDITION_MODE must be exactly off, mock, or ollama.');
}

function decodeRelicAiExpeditionTimeoutMs(rawTimeoutMs: string | undefined): number {
    if (rawTimeoutMs === undefined) {
        return RELIC_AI_EXPEDITION_DEFAULT_CONFIGURATION.timeoutMs;
    }
    const timeoutMs = Number(rawTimeoutMs);
    if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0 ||
        String(timeoutMs) !== rawTimeoutMs
    ) {
        throw new Error('RELIC_AI_EXPEDITION_TIMEOUT_MS must be a canonical positive integer.');
    }
    return timeoutMs;
}

function decodeRelicAiExpeditionOllamaBaseUrl(rawBaseUrl: string | undefined): string {
    const baseUrl = rawBaseUrl ?? RELIC_AI_EXPEDITION_DEFAULT_CONFIGURATION.ollamaBaseUrl;
    let parsed: URL;
    try {
        parsed = new URL(baseUrl);
    }
    catch {
        throw new Error('RELIC_AI_EXPEDITION_OLLAMA_BASE_URL must be an HTTP(S) URL.');
    }
    if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        parsed.username.length > 0 ||
        parsed.password.length > 0
    ) {
        throw new Error(
            'RELIC_AI_EXPEDITION_OLLAMA_BASE_URL must be an HTTP(S) URL without credentials.'
        );
    }
    return baseUrl;
}

function decodeRelicAiExpeditionOllamaModel(rawModel: string | undefined): string {
    if (rawModel === undefined) {
        return RELIC_AI_EXPEDITION_DEFAULT_CONFIGURATION.ollamaModel;
    }
    if (rawModel.length === 0 || rawModel.trim() !== rawModel) {
        throw new Error('RELIC_AI_EXPEDITION_OLLAMA_MODEL must be a non-empty exact value.');
    }
    return rawModel;
}

function recursivelyFreeze(value: object): void {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        const child = descriptor.value;
        if (typeof child === 'object' && child !== null && !Object.isFrozen(child)) {
            recursivelyFreeze(child);
        }
    }
    Object.freeze(value);
}

function hasOnlyKeys(value: JsonObject, expectedKeys: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expectedKeys.length && keys.every((key) => expectedKeys.includes(key));
}

function isObject(value: JsonValue): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
