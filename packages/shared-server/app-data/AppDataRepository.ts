export type AppDataEntry<V = unknown> = Readonly<{
    namespace: string;
    storeName: string;
    key: string;
    value: V;
    schemaVersion: number;
    expireAtTimestamp: number;
    updatedTimestamp: string;
    revision: number;
}>;

export type AppDataUpsertInput<V = unknown> = Readonly<{
    namespace: string;
    storeName: string;
    key: string;
    value: V;
    schemaVersion: number;
    expireAtTimestamp: number;
}>;

export type AppDataRepositoryLike = Readonly<{
    findEntry(
        namespace: string,
        storeName: string,
        key: string,
    ): Promise<AppDataEntry | undefined>;
    findEntries(
        namespace: string,
        storeName: string,
        keyPrefix?: string,
    ): Promise<readonly AppDataEntry[]>;
    upsert(input: AppDataUpsertInput): Promise<void>;
    deleteByKey(namespace: string, storeName: string, key: string): Promise<boolean>;
    deleteExpired(namespace: string, storeName?: string): Promise<number>;
}>;
