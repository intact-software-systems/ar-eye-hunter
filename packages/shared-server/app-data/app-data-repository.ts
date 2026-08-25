import type { JsonWireValue } from '../rallar-system/protocol/json-wire-identity.ts';

export interface AppDataKey {
    readonly namespace: string;
    readonly storeName: string;
    readonly key: string;
}

export interface AppDataEntry extends AppDataKey {
    readonly value: JsonWireValue;
    readonly schemaVersion: number;
    readonly expireAtTimestamp: number;
    readonly updatedTimestamp: string;
    readonly revision: number;
}

export interface AppDataEntryPageInput {
    readonly namespace: string;
    readonly storeName: string;
    readonly keyPrefix?: string;
    readonly afterKey?: string;
    readonly limit: number;
}

export interface AppDataUpsertInput extends AppDataKey {
    readonly value: JsonWireValue;
    readonly schemaVersion: number;
    readonly expireAtTimestamp: number;
}

export interface AppDataUpsertIfRevisionInput extends AppDataUpsertInput {
    readonly expectedRevision: number;
}

export interface AppDataDeleteIfRevisionInput extends AppDataKey {
    readonly expectedRevision: number;
}

export interface AppDataDeleteExpiredInput {
    readonly namespace: string;
    readonly storeName?: string;
    readonly expireAtOrBeforeTimestamp: number;
}

export interface AppDataWritten {
    readonly status: 'written';
    readonly entry: AppDataEntry;
}

export interface AppDataWriteConflict {
    readonly status: 'conflict';
    readonly current?: AppDataEntry;
}

export type AppDataConditionalWriteResult = AppDataWritten | AppDataWriteConflict;

export interface AppDataInserted {
    readonly status: 'inserted';
    readonly entry: AppDataEntry;
}

export interface AppDataAlreadyExists {
    readonly status: 'exists';
    readonly current?: AppDataEntry;
}

export type AppDataConditionalInsertResult = AppDataInserted | AppDataAlreadyExists;

export interface AppDataDeleted {
    readonly status: 'deleted';
    readonly entry: AppDataEntry;
}

export type AppDataConditionalDeleteResult = AppDataDeleted | AppDataWriteConflict;

export interface AppDataRepository {
    findEntry(input: AppDataKey): Promise<AppDataEntry | undefined>;
    findEntriesPage(input: AppDataEntryPageInput): Promise<readonly AppDataEntry[]>;
    upsert(input: AppDataUpsertInput): Promise<void>;
    insertIfAbsent(input: AppDataUpsertInput): Promise<AppDataConditionalInsertResult>;
    upsertIfRevision(input: AppDataUpsertIfRevisionInput): Promise<AppDataConditionalWriteResult>;
    deleteByKey(input: AppDataKey): Promise<boolean>;
    deleteIfRevision(input: AppDataDeleteIfRevisionInput): Promise<AppDataConditionalDeleteResult>;
    deleteExpired(input: AppDataDeleteExpiredInput): Promise<number>;
}
