# Server App Data

Use `rallar.appData.open(...)` for typed reads of application-owned durable state,
such as leaderboards, scenario drafts, feature flags, and server diagnostics.
This storage is separate from browser-local `rallar.data`.

**Incoming mutations use `rallar.appInbox`.** An HTTP or WS handler must submit a
registered operation; it must not call an app-data update helper as a direct
mutation fallback. The operation reads fresh state, computes and validates the
complete candidate, then writes through its transaction-bound repository under
`rallar.appInbox.commit(...)`. AppInbox owns retry and durable completion.
See [Server application AppInbox](../server-app-inbox/README.md) for an executable
non-game example, and [Server Authoritative Game](../server-authoritative-game/README.md)
for room-owned state and publication.

```ts
import type {
    AppDataValueCodec,
    JsonWireValue,
    RallarServerApplication,
    RallarServerRuntime
} from '@shared-server/mod.ts';

interface LeaderboardEntry {
    readonly principalId: string;
    readonly score: number;
    readonly updatedAtEpochMs: number;
}

const LEADERBOARD_CODEC: AppDataValueCodec<LeaderboardEntry> = {
    schemaVersion: 1,
    encode: (value) => ({ ...value }),
    decode: decodeLeaderboardEntry
};

export async function readLeaderboard(
    rallar: RallarServerApplication<RallarServerRuntime, unknown>,
    limit: number
): Promise<readonly LeaderboardEntry[]> {
    const leaderboard = await rallar.appData.open('leaderboard', {
        namespace: 'demo-game',
        codec: LEADERBOARD_CODEC,
        readConsistency: 'fresh',
        maxConflictRetries: 8
    });
    return (await leaderboard.getAll()).sort((left, right) => right.score - left.score).slice(
        0,
        limit
    );
}

function decodeLeaderboardEntry(value: JsonWireValue): LeaderboardEntry {
    if (
        value === null || Array.isArray(value) || typeof value !== 'object' ||
        Object.keys(value).length !== 3 ||
        !('principalId' in value) || !('score' in value) || !('updatedAtEpochMs' in value) ||
        typeof value.principalId !== 'string' || typeof value.score !== 'number' ||
        !Number.isFinite(value.score) || typeof value.updatedAtEpochMs !== 'number' ||
        !Number.isSafeInteger(value.updatedAtEpochMs) || value.updatedAtEpochMs < 0
    ) {
        throw new TypeError('Leaderboard entry is malformed.');
    }
    return {
        principalId: value.principalId,
        score: value.score,
        updatedAtEpochMs: value.updatedAtEpochMs
    };
}
```

Use fresh reads for decisions shared across processes. `cache-first` is suitable
only when a stale process-local value is acceptable. Stored schema mismatches
and malformed values fail at the codec boundary.
