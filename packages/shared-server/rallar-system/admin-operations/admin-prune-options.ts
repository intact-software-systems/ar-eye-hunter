export type AdminPruneExpiredOptions = Readonly<{
    cutoffEpochMs: number;
    appData?: Readonly<{
        namespace?: string;
        storeName?: string;
    }>;
}>;
