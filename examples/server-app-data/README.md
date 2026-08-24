# Server App Data

Use `rallar.appData.open(...)` on the server for app-owned durable state that does
not belong in Rallar group/client snapshots. Examples include match state,
leaderboards, scenario drafts, API-side feature flags, and per-room server
diagnostics.

```ts
import type { AppDataValueCodec } from '@shared-server/app-data/app-data-value-codec.ts';
import { RallarServerAppDataConflictError } from '@shared-server/app-data/rallar-server-app-data-conflict-error.ts';
import type {
    RallarServerApplication,
    RallarServerRuntime
} from '@shared-server/rallar-server/rallar-server-application.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

interface LeaderboardEntry {
    principalId: string;
    score: number;
    updatedAtEpochMs: number;
}

const LEADERBOARD_CODEC: AppDataValueCodec<LeaderboardEntry> = {
    schemaVersion: 1,
    encode: (value) => ({ ...value }),
    decode: decodeLeaderboardEntry
};

export async function installLeaderboard(
    rallar: RallarServerApplication<RallarServerRuntime, unknown>
) {
    const leaderboard = await rallar.appData.open(
        'leaderboard',
        {
            namespace: 'demo-game',
            codec: LEADERBOARD_CODEC,
            readConsistency: 'fresh',
            maxConflictRetries: 8
        }
    );

    async function addScore(
        principalId: string,
        scoreDelta: number
    ): Promise<LeaderboardEntry> {
        try {
            return await leaderboard.updateOrCreate(principalId, (current) => ({
                principalId,
                score: (current?.score ?? 0) + scoreDelta,
                updatedAtEpochMs: Date.now()
            }));
        }
        catch (error) {
            if (error instanceof RallarServerAppDataConflictError) {
                throw new Error('Leaderboard write conflicted. Retry the request.');
            }

            throw error;
        }
    }

    async function top(limit = 10): Promise<readonly LeaderboardEntry[]> {
        return (await leaderboard.getAll())
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    return {
        addScore,
        top
    };
}

function decodeLeaderboardEntry(value: JsonWireValue): LeaderboardEntry {
    if (
        value === null ||
        Array.isArray(value) ||
        typeof value !== 'object' ||
        typeof value.principalId !== 'string' ||
        typeof value.score !== 'number' ||
        typeof value.updatedAtEpochMs !== 'number'
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

Server app data is separate from browser-local `rallar.data`. Browser data is
for local latest-value state such as preferences and drafts. Server app data is
for authoritative app state that must survive server restarts and be shared
across clients.

Prefer fresh reads for cross-process correctness. Use
`readConsistency: 'cache-first'` only for data that can tolerate a process-local
cached value.
