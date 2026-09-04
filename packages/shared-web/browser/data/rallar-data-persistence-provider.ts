import type { PersistenceProvider, PersistenceSetItemOptions } from '@shared/persistence/PersistenceProvider.ts';

export type RallarDataStorageValue = object | string | number | boolean | null;

type RallarDataPersistedEnvelope = Readonly<{
    kind: 'rallar.custom-data';
    value: RallarDataStorageValue;
}>;

const RALLAR_DATA_ENVELOPE_KIND = 'rallar.custom-data';

/** Owns the one current persisted envelope. */
export class RallarDataPersistenceProvider<V> implements PersistenceProvider<string, V> {
    private readonly inner: PersistenceProvider<string, RallarDataStorageValue>;

    public constructor(inner: PersistenceProvider<string, RallarDataStorageValue>) {
        this.inner = inner;
    }

    public async getItem(key: string): Promise<V | undefined> {
        const persisted = await this.inner.getItem(key);
        if (persisted === undefined) {
            return undefined;
        }
        return this.toValue(persisted);
    }

    public async setItem(
        key: string,
        value: V,
        options: PersistenceSetItemOptions
    ): Promise<void> {
        await this.inner.setItem(
            key,
            {
                kind: RALLAR_DATA_ENVELOPE_KIND,
                value: value as RallarDataStorageValue
            } satisfies RallarDataPersistedEnvelope,
            options
        );
    }

    public async removeItem(key: string): Promise<void> {
        await this.inner.removeItem(key);
    }

    public async getAllKeys(): Promise<string[]> {
        return await this.inner.getAllKeys();
    }

    public async deleteExpired(): Promise<number> {
        return await this.inner.deleteExpired();
    }

    private toValue(persisted: RallarDataStorageValue): V {
        return decodeRallarDataEnvelope(persisted).value as V;
    }
}

function decodeRallarDataEnvelope(
    value: RallarDataStorageValue
): RallarDataPersistedEnvelope {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Rallar data persisted value does not match the current schema');
    }
    const ownKeys = Reflect.ownKeys(value);
    const kind = Object.getOwnPropertyDescriptor(value, 'kind');
    const persistedValue = Object.getOwnPropertyDescriptor(value, 'value');
    if (
        ownKeys.length !== 2 ||
        !ownKeys.includes('kind') ||
        !ownKeys.includes('value') ||
        kind?.value !== RALLAR_DATA_ENVELOPE_KIND ||
        !persistedValue ||
        !('value' in persistedValue) ||
        !isRallarDataStorageValue(persistedValue.value)
    ) {
        throw new TypeError('Rallar data persisted value does not match the current schema');
    }
    return {
        kind: RALLAR_DATA_ENVELOPE_KIND,
        value: persistedValue.value
    };
}

function isRallarDataStorageValue(value: unknown): value is RallarDataStorageValue {
    return value === null ||
        typeof value === 'object' ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean';
}
