export type PersistenceSetItemOptions = Readonly<{
    expireAtTimestamp: number;
}>;

export const NEVER_EXPIRE_AT_TIMESTAMP = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

type InMemoryStoredValue<V> = Readonly<{
    value: V;
    expireAtTimestamp: number;
}>;

export interface PersistenceProvider<K, V> {
    getItem(key: K): Promise<V | undefined>;

    setItem(key: K, value: V, options: PersistenceSetItemOptions): Promise<void>;

    removeItem(key: K): Promise<void>;

    getAllKeys(): Promise<K[]>;

    deleteExpired(): Promise<number>;
}

export class InMemoryPersistenceProvider<K, V> implements PersistenceProvider<K, V> {
    private readonly data: Map<K, InMemoryStoredValue<V>>;

    constructor(
        entries: Iterable<readonly [K, V]> = []
    ) {
        this.data = new Map(
            [...entries].map(([key, value]) =>
                [
                    key,
                    {
                        value,
                        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
                    }
                ] satisfies readonly [K, InMemoryStoredValue<V>]
            )
        );
    }

    async getItem(key: K): Promise<V | undefined> {
        const stored = this.data.get(key);
        if (!stored) {
            return undefined;
        }

        if (isExpired(stored.expireAtTimestamp)) {
            this.data.delete(key);
            return undefined;
        }

        return stored.value;
    }

    async setItem(key: K, value: V, options: PersistenceSetItemOptions): Promise<void> {
        this.data.set(key, {
            value,
            expireAtTimestamp: toExpireAtTimestamp(options.expireAtTimestamp)
        });
    }

    async removeItem(key: K): Promise<void> {
        this.data.delete(key);
    }

    async getAllKeys(): Promise<K[]> {
        const keys: K[] = [];

        for (const [key, stored] of this.data.entries()) {
            if (isExpired(stored.expireAtTimestamp)) {
                this.data.delete(key);
                continue;
            }

            keys.push(key);
        }

        return keys;
    }

    async deleteExpired(): Promise<number> {
        let deleted = 0;

        for (const [key, stored] of this.data.entries()) {
            if (!isExpired(stored.expireAtTimestamp)) {
                continue;
            }

            this.data.delete(key);
            deleted += 1;
        }

        return deleted;
    }
}

function isExpired(expireAtTimestamp: number): boolean {
    return !Number.isFinite(expireAtTimestamp) || expireAtTimestamp <= Date.now();
}

function toExpireAtTimestamp(expireAtTimestamp: number): number {
    if (!Number.isFinite(expireAtTimestamp)) {
        throw new Error('expireAtTimestamp must be a finite number');
    }

    return expireAtTimestamp;
}
