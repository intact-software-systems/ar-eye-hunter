export interface RuntimeStateGuardedBatchIdentity {
    readonly namespace: string;
    readonly key: string;
}

/**
 * Applies where the key holds no row or an expired one, since every read takes an expired row for absent. The row
 * lands at revision 0, or one past a still-present expired row it replaces. Physical deletion followed by insertion
 * can reset revision to 0; use an exact update with a unique stored incarnation when that reset must be fenced.
 */
export type RuntimeStateGuardedBatchInsert =
    & RuntimeStateGuardedBatchIdentity
    & Readonly<{
        operation: 'insert';
        value: string;
        expireAtTimestamp: number;
    }>;

export type RuntimeStateGuardedBatchUpdate =
    & RuntimeStateGuardedBatchIdentity
    & Readonly<{
        operation: 'update';
        expectedRevision: number;
        value: string;
        expireAtTimestamp: number;
    }>;

/**
 * Revision plus exact stored value. Callers fencing physical deletion/recreation must include a unique incarnation
 * in that value: a recreated row with both the same revision and the same value still matches.
 */
export interface RuntimeStateGuardedBatchExactUpdate extends RuntimeStateGuardedBatchIdentity {
    readonly operation: 'update-exact';
    readonly expectedRevision: number;
    readonly expectedValue: string;
    readonly value: string;
    readonly expireAtTimestamp: number;
}

export type RuntimeStateGuardedBatchDelete =
    & RuntimeStateGuardedBatchIdentity
    & Readonly<{
        operation: 'delete';
        expectedRevision: number;
    }>;

export type RuntimeStateGuardedBatchPut =
    & RuntimeStateGuardedBatchIdentity
    & Readonly<{
        operation: 'put';
        value: string;
        expireAtTimestamp: number;
    }>;

export type RuntimeStateGuardedBatchGuard =
    | RuntimeStateGuardedBatchInsert
    | RuntimeStateGuardedBatchUpdate
    | RuntimeStateGuardedBatchExactUpdate
    | RuntimeStateGuardedBatchDelete;

export type RuntimeStateGuardedBatchEffect =
    & Readonly<{ effectId: string; }>
    & (
        | RuntimeStateGuardedBatchInsert
        | RuntimeStateGuardedBatchUpdate
        | RuntimeStateGuardedBatchExactUpdate
        | RuntimeStateGuardedBatchDelete
        | RuntimeStateGuardedBatchPut
    );

export interface RuntimeStateGuardedBatch {
    readonly guard: RuntimeStateGuardedBatchGuard;
    readonly effects: readonly RuntimeStateGuardedBatchEffect[];
}

export interface RuntimeStateGuardedBatchSqlDescriptor {
    readonly effectId?: string;
    readonly operation: RuntimeStateGuardedBatchEffect['operation'];
    readonly namespace: string;
    readonly key: string;
    readonly expectedRevision?: number;
    readonly expectedValue?: string;
    readonly value?: string;
    readonly expireAtTimestamp?: string;
}

export interface RuntimeStateGuardedBatchWrite extends RuntimeStateGuardedBatch {
    readonly guardSqlDescriptor: RuntimeStateGuardedBatchSqlDescriptor;
    readonly effectSqlDescriptors: readonly RuntimeStateGuardedBatchSqlDescriptor[];
}

export type RuntimeStateGuardedBatchGuardResult =
    | Readonly<{
        status: 'applied';
        operation: 'insert' | 'update' | 'update-exact';
        namespace: string;
        key: string;
        resultingRevision: number;
    }>
    | Readonly<{
        status: 'applied';
        operation: 'delete';
        namespace: string;
        key: string;
        matchedRevision: number;
    }>
    | Readonly<{
        status: 'conflict';
        operation: RuntimeStateGuardedBatchGuard['operation'];
        namespace: string;
        key: string;
        reason: 'condition-not-met';
    }>;

export type RuntimeStateGuardedBatchEffectResult =
    | Readonly<{
        status: 'applied';
        effectId: string;
        operation: 'insert' | 'update' | 'update-exact' | 'put';
        namespace: string;
        key: string;
        resultingRevision: number;
    }>
    | Readonly<{
        status: 'applied';
        effectId: string;
        operation: 'delete';
        namespace: string;
        key: string;
        matchedRevision: number;
    }>
    | Readonly<{
        status: 'conflict';
        effectId: string;
        operation: Exclude<RuntimeStateGuardedBatchEffect['operation'], 'put'>;
        namespace: string;
        key: string;
        reason: 'condition-not-met';
    }>
    | Readonly<{
        status: 'skipped';
        effectId: string;
        operation: RuntimeStateGuardedBatchEffect['operation'];
        namespace: string;
        key: string;
        reason: 'guard-conflict';
    }>;

export interface RuntimeStateGuardedBatchResult {
    readonly guard: RuntimeStateGuardedBatchGuardResult;
    readonly effects: readonly RuntimeStateGuardedBatchEffectResult[];
}

export interface RuntimeStateGuardedBatchTransaction {
    writeGuardedBatch(
        computed: RuntimeStateGuardedBatchWrite
    ): Promise<RuntimeStateGuardedBatchResult>;
}
