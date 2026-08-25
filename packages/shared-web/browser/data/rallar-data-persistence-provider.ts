import type { RallarDataMigration, RallarDataMigrationContext } from '@shared-web/browser/rallar-data.ts';
import type { PersistenceProvider, PersistenceSetItemOptions } from '@shared/persistence/PersistenceProvider.ts';

export type RallarDataStorageValue = object | string | number | boolean | null;

type RallarDataPersistedEnvelope = Readonly<{
    kind: 'rallar.custom-data';
    schemaVersion: number;
    updatedAtEpochMs: number;
    value: RallarDataStorageValue;
}>;

const RALLAR_DATA_ENVELOPE_KIND = 'rallar.custom-data';

export namespace RallarDataPersistenceProvider {
    export type Options<V> = Readonly<{
        schemaVersion: number;
        migrate?: RallarDataMigration<V>;
    }>;
}

/** Owns the persisted envelope and schema-migration boundary. */
export class RallarDataPersistenceProvider<V> implements PersistenceProvider<string, V> {
    private readonly inner: PersistenceProvider<string, RallarDataStorageValue>;
    private readonly options: RallarDataPersistenceProvider.Options<V>;

    public constructor(
        inner: PersistenceProvider<string, RallarDataStorageValue>,
        options: RallarDataPersistenceProvider.Options<V>
    ) {
        this.inner = inner;
        this.options = options;
    }

    public async getItem(key: string): Promise<V | undefined> {
        const persisted = await this.inner.getItem(key);
        if (persisted === undefined) {
            return undefined;
        }
        return await this.toValue(key, persisted);
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
                schemaVersion: this.options.schemaVersion,
                updatedAtEpochMs: Date.now(),
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

    private async toValue(
        key: string,
        persisted: RallarDataStorageValue
    ): Promise<V> {
        if (!isRallarDataEnvelope(persisted)) {
            return await this.migrateValue(key, persisted, 0, undefined);
        }
        if (persisted.schemaVersion === this.options.schemaVersion) {
            return persisted.value as V;
        }
        return await this.migrateValue(
            key,
            persisted.value,
            persisted.schemaVersion,
            persisted.updatedAtEpochMs
        );
    }

    private async migrateValue(
        key: string,
        persistedValue: RallarDataStorageValue,
        fromVersion: number,
        updatedAtEpochMs: number | undefined
    ): Promise<V> {
        if (!this.options.migrate) {
            return persistedValue as V;
        }
        const context: RallarDataMigrationContext = {
            key,
            fromVersion,
            toVersion: this.options.schemaVersion,
            updatedAtEpochMs
        };
        return await this.options.migrate(persistedValue, context);
    }
}

function isRallarDataEnvelope(
    value: RallarDataStorageValue
): value is RallarDataPersistedEnvelope {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value as Partial<RallarDataPersistedEnvelope>;
    return (
        candidate.kind === RALLAR_DATA_ENVELOPE_KIND &&
        typeof candidate.schemaVersion === 'number' &&
        typeof candidate.updatedAtEpochMs === 'number' &&
        'value' in candidate
    );
}
