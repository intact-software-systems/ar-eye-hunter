# Server App Data

Use `rallar.data.open(...)` on the server for app-owned durable state that does
not belong in Rallar group/client snapshots. Examples include match state,
leaderboards, scenario drafts, API-side feature flags, and per-room server
diagnostics.

```ts
import type { RallarServerApplication } from '@shared-server/rallar-facade/RallarServerApplication.ts';
import type { RallarServerRuntime } from '@shared-server/rallar-facade/RallarServer.ts';
import {
    isRallarServerAppDataConflictError,
} from '@shared-server/app-data/RallarServerAppData.ts';

type LeaderboardEntry = {
    principalId: string;
    score: number;
    updatedAtEpochMs: number;
};

export async function installLeaderboard(
    rallar: RallarServerApplication<RallarServerRuntime, unknown>,
) {
    const leaderboard = await rallar.data.open<LeaderboardEntry>(
        'leaderboard',
        {
            namespace: 'demo-game',
            schemaVersion: 1,
            readConsistency: 'fresh',
            maxConflictRetries: 8,
        },
    );

    async function addScore(
        principalId: string,
        scoreDelta: number,
    ): Promise<LeaderboardEntry> {
        try {
            return await leaderboard.updateOrCreate(principalId, (current) => ({
                principalId,
                score: (current?.score ?? 0) + scoreDelta,
                updatedAtEpochMs: Date.now(),
            }));
        } catch (error) {
            if (isRallarServerAppDataConflictError(error)) {
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
        top,
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
