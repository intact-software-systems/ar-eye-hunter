export namespace KeyedWriteSet {
    export type Mutation<V> = { readonly kind: 'removed'; } | { readonly kind: 'value'; readonly value: V; };

    export type Lookup<V> = Mutation<V> | { readonly kind: 'untouched'; };

    export interface Entry<K, V> {
        readonly key: K;
        readonly value: V;
    }

    export type OverlayEntry<K, Stored, Staged> =
        | { readonly kind: 'stored'; readonly key: K; readonly value: Stored; }
        | { readonly kind: 'staged'; readonly key: K; readonly value: Staged; };
}

/** Staging belongs to one transaction; removals survive until its owner commits or discards it. */
export class KeyedWriteSet<K, V> {
    private readonly pending = new Map<K, KeyedWriteSet.Mutation<V>>();

    lookup(key: K): KeyedWriteSet.Lookup<V> {
        return this.pending.get(key) ?? { kind: 'untouched' };
    }

    set(key: K, value: V): void {
        this.pending.set(key, { kind: 'value', value });
    }

    remove(key: K): void {
        this.pending.set(key, { kind: 'removed' });
    }

    mutations(): readonly (readonly [K, KeyedWriteSet.Mutation<V>])[] {
        return [...this.pending];
    }

    /** Stored order first, then puts in first-mutation order; values keep their exact identity. */
    overlay<Stored>(
        stored: readonly KeyedWriteSet.Entry<K, Stored>[]
    ): readonly KeyedWriteSet.OverlayEntry<K, Stored, V>[] {
        return computeKeyedWriteOverlay(stored, this.pending);
    }
}

/** The representation tags let adapters decode stored and staged values at their own boundaries. */
export function computeKeyedWriteOverlay<K, Stored, Staged>(
    stored: readonly KeyedWriteSet.Entry<K, Stored>[],
    pending: ReadonlyMap<K, KeyedWriteSet.Mutation<Staged>>
): readonly KeyedWriteSet.OverlayEntry<K, Stored, Staged>[] {
    const entries: KeyedWriteSet.OverlayEntry<K, Stored, Staged>[] = [];
    for (const entry of stored) {
        if (!pending.has(entry.key)) {
            entries.push({ kind: 'stored', key: entry.key, value: entry.value });
        }
    }
    for (const [key, mutation] of pending) {
        if (mutation.kind === 'value') {
            entries.push({ kind: 'staged', key, value: mutation.value });
        }
    }
    return entries;
}
