import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
  configureGroupStateSnapshotRepository,
  findGroupStateSnapshotsBySessionIds,
  getAllGroupStateSnapshots,
  setGroupStateSnapshots,
} from '@shared/repository/group-state-snapshots-repository.ts';

type IndexedGroupFinder = (sessionIds: readonly string[]) => readonly GroupSnapshot[];

type RunResult = Readonly<{
  name: string;
  run: number;
  durationMs: number;
  groupCount: number;
  sessionsPerGroup: number;
  rttCount: number;
  matchedGroups: number;
  groupChecks?: number;
  sessionChecks?: number;
}>;

const OUT = readArg('--out') ?? 'tmp/perf/results/rtc-rtt-group-scan.json';
const GROUPS = Number(readArg('--groups') ?? '10000');
const SESSIONS_PER_GROUP = Number(readArg('--sessions-per-group') ?? '5');
const RTTS = Number(readArg('--rtts') ?? '100');
const RUNS = Number(readArg('--runs') ?? '5');

configureGroupStateSnapshotRepository({ ttlMs: 60_000 });

const groups = createGroups(GROUPS, SESSIONS_PER_GROUP);
setGroupStateSnapshots(groups);

const targetGroup = groups.at(-1);
if (!targetGroup) {
  throw new Error('Benchmark requires at least one group');
}

const targetSessions = targetGroup.activeSessions.map((session) => session.sessionId);
const rtts = Array.from(
  { length: RTTS },
  (_, index) =>
    ({
      sessionIdFrom: targetSessions[index % targetSessions.length],
      sessionIdTo: targetSessions[(index + 1) % targetSessions.length],
      rttMs: 10,
      createdAtEpochMs: index,
      version: index + 1,
    }) satisfies RttMeasurementInfo,
);

const results: RunResult[] = [];
for (let run = 1; run <= RUNS; run++) {
  results.push(measureLegacy(run, groups, rtts));
  results.push(measureIndexed(run, findGroupStateSnapshotsBySessionIds, rtts));
}

await Deno.writeTextFile(
  OUT,
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      input: {
        groupCount: GROUPS,
        sessionsPerGroup: SESSIONS_PER_GROUP,
        rttCount: RTTS,
        runs: RUNS,
      },
      indexedFinderAvailable: true,
      results,
    },
    null,
    2,
  ),
);

console.log(`Wrote ${OUT}`);

function readArg(name: string): string | undefined {
  return Deno.args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

function measureLegacy(
  run: number,
  _groups: readonly GroupSnapshot[],
  measurements: readonly RttMeasurementInfo[],
): RunResult {
  let groupChecks = 0;
  let sessionChecks = 0;
  let matchedGroups = 0;
  const start = performance.now();

  for (const rtt of measurements) {
    for (const group of getAllGroupStateSnapshots()) {
      groupChecks += 1;
      const hasFrom = hasSession(group, rtt.sessionIdFrom, () => {
        sessionChecks += 1;
      });
      const hasTo =
        hasFrom &&
        hasSession(group, rtt.sessionIdTo, () => {
          sessionChecks += 1;
        });
      if (hasTo) {
        matchedGroups += 1;
      }
    }
  }

  return {
    name: 'legacy-full-scan',
    run,
    durationMs: performance.now() - start,
    groupCount: GROUPS,
    sessionsPerGroup: SESSIONS_PER_GROUP,
    rttCount: measurements.length,
    matchedGroups,
    groupChecks,
    sessionChecks,
  };
}

function measureIndexed(
  run: number,
  finder: IndexedGroupFinder,
  measurements: readonly RttMeasurementInfo[],
): RunResult {
  let matchedGroups = 0;
  const start = performance.now();

  for (const rtt of measurements) {
    matchedGroups += finder([rtt.sessionIdFrom, rtt.sessionIdTo]).length;
  }

  return {
    name: 'indexed-session-lookup',
    run,
    durationMs: performance.now() - start,
    groupCount: GROUPS,
    sessionsPerGroup: SESSIONS_PER_GROUP,
    rttCount: measurements.length,
    matchedGroups,
  };
}

function hasSession(group: GroupSnapshot, sessionId: string, onCheck: () => void): boolean {
  for (const session of group.activeSessions) {
    onCheck();
    if (session.sessionId === sessionId) {
      return true;
    }
  }
  return false;
}

function createGroups(groupCount: number, sessionsPerGroup: number): readonly GroupSnapshot[] {
  return Array.from({ length: groupCount }, (_, groupIndex) => {
    const sessionIds = Array.from(
      { length: sessionsPerGroup },
      (_unused, sessionIndex) => `session-${groupIndex}-${sessionIndex}`,
    );
    return createGroupSnapshot(`room-${groupIndex}`, sessionIds);
  });
}

function createGroupSnapshot(groupId: string, memberSessionIds: readonly string[]): GroupSnapshot {
  const applicationId = 'app-1';
  const workspaceId = 'workspace-1';

  return {
    stateRevision: 1,
    causalRevision: { groupRevision: 1, presenceRevision: 1 },
    group: {
      applicationId,
      workspaceId,
      groupId,
      slug: groupId,
      displayName: groupId,
      description: null,
      kind: 'room',
      status: 'active',
      archived: null,
      deleted: null,
      joinMode: 'open',
      maxMembers: null,
      maxSessionsPerMember: null,
      metadata: {},
      activeMemberCount: memberSessionIds.length,
      ownerPrincipalId: memberSessionIds[0] ?? 'owner',
      snapshotVersion: 1,
      metadataVersion: 0,
      rosterVersion: 1,
      presenceVersion: 0,
      created: {
        atEpochMs: 1,
        actor: { kind: 'principal', principalId: 'owner' },
        reason: null,
        traceId: null,
        requestId: null,
      },
      updated: {
        atEpochMs: 1,
        actor: { kind: 'principal', principalId: 'owner' },
        reason: null,
        traceId: null,
        requestId: null,
      },
      expiresAtEpochMs: null,
      emptySinceEpochMs: null,
      purgeAfterEpochMs: null,
    },
    members: memberSessionIds.map((sessionId) => ({
      applicationId,
      workspaceId,
      groupId,
      principalId: sessionId,
      role: 'member',
      status: 'active',
      joined: {
        atEpochMs: 1,
        actor: { kind: 'principal', principalId: 'owner' },
        reason: null,
        traceId: null,
        requestId: null,
      },
      updated: {
        atEpochMs: 1,
        actor: { kind: 'principal', principalId: 'owner' },
        reason: null,
        traceId: null,
        requestId: null,
      },
      invitedByPrincipalId: null,
      invitationExpiresAtEpochMs: null,
      left: null,
      removed: null,
      banned: null,
    })),
    activeSessions: memberSessionIds.map((sessionId) => ({
      applicationId,
      workspaceId,
      groupId,
      sessionId,
      principalId: sessionId,
      generationId: `generation-${sessionId}`,
      generationVersion: 1,
      status: 'active',
      connectedAtEpochMs: 1,
      lastHeartbeatAtEpochMs: 1,
      expiresAtEpochMs: Date.now() + 60_000,
      disconnectedAtEpochMs: null,
      disconnectReason: null,
    })),
    memberCount: memberSessionIds.length,
    onlineMemberCount: memberSessionIds.length,
  };
}
