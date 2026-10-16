export namespace TurnBatchedReads {
    export interface Dependencies<K, V> {
        readonly toKeyId: (key: K) => string;
        /** Answers each distinct key of one turn once, one value per key in the order given. */
        readonly readBatch: (keys: readonly K[]) => Promise<readonly V[]>;
    }
}

interface TurnBatch<K, V> {
    readonly keys: K[];
    readonly indexByKeyId: Map<string, number>;
    readonly values: Promise<readonly V[]>;
}

/**
 * Reads issued in one synchronous turn share one batch read. Nothing outlives its batch: a read issued
 * once a batch has begun starts the next one, so every read observes the store no earlier than it asked.
 */
export class TurnBatchedReads<K, V> {
    private readonly dependencies: TurnBatchedReads.Dependencies<K, V>;
    private collecting: TurnBatch<K, V> | undefined;

    constructor(dependencies: TurnBatchedReads.Dependencies<K, V>) {
        this.dependencies = dependencies;
    }

    async read(key: K): Promise<V> {
        const batch = this.collecting ?? this.startBatch();
        const keyId = this.dependencies.toKeyId(key);
        const held = batch.indexByKeyId.get(keyId);
        const index = held ?? batch.keys.push(key) - 1;
        if (held === undefined) {
            batch.indexByKeyId.set(keyId, index);
        }
        return (await batch.values)[index]!;
    }

    private startBatch(): TurnBatch<K, V> {
        const keys: K[] = [];
        const batch: TurnBatch<K, V> = {
            keys,
            indexByKeyId: new Map(),
            values: Promise.resolve().then(() => this.readCollected(keys))
        };
        this.collecting = batch;
        return batch;
    }

    private async readCollected(keys: readonly K[]): Promise<readonly V[]> {
        this.collecting = undefined;
        const values = await this.dependencies.readBatch(keys);
        if (values.length !== keys.length) {
            throw new TypeError('A batch read must answer one value per key');
        }
        return values;
    }
}
