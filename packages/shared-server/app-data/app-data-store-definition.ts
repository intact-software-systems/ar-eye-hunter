import { RepositoryToken } from '@shared/cache/RepositoryToken.ts';
import { assertAppDataValueCodec, type AppDataValueCodec } from './app-data-value-codec.ts';
import type { RallarServerAppDataStore } from './rallar-server-app-data-store.ts';

export type RallarServerAppDataReadConsistency = 'fresh' | 'cache-first';

export interface RallarServerAppDataStoreOptions<V> {
    readonly codec: AppDataValueCodec<V>;
    readonly namespace?: string;
    readonly keyPrefix?: string;
    readonly ttlMs?: number;
    readonly readConsistency?: RallarServerAppDataReadConsistency;
    readonly maxConflictRetries?: number;
    readonly expireAtFor?: (value: V) => number;
}

export interface RallarServerAppDataStoreDefinition<V> {
    readonly name: string;
    readonly options: RallarServerAppDataStoreOptions<V>;
}

export interface AppDataStoreConfiguration<V> {
    readonly codec: AppDataValueCodec<V>;
    readonly namespace: string;
    readonly keyPrefix: string;
    readonly readConsistency: RallarServerAppDataReadConsistency;
    readonly maxConflictRetries: number;
    readonly ttlMs?: number;
    readonly expireAtFor?: (value: V) => number;
}

export interface PreparedAppDataStore<V> {
    readonly token: RepositoryToken<RallarServerAppDataStore<V>>;
    readonly name: string;
    readonly configuration: AppDataStoreConfiguration<V>;
}

const DEFAULT_NAMESPACE = 'app';
const DEFAULT_MAX_CONFLICT_RETRIES = 5;

export function defineAppDataStore<V>(
    name: string,
    options: RallarServerAppDataStoreOptions<V>
): RallarServerAppDataStoreDefinition<V> {
    assertStoreName(name);
    normalizeAppDataStoreOptions(options);
    return { name, options };
}

export function resolveAppDataStoreDefinition<V>(
    input: string | RallarServerAppDataStoreDefinition<V>,
    options?: RallarServerAppDataStoreOptions<V>
): RallarServerAppDataStoreDefinition<V> {
    if (typeof input === 'string') {
        if (!options) {
            throw new Error('Rallar server app data store options with a codec are required.');
        }
        return defineAppDataStore(input, options);
    }
    if (options) {
        throw new Error('Rallar server app data definition options cannot be overridden when opening a store.');
    }
    return defineAppDataStore(input.name, input.options);
}

export function prepareAppDataStore<V>(
    definition: RallarServerAppDataStoreDefinition<V>
): PreparedAppDataStore<V> {
    const configuration = normalizeAppDataStoreOptions(definition.options);
    const id = toRepositoryId(definition.name, configuration);
    return {
        token: new RepositoryToken(id, () => {
            throw new Error('Rallar server app data stores are created by RallarServerAppData.');
        }),
        name: definition.name,
        configuration
    };
}

export function normalizeAppDataStoreOptions<V>(
    options: RallarServerAppDataStoreOptions<V>
): AppDataStoreConfiguration<V> {
    assertAppDataValueCodec(options.codec);
    if (
        options.ttlMs !== undefined &&
        (!Number.isFinite(options.ttlMs) || options.ttlMs < 0)
    ) {
        throw new Error('Rallar server app data ttlMs must be a non-negative finite number.');
    }

    const readConsistency = options.readConsistency ?? 'fresh';
    if (readConsistency !== 'fresh' && readConsistency !== 'cache-first') {
        throw new Error(
            'Rallar server app data readConsistency must be "fresh" or "cache-first".'
        );
    }

    const maxConflictRetries = options.maxConflictRetries ?? DEFAULT_MAX_CONFLICT_RETRIES;
    if (!Number.isInteger(maxConflictRetries) || maxConflictRetries < 0) {
        throw new Error(
            'Rallar server app data maxConflictRetries must be a non-negative integer.'
        );
    }

    const namespace = options.namespace ?? DEFAULT_NAMESPACE;
    assertNamespace(namespace);
    return {
        codec: options.codec,
        namespace,
        keyPrefix: options.keyPrefix ?? '',
        readConsistency,
        maxConflictRetries,
        ttlMs: options.ttlMs,
        expireAtFor: options.expireAtFor
    };
}

export function appDataStoreConfigurationsMatch<V>(
    left: AppDataStoreConfiguration<V>,
    right: AppDataStoreConfiguration<V>
): boolean {
    return left.codec === right.codec &&
        left.namespace === right.namespace &&
        left.keyPrefix === right.keyPrefix &&
        left.readConsistency === right.readConsistency &&
        left.maxConflictRetries === right.maxConflictRetries &&
        left.ttlMs === right.ttlMs &&
        left.expireAtFor === right.expireAtFor;
}

export function assertAppDataKey(key: string): void {
    if (!key.trim()) {
        throw new Error('Rallar server app data key is required.');
    }
}

export function toAppDataStorageKey<V>(configuration: AppDataStoreConfiguration<V>, key: string): string {
    assertAppDataKey(key);
    return `${configuration.keyPrefix}${key}`;
}

export function toAppDataPublicKey<V>(
    configuration: AppDataStoreConfiguration<V>,
    storageKey: string
): string {
    return configuration.keyPrefix && storageKey.startsWith(configuration.keyPrefix)
        ? storageKey.slice(configuration.keyPrefix.length)
        : storageKey;
}

function toRepositoryId<V>(
    name: string,
    configuration: AppDataStoreConfiguration<V>
): string {
    return [
        'rallar-server-app-data',
        encodeURIComponent(configuration.namespace),
        encodeURIComponent(name),
        encodeURIComponent(configuration.keyPrefix)
    ].join(':');
}

function assertStoreName(name: string): void {
    if (!name.trim()) {
        throw new Error('Rallar server app data store name is required.');
    }
}

function assertNamespace(namespace: string): void {
    if (!namespace.trim()) {
        throw new Error('Rallar server app data namespace is required.');
    }
}
