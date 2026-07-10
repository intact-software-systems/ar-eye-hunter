# Rallar Browser Match Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional Rallar browser match-support layer that standardizes participants, standings, results, browser-director match wiring, and server-authority browser wiring without making Rallar own game scoring rules.

**Architecture:** Runtime-agnostic match contracts and pure helpers live in `packages/shared/rallar-match`. Browser integration lives beside the existing Rallar Game helpers in `packages/shared-web/game` and composes `createRallarGameMatch` plus `createRallarGameAuthorityClient`. Server support stays minimal: use existing `installRallarGameAuthorityServer` and add one server-validated result helper without adding REST routes or persistence.

**Tech Stack:** TypeScript, Vitest, existing Rallar shared/shared-web/shared-server package boundaries, existing Rallar Game browser and authority helpers.

## Global Constraints

- Do not add a top-level `rallar.match` facade in V1.
- Do not add global leaderboards, rankings, seasons, matchmaking, rewards, or anti-cheat in V1.
- Do not move point calculation, command legality, physics, win conditions, or app scoring rules into Rallar.
- Keep `GroupRef` in public result contracts when application/workspace scope matters.
- Treat browser-director results as `room-trusted` unless a server validates and finalizes them.
- Preserve existing public exports and import paths.
- Use named optional imports from `@shared/rallar-match/mod.ts` and `@shared-web/game/mod.ts`.
- Keep AR Eye Hunter and Relic Hunters unchanged in V1.
- Keep formal team membership and team standings out of V1.
- Keep result persistence app-owned; Rallar does not add result storage or retrieval APIs in V1.

## Resolved V1 Decisions

These decisions are approved for implementation and define the V1 scope.

1. Create a separate `packages/shared/rallar-match` package instead of extending `rallar-game`. The helpers remain usable by games, quizzes, challenge rooms, and simulations without coupling generic match contracts to Rallar Game Authority.

2. Include one narrow server-side helper for validating and constructing `server-validated` result envelopes. Do not add REST routes, storage, or retrieval APIs.

3. Do not migrate AR Eye Hunter or Relic Hunters in V1. Prove the public surface with focused package tests before adopting it in an application.

4. Do not add a formal team model in V1. Applications may project team-like rows through app-owned metrics; first-class team identity, membership, and aggregation remain a later extension.

5. Do not persist result envelopes in Rallar in V1. Applications may publish or store them through existing app-owned channels, while Rallar supplies validation, envelope construction, and idempotency helpers only.

---

## File Structure

Create:

- `packages/shared/rallar-match/types.ts`: public runtime-agnostic match types.
- `packages/shared/rallar-match/participants.ts`: participant derivation from group room snapshots and browser room members.
- `packages/shared/rallar-match/standings.ts`: generic standings projection and rank/tie helpers.
- `packages/shared/rallar-match/results.ts`: generic result envelope creation and idempotency key helper.
- `packages/shared/rallar-match/diagnostics.ts`: generic result/standings/participant diagnostics.
- `packages/shared/rallar-match/mod.ts`: package barrel.
- `packages/shared-web/game/match-support.ts`: browser-director match wrapper over `createRallarGameMatch`.
- `packages/shared-web/game/authority-match-support.ts`: server-authority browser wrapper over `createRallarGameAuthorityClient`.
- `packages/shared-server/game/match-result.ts`: server-validated result helper around shared result envelopes.
- `packages/tests/shared/rallar-match.test.ts`: pure helper tests.
- `packages/tests/shared-web/rallar-browser-match-support.test.ts`: browser-director wrapper tests.
- `packages/tests/shared-web/rallar-authority-match-support.test.ts`: server-authority browser wrapper tests.
- `packages/tests/shared-server/rallar-match-result.test.ts`: server result helper tests.

Modify:

- `packages/shared/mod.ts`: export `./rallar-match/mod.ts`.
- `packages/shared-web/game/mod.ts`: export the new browser match-support files.
- `packages/shared-server/game/mod.ts`: export the server result helper.
- `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`: add new `@shared-web/game/mod.ts` public exports.
- `docs/rallar-api-reference.md`: document the optional match helpers and boundary.

Do not modify:

- `packages/shared-web/browser/rallar.ts`: no top-level facade in V1.
- `apps/ar-eye-hunter-v1/**`: no migration in V1.
- `apps/relic-hunters-v1/**`: no migration in V1.
- `apps/api-v1/**`: no new REST routes in V1.

---

### Task 1: Shared Match Contracts And Pure Helpers

**Files:**

- Create: `packages/shared/rallar-match/types.ts`
- Create: `packages/shared/rallar-match/participants.ts`
- Create: `packages/shared/rallar-match/standings.ts`
- Create: `packages/shared/rallar-match/results.ts`
- Create: `packages/shared/rallar-match/diagnostics.ts`
- Create: `packages/shared/rallar-match/mod.ts`
- Modify: `packages/shared/mod.ts`
- Test: `packages/tests/shared/rallar-match.test.ts`

**Interfaces:**

- Consumes:
  - `GroupRef`, `GroupSnapshot`, `GroupMemberStatus`, `GroupRole`, `PrincipalId`, and `SessionId` from `@shared/api/group-types.ts`.
- Produces:
  - `RallarMatchParticipant`
  - `RallarMatchStanding`
  - `RallarMatchResult<TSummary>`
  - `RallarMatchAuthorityDescriptor`
  - `deriveRallarMatchParticipants(input)`
  - `deriveRallarMatchStandings(input)`
  - `createRallarMatchResult(input)`
  - `deriveRallarMatchDiagnostics(input)`

- [x] **Step 1: Write the failing shared helper tests**

Create `packages/tests/shared/rallar-match.test.ts` with these tests:

```ts
import { describe, expect, it } from 'vitest';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
    createRallarMatchResult,
    deriveRallarMatchDiagnostics,
    deriveRallarMatchParticipants,
    deriveRallarMatchStandings,
} from '@shared/rallar-match/mod.ts';

describe('Rallar match shared helpers', () => {
    it('derives principal-first participants from active group members and sessions', () => {
        const snapshot = {
            members: [
                {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1',
                    principalId: 'principal-b',
                    role: 'member',
                    status: 'active',
                },
                {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1',
                    principalId: 'principal-a',
                    role: 'owner',
                    status: 'active',
                },
                {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1',
                    principalId: 'principal-removed',
                    role: 'member',
                    status: 'removed',
                },
            ],
            activeSessions: [
                {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1',
                    principalId: 'principal-a',
                    sessionId: 'session-a2',
                },
                {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1',
                    principalId: 'principal-a',
                    sessionId: 'session-a1',
                },
            ],
        } as GroupSnapshot;

        expect(deriveRallarMatchParticipants({ snapshot })).toEqual([
            {
                participantId: 'principal-a',
                principalId: 'principal-a',
                role: 'owner',
                status: 'active',
                online: true,
                sessionIds: ['session-a1', 'session-a2'],
            },
            {
                participantId: 'principal-b',
                principalId: 'principal-b',
                role: 'member',
                status: 'active',
                online: false,
                sessionIds: [],
            },
        ]);
    });

    it('supports custom participant identities', () => {
        const snapshot = {
            members: [
                {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1',
                    principalId: 'principal-a',
                    role: 'member',
                    status: 'active',
                },
            ],
            activeSessions: [],
        } as GroupSnapshot;

        expect(
            deriveRallarMatchParticipants({
                snapshot,
                resolveParticipantId: ({ principalId }) => `seat:${principalId}`,
            })[0]?.participantId,
        ).toBe('seat:principal-a');
    });

    it('derives stable standings with rank ties', () => {
        expect(
            deriveRallarMatchStandings({
                rows: [
                    {
                        participantId: 'b',
                        principalId: 'principal-b',
                        sessionIds: ['session-b'],
                        metrics: { points: 10, objectives: 1 },
                    },
                    {
                        participantId: 'a',
                        principalId: 'principal-a',
                        sessionIds: ['session-a'],
                        metrics: { points: 10, objectives: 1 },
                    },
                    {
                        participantId: 'c',
                        principalId: 'principal-c',
                        sessionIds: ['session-c'],
                        metrics: { points: 4, objectives: 3 },
                    },
                ],
                compare: (left, right) =>
                    right.metrics.points - left.metrics.points ||
                    right.metrics.objectives - left.metrics.objectives,
            }),
        ).toEqual([
            {
                participantId: 'a',
                principalId: 'principal-a',
                sessionIds: ['session-a'],
                rank: 1,
                tieGroup: 1,
                metrics: { points: 10, objectives: 1 },
            },
            {
                participantId: 'b',
                principalId: 'principal-b',
                sessionIds: ['session-b'],
                rank: 1,
                tieGroup: 1,
                metrics: { points: 10, objectives: 1 },
            },
            {
                participantId: 'c',
                principalId: 'principal-c',
                sessionIds: ['session-c'],
                rank: 3,
                tieGroup: 2,
                metrics: { points: 4, objectives: 3 },
            },
        ]);
    });

    it('creates deterministic match result envelopes', () => {
        const result = createRallarMatchResult({
            resultId: 'result-1',
            matchId: 'match-1',
            roomRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1',
            },
            protocol: 'example.match.v1',
            authority: {
                kind: 'browser-director',
                id: 'session-a',
                epoch: 4,
                principalId: 'principal-a',
                sessionId: 'session-a',
            },
            trust: 'room-trusted',
            startedAtEpochMs: 1_000,
            finishedAtEpochMs: 2_000,
            standings: [
                {
                    participantId: 'principal-a',
                    principalId: 'principal-a',
                    sessionIds: ['session-a'],
                    rank: 1,
                    tieGroup: 1,
                    metrics: { points: 10 },
                },
            ],
            summary: { reason: 'finished' },
        });

        expect(result.idempotencyKey).toBe(
            'match-1:browser-director:session-a:4:2000',
        );
        expect(result.trust).toBe('room-trusted');
        expect(result.summary).toEqual({ reason: 'finished' });
    });

    it('reports generic match diagnostics', () => {
        expect(
            deriveRallarMatchDiagnostics({
                participants: [],
                standings: [],
                result: undefined,
                authorityFresh: false,
                pendingCommandCount: 2,
                snapshotAgeMs: 12_000,
                maxSnapshotAgeMs: 5_000,
            }).issues,
        ).toEqual([
            'no-participants',
            'no-standings',
            'no-result',
            'stale-authority',
            'pending-commands',
            'stale-snapshot',
        ]);
    });
});
```

- [x] **Step 2: Run the failing shared helper tests**

Run:

```bash
npx vitest run packages/tests/shared/rallar-match.test.ts
```

Expected: FAIL because `@shared/rallar-match/mod.ts` does not exist.

- [x] **Step 3: Implement `types.ts`**

Create `packages/shared/rallar-match/types.ts` with these public names:

```ts
import type {
    GroupMemberStatus,
    GroupRef,
    GroupRole,
    GroupSnapshot,
    PrincipalId,
    SessionId,
} from '../api/group-types.ts';

export type RallarMatchParticipant = Readonly<{
    participantId: string;
    principalId?: PrincipalId;
    role?: GroupRole;
    status?: GroupMemberStatus;
    online: boolean;
    sessionIds: readonly SessionId[];
    displayName?: string;
}>;

export type RallarMatchParticipantIdentity = Readonly<{
    principalId: PrincipalId;
    role?: GroupRole;
    status?: GroupMemberStatus;
    sessionIds: readonly SessionId[];
}>;

export type RallarMatchParticipantResolver = (
    identity: RallarMatchParticipantIdentity,
) => string;

export type RallarMatchParticipantsInput = Readonly<{
    snapshot?: Pick<GroupSnapshot, 'members' | 'activeSessions'>;
    members?: readonly RallarMatchParticipant[];
    includeInactiveMembers?: boolean;
    resolveParticipantId?: RallarMatchParticipantResolver;
}>;

export type RallarMatchMetricMap = Readonly<Record<string, number>>;

export type RallarMatchStandingRow = Readonly<{
    participantId: string;
    principalId?: PrincipalId;
    sessionIds: readonly SessionId[];
    metrics: RallarMatchMetricMap;
}>;

export type RallarMatchStanding = RallarMatchStandingRow & Readonly<{
    rank: number;
    tieGroup: number;
}>;

export type RallarMatchStandingComparator = (
    left: RallarMatchStandingRow,
    right: RallarMatchStandingRow,
) => number;

export type RallarMatchStandingsInput = Readonly<{
    rows: readonly RallarMatchStandingRow[];
    compare?: RallarMatchStandingComparator;
}>;

export type RallarMatchAuthorityKind = 'browser-director' | 'server';

export type RallarMatchAuthorityDescriptor = Readonly<{
    kind: RallarMatchAuthorityKind;
    id: string;
    epoch: number;
    principalId?: PrincipalId;
    sessionId?: SessionId;
}>;

export type RallarMatchTrust = 'local' | 'room-trusted' | 'server-validated';

export type RallarMatchResult<TSummary = unknown> = Readonly<{
    resultId: string;
    matchId: string;
    roomRef: GroupRef;
    protocol: string;
    authority: RallarMatchAuthorityDescriptor;
    trust: RallarMatchTrust;
    startedAtEpochMs?: number;
    finishedAtEpochMs: number;
    standings: readonly RallarMatchStanding[];
    summary: TSummary;
    idempotencyKey: string;
}>;

export type RallarMatchResultInput<TSummary = unknown> =
    Omit<RallarMatchResult<TSummary>, 'idempotencyKey'> &
    Readonly<{ idempotencyKey?: string }>;

export type RallarMatchDiagnosticsInput<TSummary = unknown> = Readonly<{
    participants?: readonly RallarMatchParticipant[];
    standings?: readonly RallarMatchStanding[];
    result?: RallarMatchResult<TSummary>;
    authorityFresh?: boolean;
    pendingCommandCount?: number;
    snapshotAgeMs?: number;
    maxSnapshotAgeMs?: number;
}>;

export type RallarMatchDiagnostics = Readonly<{
    participantCount: number;
    standingCount: number;
    hasResult: boolean;
    pendingCommandCount: number;
    snapshotAgeMs?: number;
    issues: readonly string[];
}>;
```

- [x] **Step 4: Implement `participants.ts`**

Create `packages/shared/rallar-match/participants.ts`:

```ts
import type {
    GroupMember,
    GroupMemberStatus,
    GroupPresenceSession,
} from '../api/group-types.ts';
import type {
    RallarMatchParticipant,
    RallarMatchParticipantsInput,
} from './types.ts';

export function deriveRallarMatchParticipants(
    input: RallarMatchParticipantsInput,
): readonly RallarMatchParticipant[] {
    if (input.members) {
        return Array.from(input.members).sort(compareParticipants);
    }

    const snapshot = input.snapshot;
    if (!snapshot) {
        return [];
    }

    const sessionsByPrincipal = groupSessionsByPrincipal(snapshot.activeSessions);
    const includeInactive = input.includeInactiveMembers === true;

    return snapshot.members
        .filter((member) => includeInactive || member.status === 'active')
        .map((member) => {
            const sessionIds = sessionsByPrincipal.get(member.principalId) ?? [];
            const identity = {
                principalId: member.principalId,
                role: member.role,
                status: member.status,
                sessionIds,
            };

            return {
                participantId: input.resolveParticipantId
                    ? input.resolveParticipantId(identity)
                    : member.principalId,
                principalId: member.principalId,
                role: member.role,
                status: member.status,
                online: sessionIds.length > 0,
                sessionIds,
            } satisfies RallarMatchParticipant;
        })
        .sort(compareParticipants);
}

function groupSessionsByPrincipal(
    sessions: readonly Pick<GroupPresenceSession, 'principalId' | 'sessionId'>[],
): ReadonlyMap<string, readonly string[]> {
    const grouped = new Map<string, string[]>();
    for (const session of sessions) {
        const values = grouped.get(session.principalId) ?? [];
        values.push(session.sessionId);
        grouped.set(session.principalId, values);
    }

    for (const [principalId, sessionIds] of grouped.entries()) {
        grouped.set(principalId, sessionIds.sort());
    }

    return grouped;
}

function compareParticipants(
    left: Pick<RallarMatchParticipant, 'participantId'>,
    right: Pick<RallarMatchParticipant, 'participantId'>,
): number {
    return left.participantId.localeCompare(right.participantId);
}

export function isActiveGroupMemberStatus(status: GroupMemberStatus): boolean {
    return status === 'active';
}

export type RallarMatchParticipantMemberInput =
    Pick<GroupMember, 'principalId' | 'role' | 'status'>;
```

- [x] **Step 5: Implement `standings.ts`**

Create `packages/shared/rallar-match/standings.ts`:

```ts
import type {
    RallarMatchStanding,
    RallarMatchStandingComparator,
    RallarMatchStandingRow,
    RallarMatchStandingsInput,
} from './types.ts';

export function deriveRallarMatchStandings(
    input: RallarMatchStandingsInput,
): readonly RallarMatchStanding[] {
    const compare = input.compare ?? compareByPointsDescending;
    const rows = Array.from(input.rows).sort((left, right) => {
        const compared = compare(left, right);
        return compared === 0
            ? left.participantId.localeCompare(right.participantId)
            : compared;
    });

    let previous: RallarMatchStandingRow | undefined;
    let previousRank = 0;
    let tieGroup = 0;

    return rows.map((row, index): RallarMatchStanding => {
        const sameRank = previous ? compare(previous, row) === 0 : false;
        if (!sameRank) {
            previousRank = index + 1;
            tieGroup += 1;
        }
        previous = row;

        return {
            participantId: row.participantId,
            principalId: row.principalId,
            sessionIds: row.sessionIds,
            metrics: row.metrics,
            rank: previousRank,
            tieGroup,
        };
    });
}

export const compareByPointsDescending: RallarMatchStandingComparator = (
    left,
    right,
) => {
    const leftPoints = readMetric(left, 'points');
    const rightPoints = readMetric(right, 'points');
    if (leftPoints !== rightPoints) {
        return rightPoints - leftPoints;
    }
    return 0;
};

function readMetric(row: RallarMatchStandingRow, key: string): number {
    const value = row.metrics[key];
    return Number.isFinite(value) ? value : 0;
}
```

- [x] **Step 6: Implement `results.ts`**

Create `packages/shared/rallar-match/results.ts`:

```ts
import type {
    RallarMatchResult,
    RallarMatchResultInput,
} from './types.ts';

export function createRallarMatchResult<TSummary>(
    input: RallarMatchResultInput<TSummary>,
): RallarMatchResult<TSummary> {
    return {
        resultId: input.resultId,
        matchId: input.matchId,
        roomRef: input.roomRef,
        protocol: input.protocol,
        authority: input.authority,
        trust: input.trust,
        startedAtEpochMs: input.startedAtEpochMs,
        finishedAtEpochMs: input.finishedAtEpochMs,
        standings: input.standings,
        summary: input.summary,
        idempotencyKey: input.idempotencyKey ??
            createRallarMatchResultIdempotencyKey(input),
    };
}

export function createRallarMatchResultIdempotencyKey(
    input: Pick<
        RallarMatchResultInput<unknown>,
        'matchId' | 'authority' | 'finishedAtEpochMs'
    >,
): string {
    return [
        input.matchId,
        input.authority.kind,
        input.authority.id,
        String(input.authority.epoch),
        String(input.finishedAtEpochMs),
    ].join(':');
}
```

- [x] **Step 7: Implement `diagnostics.ts`**

Create `packages/shared/rallar-match/diagnostics.ts`:

```ts
import type {
    RallarMatchDiagnostics,
    RallarMatchDiagnosticsInput,
} from './types.ts';

export function deriveRallarMatchDiagnostics(
    input: RallarMatchDiagnosticsInput,
): RallarMatchDiagnostics {
    const participants = input.participants ?? [];
    const standings = input.standings ?? [];
    const pendingCommandCount = input.pendingCommandCount ?? 0;
    const issues: string[] = [];

    if (participants.length === 0) {
        issues.push('no-participants');
    }
    if (standings.length === 0) {
        issues.push('no-standings');
    }
    if (!input.result) {
        issues.push('no-result');
    }
    if (input.authorityFresh === false) {
        issues.push('stale-authority');
    }
    if (pendingCommandCount > 0) {
        issues.push('pending-commands');
    }
    if (
        input.snapshotAgeMs !== undefined &&
        input.maxSnapshotAgeMs !== undefined &&
        input.snapshotAgeMs > input.maxSnapshotAgeMs
    ) {
        issues.push('stale-snapshot');
    }

    return {
        participantCount: participants.length,
        standingCount: standings.length,
        hasResult: input.result !== undefined,
        pendingCommandCount,
        snapshotAgeMs: input.snapshotAgeMs,
        issues,
    };
}
```

- [x] **Step 8: Add barrels**

Create `packages/shared/rallar-match/mod.ts`:

```ts
export * from './types.ts';
export * from './participants.ts';
export * from './standings.ts';
export * from './results.ts';
export * from './diagnostics.ts';
```

Modify `packages/shared/mod.ts` by adding this line near the existing Rallar package exports:

```ts
export * from './rallar-match/mod.ts';
```

- [x] **Step 9: Run shared tests and typecheck**

Run:

```bash
npx vitest run packages/tests/shared/rallar-match.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
```

Expected: both commands PASS.

- [x] **Step 10: Commit Task 1**

Run:

```bash
git add packages/shared/rallar-match packages/shared/mod.ts packages/tests/shared/rallar-match.test.ts
git commit -m "feat: add shared rallar match helpers"
```

---

### Task 2: Browser-Director Match Support Wrapper

**Files:**

- Create: `packages/shared-web/game/match-support.ts`
- Modify: `packages/shared-web/game/mod.ts`
- Test: `packages/tests/shared-web/rallar-browser-match-support.test.ts`

**Interfaces:**

- Consumes:
  - `createRallarGameMatch`, `RallarGameMatchConfig`, `RallarGameMatchHandle`, `RallarGameSendResult` from `@shared-web/game/mod.ts`.
  - `deriveRallarMatchParticipants`, `deriveRallarMatchStandings`, `createRallarMatchResult` from `@shared/rallar-match/mod.ts`.
- Produces:
  - `createRallarBrowserMatch`
  - `RallarBrowserMatchConfig<TCommand, TSnapshot, TEvent, TPresence>`
  - `RallarBrowserMatchHandle<TCommand, TSnapshot, TEvent, TPresence>`
  - `RallarBrowserMatchDependencies<TCommand, TSnapshot, TEvent, TPresence>`

- [x] **Step 1: Write failing browser wrapper tests**

Create `packages/tests/shared-web/rallar-browser-match-support.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
    createRallarBrowserMatch,
    type RallarBrowserMatchDependencies,
} from '@shared-web/game/mod.ts';
import type {
    RallarGameMatchConfig,
    RallarGameMatchHandle,
    RallarGameMatchStatus,
} from '@shared-web/game/mod.ts';

type Command = Readonly<{ kind: 'move'; x: number }>;
type Snapshot = Readonly<{ tick: number }>;
type Event = Readonly<{ kind: 'accepted' }>;

describe('Rallar browser match support', () => {
    it('creates a browser-director match from the Rallar Game match helper', async () => {
        const game = fakeGameMatch();
        const createGameMatch = vi.fn(() => game);
        const match = createRallarBrowserMatch<Command, Snapshot, Event>({
            rallar: fakeRallarFacade(),
            protocol: 'example.match.v1',
            topicId: 'room.example.match',
            matchId: 'match-1',
            readSnapshot: () => ({ tick: 1 }),
        }, {
            createGameMatch,
            nowEpochMs: () => 2_000,
            resultId: () => 'result-1',
        });

        await match.start();

        expect(createGameMatch).toHaveBeenCalledWith(
            expect.objectContaining({
                protocol: 'example.match.v1',
                topicId: 'room.example.match',
            }),
        );
        expect(game.start).toHaveBeenCalledOnce();
    });

    it('submits commands through the intent lane', async () => {
        const game = fakeGameMatch();
        const match = createRallarBrowserMatch<Command, Snapshot, Event>({
            rallar: fakeRallarFacade(),
            protocol: 'example.match.v1',
            topicId: 'room.example.match',
            matchId: 'match-1',
        }, {
            createGameMatch: () => game,
        });

        await expect(match.submitCommand({ kind: 'move', x: 3 })).resolves
            .toEqual({ status: 'sent', transport: 'local' });
        expect(game.sendIntent).toHaveBeenCalledWith({ kind: 'move', x: 3 });
    });

    it('derives participants and standings from app-provided metrics', () => {
        const game = fakeGameMatch();
        const match = createRallarBrowserMatch<Command, Snapshot, Event>({
            rallar: fakeRallarFacade(),
            protocol: 'example.match.v1',
            topicId: 'room.example.match',
            matchId: 'match-1',
            readStandingRows: () => [
                {
                    participantId: 'principal-a',
                    principalId: 'principal-a',
                    sessionIds: ['session-a'],
                    metrics: { points: 20 },
                },
                {
                    participantId: 'principal-b',
                    principalId: 'principal-b',
                    sessionIds: ['session-b'],
                    metrics: { points: 10 },
                },
            ],
        }, {
            createGameMatch: () => game,
        });

        expect(match.standings()).toMatchObject([
            { participantId: 'principal-a', rank: 1 },
            { participantId: 'principal-b', rank: 2 },
        ]);
    });

    it('finalizes a room-trusted result for browser-director matches', () => {
        const game = fakeGameMatch();
        const match = createRallarBrowserMatch<Command, Snapshot, Event>({
            rallar: fakeRallarFacade(),
            protocol: 'example.match.v1',
            topicId: 'room.example.match',
            matchId: 'match-1',
            readStandingRows: () => [
                {
                    participantId: 'principal-a',
                    principalId: 'principal-a',
                    sessionIds: ['session-a'],
                    metrics: { points: 20 },
                },
            ],
        }, {
            createGameMatch: () => game,
            nowEpochMs: () => 2_000,
            resultId: () => 'result-1',
        });

        expect(match.finalizeResult({ reason: 'complete' })).toMatchObject({
            resultId: 'result-1',
            matchId: 'match-1',
            trust: 'room-trusted',
            protocol: 'example.match.v1',
            summary: { reason: 'complete' },
            standings: [{ participantId: 'principal-a', rank: 1 }],
        });
    });
});

function fakeGameMatch(): RallarGameMatchHandle<
    Command,
    Command,
    Snapshot,
    Event,
    Command
> {
    const status: RallarGameMatchStatus = {
        phase: 'active',
        protocol: 'example.match.v1',
        topicId: 'room.example.match',
        roomId: 'room-1',
        roomRef: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
        },
        localPeerId: 'session-a',
        directorPeerId: 'session-a',
        directorEpoch: 4,
        directorIsFresh: true,
        directorAuthority: 'active',
        egress: { reliable: 'ready', realtime: 'ready' },
        recovery: { status: 'idle' },
        started: true,
        stopped: false,
        updatedAtEpochMs: 1_000,
    };

    return {
        start: vi.fn(async () => status),
        stop: vi.fn(),
        status: vi.fn(() => status),
        diagnostics: vi.fn(() => ({
            generatedAtEpochMs: 1_000,
            phase: 'active',
            roomId: 'room-1',
            localPeerId: 'session-a',
            directorPeerId: 'session-a',
            directorEpoch: 4,
            directorIsFresh: true,
            directorAuthority: 'active',
            egress: { reliable: 'ready', realtime: 'ready' },
            recovery: { status: 'idle' },
            knownPeerIds: [],
            readyPeerIds: [],
            notReadyPeerIds: [],
            capabilityCount: 0,
            rtcPeerCount: 0,
            realtimeHealth: [],
            issues: [],
        })),
        canAppointDirector: vi.fn(),
        reportCapability: vi.fn(),
        election: vi.fn(),
        appointIfElected: vi.fn(),
        waitForReadyLanes: vi.fn(),
        sendInput: vi.fn(),
        sendPresence: vi.fn(),
        sendIntent: vi.fn(async () => ({ status: 'sent', transport: 'local' })),
        publishSnapshot: vi.fn(),
        publishEvent: vi.fn(),
        requestSync: vi.fn(),
        onPresence: vi.fn(() => () => undefined),
        onStatus: vi.fn(() => () => undefined),
    } as RallarGameMatchHandle<Command, Command, Snapshot, Event, Command>;
}

function fakeRallarFacade(): RallarGameMatchConfig<
    Command,
    Command,
    Snapshot,
    Event,
    Command
>['rallar'] {
    return {
        session: () => ({
            clientId: 'principal-a',
            sessionId: 'session-a',
            username: 'Ada',
            token: 'token',
            issuedAtEpochMs: 1,
            expiresAtEpochMs: 10_000,
        }),
        subscriptions: () => ({
            add() {
                return this;
            },
            unsubscribe() {
                return undefined;
            },
        }),
        rooms: {
            state: () => ({
                rooms: [],
                currentRoomId: 'room-1',
                currentRoomRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1',
                },
                members: [
                    {
                        principalId: 'principal-a',
                        username: 'Ada',
                        role: 'owner',
                        status: 'active',
                        isOwner: true,
                        isOnline: true,
                        sessionIds: ['session-a'],
                    },
                ],
            }),
            onChange: () => () => undefined,
        },
        people: {
            state: () => ({ people: [] }),
            onChange: () => () => undefined,
        },
        director: {
            status: () => ({
                roomId: 'room-1',
                roomRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1',
                },
                isDirector: true,
                isFresh: true,
                appointment: {
                    version: 1,
                    mode: 'appointed-spa',
                    sessionId: 'session-a',
                    principalId: 'principal-a',
                    epoch: 4,
                    appointedAtEpochMs: 1_000,
                    heartbeatTtlMs: 5_000,
                },
                freshness: 'fresh',
            }),
            appoint: vi.fn(),
            resign: vi.fn(),
            onStatus: () => () => undefined,
            createRelay: vi.fn(),
        },
        rtc: {
            status: () => ({
                sessionId: 'session-a',
                laneId: 'game-input',
                knownPeerIds: [],
                activePeerIds: [],
                peerIdsWithNoReconnectableLanes: [],
                readyPeerIds: [],
                peers: [],
            }),
            onStatus: () => () => undefined,
            waitForRoomLane: vi.fn(),
        },
        realtime: {
            sendJson: vi.fn(),
            onJson: () => () => undefined,
            health: () => [],
            room: vi.fn(),
        },
        messages: {
            ws: {
                send: vi.fn(),
                onMessage: () => () => undefined,
            },
            rtc: {
                onMessage: () => () => undefined,
            },
            room: vi.fn(),
        },
        ws: {
            status: () => ({
                connectState: 'connected',
                readyState: 'open',
                isOpen: true,
                reconnecting: false,
                reconnectEnabled: true,
                reconnectAttempts: 0,
                maxReconnectAttempts: 5,
                reconnectExhausted: false,
            }),
        },
    } as RallarGameMatchConfig<Command, Command, Snapshot, Event, Command>['rallar'];
}
```

- [x] **Step 2: Run the failing browser wrapper tests**

Run:

```bash
npx vitest run packages/tests/shared-web/rallar-browser-match-support.test.ts
```

Expected: FAIL because `createRallarBrowserMatch` is not exported.

- [x] **Step 3: Implement `match-support.ts`**

Create `packages/shared-web/game/match-support.ts` with these API names:

```ts
import type { RallarMatchResult, RallarMatchStandingRow } from '@shared/rallar-match/mod.ts';
import {
    createRallarMatchResult,
    deriveRallarMatchParticipants,
    deriveRallarMatchStandings,
} from '@shared/rallar-match/mod.ts';
import { createRallarGameMatch } from './match.ts';
import type {
    RallarGameMatchConfig,
    RallarGameMatchHandle,
    RallarGameSendResult,
} from './types.ts';

export type RallarBrowserMatchConfig<
    TCommand,
    TSnapshot,
    TEvent,
    TPresence = TCommand,
> =
    Omit<
        RallarGameMatchConfig<TCommand, TCommand, TSnapshot, TEvent, TPresence>,
        'onInput' | 'onIntent'
    > &
    Readonly<{
        matchId: string;
        startedAtEpochMs?: number;
        onCommand?: RallarGameMatchConfig<
            TCommand,
            TCommand,
            TSnapshot,
            TEvent,
            TPresence
        >['onIntent'];
        readStandingRows?: () => readonly RallarMatchStandingRow[];
    }>;

export type RallarBrowserMatchDependencies<
    TCommand,
    TSnapshot,
    TEvent,
    TPresence = TCommand,
> = Readonly<{
    createGameMatch?: (
        config: RallarGameMatchConfig<
            TCommand,
            TCommand,
            TSnapshot,
            TEvent,
            TPresence
        >,
    ) => RallarGameMatchHandle<TCommand, TCommand, TSnapshot, TEvent, TPresence>;
    nowEpochMs?: () => number;
    resultId?: () => string;
}>;

export type RallarBrowserMatchHandle<
    TCommand,
    TSnapshot,
    TEvent,
    TPresence = TCommand,
> = Readonly<{
    game: RallarGameMatchHandle<TCommand, TCommand, TSnapshot, TEvent, TPresence>;
    start: RallarGameMatchHandle<TCommand, TCommand, TSnapshot, TEvent, TPresence>['start'];
    stop: RallarGameMatchHandle<TCommand, TCommand, TSnapshot, TEvent, TPresence>['stop'];
    status: RallarGameMatchHandle<TCommand, TCommand, TSnapshot, TEvent, TPresence>['status'];
    diagnostics: RallarGameMatchHandle<TCommand, TCommand, TSnapshot, TEvent, TPresence>['diagnostics'];
    submitCommand(command: TCommand): Promise<RallarGameSendResult>;
    participants: typeof deriveRallarMatchParticipants;
    standings(): ReturnType<typeof deriveRallarMatchStandings>;
    finalizeResult<TSummary>(summary: TSummary): RallarMatchResult<TSummary>;
}>;

export function createRallarBrowserMatch<
    TCommand,
    TSnapshot,
    TEvent,
    TPresence = TCommand,
>(
    config: RallarBrowserMatchConfig<TCommand, TSnapshot, TEvent, TPresence>,
    dependencies: RallarBrowserMatchDependencies<
        TCommand,
        TSnapshot,
        TEvent,
        TPresence
    > = {},
): RallarBrowserMatchHandle<TCommand, TSnapshot, TEvent, TPresence> {
    const createGameMatch = dependencies.createGameMatch ?? createRallarGameMatch;
    const gameConfig: RallarGameMatchConfig<
        TCommand,
        TCommand,
        TSnapshot,
        TEvent,
        TPresence
    > = {
        rallar: config.rallar,
        protocol: config.protocol,
        topicId: config.topicId,
        roomId: config.roomId,
        roomRef: config.roomRef,
        laneIds: config.laneIds,
        typeIds: config.typeIds,
        heartbeatTtlMs: config.heartbeatTtlMs,
        capabilityTtlMs: config.capabilityTtlMs,
        readCapability: config.readCapability,
        resolvePeerIds: config.resolvePeerIds,
        scoreHost: config.scoreHost,
        directorAppointmentPolicy: config.directorAppointmentPolicy,
        canAppointDirector: config.canAppointDirector,
        readSnapshot: config.readSnapshot,
        autoSnapshotIntervalMs: config.autoSnapshotIntervalMs,
        onPresence: config.onPresence,
        onInput: config.onCommand,
        onIntent: config.onCommand,
        onSnapshot: config.onSnapshot,
        onEvent: config.onEvent,
        onSyncRequest: config.onSyncRequest,
    };
    const game = createGameMatch(gameConfig);
    const nowEpochMs = dependencies.nowEpochMs ?? Date.now;
    const resultId = dependencies.resultId ??
        (() => `${config.matchId}:${nowEpochMs()}`);

    return {
        game,
        start: game.start,
        stop: game.stop,
        status: game.status,
        diagnostics: game.diagnostics,
        submitCommand: (command) => game.sendIntent(command),
        participants: deriveRallarMatchParticipants,
        standings: () =>
            deriveRallarMatchStandings({
                rows: config.readStandingRows?.() ?? [],
            }),
        finalizeResult: (summary) => {
            const status = game.status();
            const roomRef = status.roomRef ??
                config.roomRef ??
                config.rallar.rooms.state().currentRoomRef;
            if (!roomRef) {
                throw new Error('Cannot finalize a Rallar match result without a roomRef.');
            }

            return createRallarMatchResult({
                resultId: resultId(),
                matchId: config.matchId,
                roomRef,
                protocol: config.protocol,
                authority: {
                    kind: 'browser-director',
                    id: status.directorPeerId ?? status.localPeerId ?? 'unknown-director',
                    epoch: status.directorEpoch ?? 0,
                    sessionId: status.directorPeerId ?? status.localPeerId,
                },
                trust: 'room-trusted',
                startedAtEpochMs: config.startedAtEpochMs,
                finishedAtEpochMs: nowEpochMs(),
                standings: deriveRallarMatchStandings({
                    rows: config.readStandingRows?.() ?? [],
                }),
                summary,
            });
        },
    };
}
```

- [x] **Step 4: Export browser match support**

Modify `packages/shared-web/game/mod.ts`:

```ts
export * from './match-support.ts';
```

- [x] **Step 5: Run browser wrapper tests and shared-web typecheck**

Run:

```bash
npx vitest run packages/tests/shared-web/rallar-browser-match-support.test.ts
npx tsc -p packages/shared-web/tsconfig.json --noEmit
```

Expected: both commands PASS.

- [x] **Step 6: Commit Task 2**

Run:

```bash
git add packages/shared-web/game/match-support.ts packages/shared-web/game/mod.ts packages/tests/shared-web/rallar-browser-match-support.test.ts
git commit -m "feat: add browser match support wrapper"
```

---

### Task 3: Server-Authority Browser Match Support

**Files:**

- Create: `packages/shared-web/game/authority-match-support.ts`
- Modify: `packages/shared-web/game/mod.ts`
- Test: `packages/tests/shared-web/rallar-authority-match-support.test.ts`

**Interfaces:**

- Consumes:
  - `createRallarGameAuthorityClient` and authority client types from `@shared-web/game/mod.ts`.
  - `deriveRallarMatchStandings` from `@shared/rallar-match/mod.ts`.
- Produces:
  - `createRallarAuthorityBrowserMatch`
  - `RallarAuthorityBrowserMatchConfig<TCommand, TSnapshot, TEvent, TPresence>`
  - `RallarAuthorityBrowserMatchHandle<TCommand, TSnapshot, TEvent, TPresence>`

- [x] **Step 1: Write failing authority browser wrapper tests**

Create `packages/tests/shared-web/rallar-authority-match-support.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
    createRallarAuthorityBrowserMatch,
    type RallarGameAuthorityClientHandle,
} from '@shared-web/game/mod.ts';
import type { RallarGameAuthorityRef } from '@shared/rallar-game/mod.ts';

type Command = Readonly<{ kind: 'claim'; id: string }>;
type Snapshot = Readonly<{ tick: number }>;
type Event = Readonly<{ kind: 'claimed' }>;
type Presence = Readonly<{ ready: boolean }>;

const authority: RallarGameAuthorityRef = {
    kind: 'server',
    id: 'server-1',
    epoch: 3,
};

describe('Rallar authority browser match support', () => {
    it('delegates commands to Rallar Game Authority client', async () => {
        const client = fakeAuthorityClient();
        const match = createRallarAuthorityBrowserMatch<
            Command,
            Snapshot,
            Event,
            Presence
        >({
            rallar: {} as never,
            protocol: 'example.authority.v1',
            topicId: 'room.example.authority',
            authority,
        }, {
            createAuthorityClient: () => client,
        });

        await expect(match.submitCommand({ kind: 'claim', id: 'relic-1' }))
            .resolves.toEqual({ status: 'sent', transport: 'ws', seq: 1 });
        expect(client.sendCommand).toHaveBeenCalledWith(
            { kind: 'claim', id: 'relic-1' },
            undefined,
        );
    });

    it('derives standings from app-provided server-authority metrics', () => {
        const client = fakeAuthorityClient();
        const match = createRallarAuthorityBrowserMatch<
            Command,
            Snapshot,
            Event,
            Presence
        >({
            rallar: {} as never,
            protocol: 'example.authority.v1',
            topicId: 'room.example.authority',
            authority,
            roomRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1',
            },
            readStandingRows: () => [
                {
                    participantId: 'principal-a',
                    principalId: 'principal-a',
                    sessionIds: ['session-a'],
                    metrics: { points: 5 },
                },
            ],
        }, {
            createAuthorityClient: () => client,
        });

        expect(match.standings()).toMatchObject([
            { participantId: 'principal-a', rank: 1 },
        ]);
    });
});

function fakeAuthorityClient(): RallarGameAuthorityClientHandle<
    Command,
    Snapshot,
    Event,
    Presence
> {
    return {
        start: vi.fn(async () => ({
            phase: 'ready',
            protocol: 'example.authority.v1',
            topicId: 'room.example.authority',
            roomId: 'room-1',
            localPeerId: 'session-a',
            authority,
            started: true,
            stopped: false,
            pendingCommandCount: 0,
            peerAssist: {
                enabled: false,
                snapshotRepairEnabled: false,
                readyPeerIds: [],
            },
            updatedAtEpochMs: 1_000,
        })),
        stop: vi.fn(),
        status: vi.fn(() => ({
            phase: 'ready',
            protocol: 'example.authority.v1',
            topicId: 'room.example.authority',
            roomId: 'room-1',
            localPeerId: 'session-a',
            authority,
            started: true,
            stopped: false,
            pendingCommandCount: 0,
            peerAssist: {
                enabled: false,
                snapshotRepairEnabled: false,
                readyPeerIds: [],
            },
            updatedAtEpochMs: 1_000,
        })),
        diagnostics: vi.fn(),
        sendCommand: vi.fn(async () => ({
            status: 'sent',
            transport: 'ws',
            seq: 1,
        })),
        requestSync: vi.fn(),
        publishPresence: vi.fn(),
        publishSnapshotRepair: vi.fn(),
        onStatus: vi.fn(() => () => undefined),
    };
}
```

- [x] **Step 2: Run the failing authority wrapper tests**

Run:

```bash
npx vitest run packages/tests/shared-web/rallar-authority-match-support.test.ts
```

Expected: FAIL because `createRallarAuthorityBrowserMatch` is not exported.

- [x] **Step 3: Implement `authority-match-support.ts`**

Create `packages/shared-web/game/authority-match-support.ts` with these names:

```ts
import type { RallarMatchStandingRow } from '@shared/rallar-match/mod.ts';
import { deriveRallarMatchStandings } from '@shared/rallar-match/mod.ts';
import {
    createRallarGameAuthorityClient,
    type RallarGameAuthorityClientConfig,
    type RallarGameAuthorityClientHandle,
} from './authority-client.ts';

export type RallarAuthorityBrowserMatchConfig<
    TCommand,
    TSnapshot,
    TEvent,
    TPresence = unknown,
> =
    RallarGameAuthorityClientConfig<TCommand, TSnapshot, TEvent, TPresence> &
    Readonly<{
        readStandingRows?: () => readonly RallarMatchStandingRow[];
    }>;

export type RallarAuthorityBrowserMatchDependencies<
    TCommand,
    TSnapshot,
    TEvent,
    TPresence = unknown,
> = Readonly<{
    createAuthorityClient?: (
        config: RallarGameAuthorityClientConfig<
            TCommand,
            TSnapshot,
            TEvent,
            TPresence
        >,
    ) => RallarGameAuthorityClientHandle<
        TCommand,
        TSnapshot,
        TEvent,
        TPresence
    >;
}>;

export type RallarAuthorityBrowserMatchHandle<
    TCommand,
    TSnapshot,
    TEvent,
    TPresence = unknown,
> = Readonly<{
    client: RallarGameAuthorityClientHandle<
        TCommand,
        TSnapshot,
        TEvent,
        TPresence
    >;
    start: RallarGameAuthorityClientHandle<
        TCommand,
        TSnapshot,
        TEvent,
        TPresence
    >['start'];
    stop: RallarGameAuthorityClientHandle<
        TCommand,
        TSnapshot,
        TEvent,
        TPresence
    >['stop'];
    status: RallarGameAuthorityClientHandle<
        TCommand,
        TSnapshot,
        TEvent,
        TPresence
    >['status'];
    diagnostics: RallarGameAuthorityClientHandle<
        TCommand,
        TSnapshot,
        TEvent,
        TPresence
    >['diagnostics'];
    submitCommand(
        command: TCommand,
        options?: { key?: string },
    ): ReturnType<
        RallarGameAuthorityClientHandle<
            TCommand,
            TSnapshot,
            TEvent,
            TPresence
        >['sendCommand']
    >;
    standings(): ReturnType<typeof deriveRallarMatchStandings>;
}>;

export function createRallarAuthorityBrowserMatch<
    TCommand,
    TSnapshot,
    TEvent,
    TPresence = unknown,
>(
    config: RallarAuthorityBrowserMatchConfig<
        TCommand,
        TSnapshot,
        TEvent,
        TPresence
    >,
    dependencies: RallarAuthorityBrowserMatchDependencies<
        TCommand,
        TSnapshot,
        TEvent,
        TPresence
    > = {},
): RallarAuthorityBrowserMatchHandle<TCommand, TSnapshot, TEvent, TPresence> {
    const createAuthorityClient = dependencies.createAuthorityClient ??
        createRallarGameAuthorityClient;
    const client = createAuthorityClient(config);

    return {
        client,
        start: client.start,
        stop: client.stop,
        status: client.status,
        diagnostics: client.diagnostics,
        submitCommand: (command, options) => client.sendCommand(command, options),
        standings: () =>
            deriveRallarMatchStandings({
                rows: config.readStandingRows?.() ?? [],
            }),
    };
}
```

> **Intentional repository-safety update:** The browser authority wrapper does
> not construct `server-validated` results. Existing Rallar Game Authority
> transports commands to server-owned domain code, so Task 4 is the sole V1
> constructor for that trust level. Applications transport the resulting
> envelope through their existing app-owned event, message, or storage path.

- [x] **Step 4: Export authority match support**

Modify `packages/shared-web/game/mod.ts`:

```ts
export * from './authority-match-support.ts';
```

- [x] **Step 5: Run authority wrapper tests and shared-web typecheck**

Run:

```bash
npx vitest run packages/tests/shared-web/rallar-authority-match-support.test.ts
npx tsc -p packages/shared-web/tsconfig.json --noEmit
```

Expected: both commands PASS.

- [x] **Step 6: Commit Task 3**

Run:

```bash
git add packages/shared-web/game/authority-match-support.ts packages/shared-web/game/mod.ts packages/tests/shared-web/rallar-authority-match-support.test.ts
git commit -m "feat: add authority browser match support"
```

---

### Task 4: Server-Validated Result Helper

**Files:**

- Create: `packages/shared-server/game/match-result.ts`
- Modify: `packages/shared-server/game/mod.ts`
- Test: `packages/tests/shared-server/rallar-match-result.test.ts`

**Interfaces:**

- Consumes:
  - `RallarGameAuthorityRef` from `@shared/rallar-game/mod.ts`.
  - `createRallarMatchResult` from `@shared/rallar-match/mod.ts`.
- Produces:
  - `createRallarServerValidatedMatchResult(input)`
  - `RallarServerValidatedMatchResultInput<TSummary>`

- [x] **Step 1: Write failing server result helper tests**

Create `packages/tests/shared-server/rallar-match-result.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createRallarServerValidatedMatchResult } from '@shared-server/game/mod.ts';

describe('Rallar server match result helper', () => {
    it('creates server-validated result envelopes', () => {
        const result = createRallarServerValidatedMatchResult({
            resultId: 'result-1',
            matchId: 'match-1',
            roomRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1',
            },
            protocol: 'example.authority.v1',
            authority: {
                kind: 'server',
                id: 'server-1',
                epoch: 2,
            },
            finishedAtEpochMs: 5_000,
            standings: [
                {
                    participantId: 'principal-a',
                    principalId: 'principal-a',
                    sessionIds: ['session-a'],
                    rank: 1,
                    tieGroup: 1,
                    metrics: { points: 9 },
                },
            ],
            summary: { acceptedCommands: 3 },
        });

        expect(result.trust).toBe('server-validated');
        expect(result.idempotencyKey).toBe('match-1:server:server-1:2:5000');
    });

    it('rejects browser-director authority at runtime', () => {
        expect(() => createRallarServerValidatedMatchResult({
            resultId: 'result-1',
            matchId: 'match-1',
            roomRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1',
            },
            protocol: 'example.authority.v1',
            authority: {
                kind: 'browser-director',
                id: 'session-1',
                epoch: 2,
            },
            finishedAtEpochMs: 5_000,
            standings: [],
            summary: { acceptedCommands: 0 },
        } as never)).toThrow(
            'Server-validated Rallar match results require server authority.',
        );
    });
});
```

- [x] **Step 2: Run the failing server result helper tests**

Run:

```bash
npx vitest run packages/tests/shared-server/rallar-match-result.test.ts
```

Expected: FAIL because `createRallarServerValidatedMatchResult` is not exported.

- [x] **Step 3: Implement `match-result.ts`**

Create `packages/shared-server/game/match-result.ts`:

```ts
import type {
    RallarMatchResult,
    RallarMatchResultInput,
} from '@shared/rallar-match/mod.ts';
import { createRallarMatchResult } from '@shared/rallar-match/mod.ts';
import type { RallarGameAuthorityRef } from '@shared/rallar-game/mod.ts';

export type RallarServerValidatedMatchResultInput<TSummary = unknown> =
    Omit<RallarMatchResultInput<TSummary>, 'authority' | 'trust'> &
    Readonly<{
        authority: RallarGameAuthorityRef & Readonly<{ kind: 'server' }>;
    }>;

export function createRallarServerValidatedMatchResult<TSummary>(
    input: RallarServerValidatedMatchResultInput<TSummary>,
): RallarMatchResult<TSummary> {
    if (input.authority.kind !== 'server') {
        throw new Error(
            'Server-validated Rallar match results require server authority.',
        );
    }

    return createRallarMatchResult({
        resultId: input.resultId,
        matchId: input.matchId,
        roomRef: input.roomRef,
        protocol: input.protocol,
        authority: input.authority,
        trust: 'server-validated',
        startedAtEpochMs: input.startedAtEpochMs,
        finishedAtEpochMs: input.finishedAtEpochMs,
        standings: input.standings,
        summary: input.summary,
        idempotencyKey: input.idempotencyKey,
    });
}
```

- [x] **Step 4: Export server result helper**

Modify `packages/shared-server/game/mod.ts`:

```ts
export * from './match-result.ts';
```

- [x] **Step 5: Run server helper tests and shared-server typecheck**

Run:

```bash
npx vitest run packages/tests/shared-server/rallar-match-result.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
```

Expected: both commands PASS.

- [x] **Step 6: Commit Task 4**

Run:

```bash
git add packages/shared-server/game/match-result.ts packages/shared-server/game/mod.ts packages/tests/shared-server/rallar-match-result.test.ts
git commit -m "feat: add server match result helper"
```

---

### Task 5: Public API Snapshots And Documentation

**Files:**

- Modify: `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
- Modify: `docs/rallar-api-reference.md`

**Interfaces:**

- Consumes:
  - Exports added in Tasks 1-4.
- Produces:
  - Updated public API expectations for `packages/shared-web/game/mod.ts`.
  - Documentation explaining that match support is optional and does not include leaderboards or point rules.

- [x] **Step 1: Update shared-web public API snapshot expectations**

Modify the `packages/shared-web/game/mod.ts` expected values in `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts` by adding these value exports:

```ts
'createRallarAuthorityBrowserMatch',
'createRallarBrowserMatch',
```

Add these type exports to the same expected `types` array:

```ts
'RallarAuthorityBrowserMatchConfig',
'RallarAuthorityBrowserMatchDependencies',
'RallarAuthorityBrowserMatchHandle',
'RallarBrowserMatchConfig',
'RallarBrowserMatchDependencies',
'RallarBrowserMatchHandle',
```

Add these star exports to the same expected `starExports` array:

```ts
'./authority-match-support.ts',
'./match-support.ts',
```

- [x] **Step 2: Write documentation section**

Append this section to `docs/rallar-api-reference.md` near the existing Director and Rallar Game material:

```md
### Optional Match Support

Rallar match support is an optional layer for room-based browser activities. It
does not add a top-level `rallar.match` facade in V1. Import named helpers from
`@shared/rallar-match/mod.ts` and `@shared-web/game/mod.ts`.

Use `createRallarBrowserMatch` for browser-director matches where a live
room session holds the director lease and routes commands, snapshots, events,
participants, standings, and room-trusted result envelopes.

Use `createRallarAuthorityBrowserMatch` when the authoritative game or
activity loop lives behind Rallar Game Authority. Browser clients do not mint
`server-validated` results. Server-owned domain code creates those envelopes
with `createRallarServerValidatedMatchResult(...)` after validating the match.
Its `submitCommand(...)` delegates app-owned commands through Rallar Game
Authority, while `standings()` projects app-provided `readStandingRows` metrics;
Rallar does not calculate scores.

Rallar provides participant derivation, standings projection, result envelopes,
and diagnostics. The application still owns command legality, scoring rules,
win conditions, persistence, rewards, global leaderboards, and anti-cheat.
```

- [x] **Step 3: Run public API and doc-related tests**

Run:

```bash
npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts
```

Expected: PASS.

- [x] **Step 4: Commit Task 5**

Run:

```bash
git add packages/tests/shared-web/shared-web-public-api-snapshots.test.ts docs/rallar-api-reference.md
git commit -m "docs: document optional rallar match support"
```

---

### Task 6: Final Validation

**Files:**

- No new files.

**Interfaces:**

- Consumes:
  - All exports and tests from Tasks 1-5.
- Produces:
  - Final validation evidence for shared, shared-web, and shared-server surfaces.

- [x] **Step 1: Run focused match tests**

Run:

```bash
npx vitest run packages/tests/shared/rallar-match.test.ts packages/tests/shared-web/rallar-browser-match-support.test.ts packages/tests/shared-web/rallar-authority-match-support.test.ts packages/tests/shared-server/rallar-match-result.test.ts
```

Expected: PASS.

- [x] **Step 2: Run adjacent existing Rallar Game tests**

Run:

```bash
npx vitest run packages/tests/shared-web/rallar-game-match.test.ts packages/tests/shared-web/rallar-game-diagnostics.test.ts packages/tests/shared-web/rallar-game-authority-client.test.ts packages/tests/shared-server/rallar-game-authority-server.test.ts
```

Expected: PASS.

- [x] **Step 3: Run public surface and package typechecks**

Run:

```bash
npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
```

Expected: all commands PASS.

- [x] **Step 4: Record plan-only final validation**

No code or documentation fix was required. Append the dated final-validation
record under Implementation Progress and commit that tracker-only record:

```bash
git add plans/rallar-browser-match-support-implementation-plan.md
git commit -m "test: validate rallar match support"
```

---

## Scope Coverage Review

- Participant identity: Task 1 implements principal-first participants with a custom resolver.
- Standings projection: Task 1 implements generic metrics sorting and rank ties.
- Result envelopes: Task 1 implements generic results; Task 4 adds server-validated helper.
- Browser-director match wiring: Task 2 wraps `createRallarGameMatch`.
- Server-authority browser wiring: Task 3 wraps `createRallarGameAuthorityClient`.
- Diagnostics: Task 1 adds generic diagnostics; browser/server wrappers can surface existing Rallar Game diagnostics through their underlying handles.
- Public exports: Tasks 1, 2, 3, and 4 update barrels; Task 5 updates shared-web public API snapshots.
- Docs: Task 5 documents optional support and game-rule boundaries.
- Testing: Tasks 1-6 include focused tests, adjacent Rallar Game tests, public API snapshots, browser bundle checks, and typechecks.

## Execution Notes

Implement Tasks 1-6 as written. Any expansion into consumer migration, formal team standings, Rallar-owned persistence, or REST APIs requires a separate plan revision before implementation.

## Implementation Progress

### Preflight - 2026-07-10T12:25:39+02:00

- Completed: created isolated worktree `/private/tmp/ar-eye-hunter-rallar-browser-match` on branch `codex/rallar-browser-match-support`; installed dependencies; read the complete plan and relevant Rallar package, realtime, game, code-writing, and testing guidance; inspected existing match APIs and canonical documentation.
- Files changed: this implementation plan only; no feature code has been written.
- Commands passed: `npm install`; baseline Vitest run covering seven adjacent Rallar Game and shared-web public-surface test files (`54` tests); `npx tsc -p packages/shared/tsconfig.json --noEmit`; `npx tsc -p packages/shared-web/tsconfig.json --noEmit`; `npx tsc -p packages/shared-server/tsconfig.json --noEmit`.
- Resolved plan correction: the approved server-side validation decision governs the stale Task 3 sample. Task 3 no longer constructs results in the browser, and Task 4 now restricts and validates server authority before assigning `server-validated` trust.
- Follow-up validation: all Task 1-6 RED/GREEN checks and the final validation matrix remain.

### Task 1 - 2026-07-10T12:32:00+02:00

- Completed: added runtime-agnostic shared Rallar match contracts plus deterministic participant, standings, result-envelope, and diagnostics helpers; exported the new `rallar-match` package through `packages/shared/mod.ts`.
- Files changed: `packages/shared/rallar-match/types.ts`, `packages/shared/rallar-match/participants.ts`, `packages/shared/rallar-match/standings.ts`, `packages/shared/rallar-match/results.ts`, `packages/shared/rallar-match/diagnostics.ts`, `packages/shared/rallar-match/mod.ts`, `packages/shared/mod.ts`, and `packages/tests/shared/rallar-match.test.ts`.
- Commands: RED `npx vitest run packages/tests/shared/rallar-match.test.ts` failed as expected because `@shared/rallar-match/mod.ts` did not exist; GREEN `npx vitest run packages/tests/shared/rallar-match.test.ts` passed (1 file, 5 tests); `npx tsc -p packages/shared/tsconfig.json --noEmit` passed.
- Blockers: none.
- Remaining validation: Tasks 2-6 and their final focused match, adjacent Rallar Game, public-surface, and shared/shared-web/shared-server typecheck matrix remain.

### Task 1 Review Fix - 2026-07-10T12:39:00+02:00

- Fixed: percent-encoded each result idempotency-key component before joining with `:` so delimiter-bearing match and authority IDs cannot collide while ordinary keys retain their existing format.
- Files changed: `packages/shared/rallar-match/results.ts` and `packages/tests/shared/rallar-match.test.ts`.
- Validation: RED `npx vitest run packages/tests/shared/rallar-match.test.ts` reproduced the collision (1 failed, 5 passed); GREEN passed (1 file, 6 tests); `npx tsc -p packages/shared/tsconfig.json --noEmit` passed.

### Task 2 - 2026-07-10T12:45:00+02:00

- Completed: added the optional browser-director match wrapper over `createRallarGameMatch`; it maps commands to the existing intent lane, delegates participants and standings to `@shared/rallar-match`, and produces browser-director results labeled `room-trusted`.
- Files changed: `packages/shared-web/game/match-support.ts`, `packages/shared-web/game/mod.ts`, and `packages/tests/shared-web/rallar-browser-match-support.test.ts`.
- Commands: RED `npx vitest run packages/tests/shared-web/rallar-browser-match-support.test.ts` failed as expected (1 failed file, 5 failed tests) because `createRallarBrowserMatch` was not exported; GREEN passed (1 file, 5 tests); `npx tsc -p packages/shared-web/tsconfig.json --noEmit` passed with exit code `0` and no diagnostics.
- Blockers: none.
- Remaining validation: Tasks 3-6 and their focused match, adjacent Rallar Game, public-surface, and shared/shared-web/shared-server typecheck matrix remain.

### Task 3 - 2026-07-10T12:54:03+02:00

- Completed: added the browser-only server-authority match wrapper over `createRallarGameAuthorityClient`; it forwards authority-client lifecycle and diagnostics, forwards command options through `sendCommand`, and derives standings from app-provided rows through `@shared/rallar-match`.
- Files changed: `packages/shared-web/game/authority-match-support.ts`, `packages/shared-web/game/mod.ts`, `packages/tests/shared-web/rallar-authority-match-support.test.ts`, and this implementation plan.
- Commands: RED `npx vitest run packages/tests/shared-web/rallar-authority-match-support.test.ts` failed as expected (1 failed file, 2 failed tests) because `createRallarAuthorityBrowserMatch` was not exported; GREEN passed (1 file, 2 tests); `npx tsc -p packages/shared-web/tsconfig.json --noEmit` passed with exit code `0` and no diagnostics.
- Trust correction followed: this browser wrapper does not create or label any result as `server-validated`; Task 4 remains the sole V1 constructor for that server-owned trust level.
- Blockers: none.
- Remaining validation: Tasks 4-6 and their focused match, adjacent Rallar Game, public-surface, browser bundle-boundary, and shared/shared-web/shared-server typecheck matrix remain.

### Task 3 Review Fix - 2026-07-10T13:02:24+02:00

- Fixed: removed the unused `matchId` and `startedAtEpochMs` fields from `RallarAuthorityBrowserMatchConfig`; neither belonged to the browser authority-client lifecycle/command/standings contract after result finalization was deliberately excluded.
- Tests: strengthened the focused wrapper test to capture and assert the exact authority-client factory config, send a command with `{ key: 'command-1' }`, and exercise delegated `start`, `stop`, `status`, and `diagnostics` methods.
- Evidence: before the production type change, the strengthened Vitest suite passed (1 file, 2 tests), demonstrating the runtime delegations already worked. `npx tsc -p packages/shared-web/tsconfig.json --noEmit` also passed because that project excludes `packages/tests`; a temporary test-inclusive TypeScript project then failed with exactly two missing-`matchId` errors. After the config removal, focused Vitest, the shared-web typecheck, and the test-inclusive TypeScript check all passed.
- Scope: preserved the Task 3 trust correction. No result finalization, `server-validated` label, app change, top-level facade, or other task surface was added.
- Blockers: none.
- Remaining validation: Tasks 4-6 and their focused match, adjacent Rallar Game, public-surface, browser bundle-boundary, and shared/shared-web/shared-server typecheck matrix remain.

### Task 4 - 2026-07-10T13:08:08+02:00

- Completed: added the server-only `createRallarServerValidatedMatchResult` helper and exported it from `packages/shared-server/game/mod.ts`; it requires server authority before creating canonical `server-validated` result envelopes.
- Files changed: `packages/shared-server/game/match-result.ts`, `packages/shared-server/game/mod.ts`, and `packages/tests/shared-server/rallar-match-result.test.ts`.
- Commands: RED `npx vitest run packages/tests/shared-server/rallar-match-result.test.ts` failed as expected because `createRallarServerValidatedMatchResult` was not exported; GREEN passed (1 file, 2 tests); `npx tsc -p packages/shared-server/tsconfig.json --noEmit` passed.
- Commit: `b929cf6 feat: add server match result helper` at `2026-07-10T13:08:08+02:00`.
- Blockers: none.
- Remaining validation at this historical point: Task 5 public API snapshot/documentation work and Task 6 focused match, adjacent Rallar Game, public-surface, typecheck, consumer-build, and repository-hygiene validation remained.

### Task 5 - 2026-07-10T13:13:50+02:00

- Completed: refreshed the `packages/shared-web/game/mod.ts` public API snapshot for the optional browser-director and server-authority browser match wrappers, and added the canonical Optional Match Support reference beside Director.
- Files changed: `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`, `docs/rallar-api-reference.md`, and this implementation plan.
- Commands: RED `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts` failed as expected because the Task 2/3 exports were absent from the expected snapshot; GREEN passed (1 file, 8 tests).
- Documentation decision: kept one Optional Match Support section in `docs/rallar-api-reference.md`; it documents named optional imports, room-trusted browser-director results, the server-authority browser command/standings wrapper, the server-only validated-result helper, and application-owned scoring, persistence, leaderboards, and anti-cheat.
- Blockers: none.
- Remaining validation: Task 6 final focused match, adjacent Rallar Game, public-surface, browser bundle-boundary, and shared/shared-web/shared-server typecheck matrix remain.

### Task 5 Review Fix - 2026-07-10T13:18:43+02:00

- Fixed: clarified that `createRallarAuthorityBrowserMatch.submitCommand(...)` delegates app-owned commands through Rallar Game Authority, while `standings()` projects app-provided `readStandingRows` metrics and Rallar does not calculate scores.
- Files changed: `docs/rallar-api-reference.md`, this implementation plan, and `/private/tmp/rallar-match-sdd/task-5-report.md`.
- Validation: `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts` passed (1 file, 8 tests). Focused `rg` review confirmed matching command/standings wording in the canonical docs and Task 5 snippet, one Optional Match Support section, no browser-minted `server-validated` claim, and application-owned persistence, leaderboards, and anti-cheat.
- Blockers: none.
- Remaining validation: Task 6 final validation matrix remains.

### Task 6 Final Validation - 2026-07-10T13:24:20+02:00

- Completed: marked Task 6 Steps 1-4 complete. Validation found no regression, so no production code or documentation fix was needed; Step 4 records this plan-only validation instead of the former conditional fix path.
- Commands passed: `npx vitest run packages/tests/shared/rallar-match.test.ts packages/tests/shared-web/rallar-browser-match-support.test.ts packages/tests/shared-web/rallar-authority-match-support.test.ts packages/tests/shared-server/rallar-match-result.test.ts` (4 files, 15 passed, 0 failed); `npx vitest run packages/tests/shared-web/rallar-game-match.test.ts packages/tests/shared-web/rallar-game-diagnostics.test.ts packages/tests/shared-web/rallar-game-authority-client.test.ts packages/tests/shared-server/rallar-game-authority-server.test.ts` (4 files, 37 passed, 0 failed); `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts` (3 files, 17 passed, 0 failed); `npx tsc -p packages/shared/tsconfig.json --noEmit` (exit 0); `npx tsc -p packages/shared-web/tsconfig.json --noEmit` (exit 0); `npx tsc -p packages/shared-server/tsconfig.json --noEmit` (exit 0); `npm --workspace ar-eye-hunter-v1 run build` (exit 0); and `npm --workspace relic-hunters-v1 run build` (exit 0).
- Build warnings: both consumer builds emitted Vite's known chunks-larger-than-500-kB warning after successful production output; this is a pass under the repository testing guidance.
- Repository checks: `git diff --check` passed before and after the tracker update with no whitespace errors; `git status --short --branch` after the update reported only `M plans/rallar-browser-match-support-implementation-plan.md` on `codex/rallar-browser-match-support`.
- Skipped or unrun commands: none from the Task 6 required matrix or the required consumer builds. Remote/runtime/deployment validation was not run because it is outside this task's scope and no such command was requested.
- Blockers: none.
- Files changed: `plans/rallar-browser-match-support-implementation-plan.md` only; the external validation report at `/private/tmp/rallar-match-sdd/task-6-report.md` is not a repository change.
- Remaining validation: none for Tasks 1-6 within the approved local/package/consumer scope. Remote/runtime/deployment validation remains out of scope.
- Tasks 1-6 fully checked: Task 4 progress reconciliation had not yet been verified when this entry was first recorded; see the following audit correction for the verified full-scope status.

### Task 6 Audit Correction - 2026-07-10T13:26:51+02:00

- Corrected: reconciled all six unchecked Task 4 steps with the authoritative Task 4 report and commit `b929cf6` after the completion audit identified the omitted tracker record.
- Verified Task 4 evidence: the report records the expected RED failure, GREEN `1` file and `2` tests passed, shared-server typecheck pass, no blockers, and the implementation/export commit; `git show --stat b929cf6` confirms the three recorded Task 4 files.
- Full-scope status: Tasks 1-6 are fully checked only after this audit verification, for the approved local/package/consumer scope. Remote/runtime/deployment validation remains out of scope.
