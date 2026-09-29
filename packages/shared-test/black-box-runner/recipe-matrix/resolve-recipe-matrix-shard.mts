export interface RecipeMatrixShard {
    readonly index: number;
    readonly count: number;
}

export interface RecipeShardWeights {
    readonly defaultSeconds: number;
    readonly secondsByEntryId: Readonly<Record<string, number>>;
}

export interface ResolveRecipeMatrixShardInput<Entry extends { readonly id: string; }> {
    readonly entries: readonly Entry[];
    readonly shard: RecipeMatrixShard;
    readonly weights: RecipeShardWeights;
}

export function parseRecipeMatrixShard(text: string): RecipeMatrixShard {
    const match = /^(\d+)\/(\d+)$/u.exec(text);
    const index = Number(match?.[1]);
    const count = Number(match?.[2]);
    if (!match || index < 1 || count < 1 || index > count) {
        throw new Error(`--shard must be <index>/<count> with 1 <= index <= count, got "${text}".`);
    }
    return { index, count };
}

/**
 * Splits entries into shards of about equal estimated seconds: the heaviest entry goes to the
 * lightest shard so far, ties by id and then by shard number. Only balance depends on the weights;
 * a stale or missing weight never changes which recipes run across all shards, and each shard keeps
 * the matrix order.
 */
export function resolveRecipeMatrixShard<Entry extends { readonly id: string; }>(
    input: ResolveRecipeMatrixShardInput<Entry>
): readonly Entry[] {
    const { entries, shard, weights } = input;
    const toSeconds = (entry: Entry): number => weights.secondsByEntryId[entry.id] ?? weights.defaultSeconds;
    const shardSeconds = Array.from({ length: shard.count }, () => 0);
    const shardOfEntry = new Map<Entry, number>();
    const heaviestFirst = [...entries].sort(
        (left, right) => toSeconds(right) - toSeconds(left) || left.id.localeCompare(right.id)
    );
    for (const entry of heaviestFirst) {
        const lightest = shardSeconds.indexOf(Math.min(...shardSeconds));
        shardSeconds[lightest] += toSeconds(entry);
        shardOfEntry.set(entry, lightest);
    }
    return entries.filter((entry) => shardOfEntry.get(entry) === shard.index - 1);
}
