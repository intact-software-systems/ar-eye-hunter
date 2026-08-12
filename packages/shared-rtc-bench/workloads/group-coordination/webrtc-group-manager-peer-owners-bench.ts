import type { ClientInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { Either } from '@shared/resilience/Either.ts';
import { WebRtcGroupManager } from '@shared/services/WebRtcGroupManager.ts';

type BenchResult = Readonly<{
  run: number;
  durationMs: number;
  groupCount: number;
  peersPerGroup: number;
  lookups: number;
  ownedLookups: number;
  totalOwnerGroups: number;
  desiredPeerCount: number;
}>;

const OUT = readArg('--out') ?? 'tmp/perf/results/webrtc-group-manager-peer-owners.json';
const GROUPS = Number(readArg('--groups') ?? '1000');
const PEERS_PER_GROUP = Number(readArg('--peers-per-group') ?? '10');
const LOOKUPS = Number(readArg('--lookups') ?? '1000');
const RUNS = Number(readArg('--runs') ?? '5');

const results: BenchResult[] = [];

for (let run = 1; run <= RUNS; run++) {
  const groupCache = new LatestRepository<string, GroupSnapshot>();
  const clientCache = new LatestRepository<string, ClientInfo>();
  const rtcQBox = createRtcQBoxHarness('self');
  const manager = new WebRtcGroupManager(rtcQBox.service as never, groupCache, clientCache);
  const uniquePeerIds = new Set<string>();

  for (let groupIndex = 0; groupIndex < GROUPS; groupIndex++) {
    const peerIds = Array.from({ length: PEERS_PER_GROUP }, (_unused, peerIndex) => {
      const peerId = `peer-${(groupIndex + peerIndex) % GROUPS}`;
      uniquePeerIds.add(peerId);
      return peerId;
    });
    const group = createGroupSnapshot(`group-${groupIndex}`, 1, ['self', ...peerIds]);

    await manager.getOrCreate(group.group).acceptGroupUpdate(group);
  }

  const lookupPeerIds = Array.from(
    { length: LOOKUPS },
    (_unused, index) => `peer-${index % GROUPS}`,
  );
  let ownedLookups = 0;
  let totalOwnerGroups = 0;
  const start = performance.now();

  for (const peerId of lookupPeerIds) {
    const ownerGroups = manager.ownerGroupsOfPeer(peerId);
    totalOwnerGroups += ownerGroups.length;
    if (manager.isPeerOwnedByAnyGroup(peerId)) {
      ownedLookups += 1;
    }
  }

  results.push({
    run,
    durationMs: performance.now() - start,
    groupCount: GROUPS,
    peersPerGroup: PEERS_PER_GROUP,
    lookups: LOOKUPS,
    ownedLookups,
    totalOwnerGroups,
    desiredPeerCount: manager.state().desiredPeerIds.length,
  });
}

await Deno.writeTextFile(
  OUT,
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      input: {
        groupCount: GROUPS,
        peersPerGroup: PEERS_PER_GROUP,
        lookups: LOOKUPS,
        runs: RUNS,
      },
      results,
    },
    null,
    2,
  ),
);

console.log(`Wrote ${OUT}`);

function createRtcQBoxHarness(sessionId: string) {
  const knownPeerIds = new Set<string>();
  const connectedPeerIds = new Set<string>();

  const service = {
    input: {
      sessionId,
    },
    knownPeerIds: () => Array.from(knownPeerIds),
    peerIdsWithNoReconnectableLanes: () => Array.from(connectedPeerIds),
    ensurePeerConnectionStarted: (peerId: string) => {
      knownPeerIds.add(peerId);
      connectedPeerIds.add(peerId);
      return Either.ofRight({ peerId } as never);
    },
    disconnectPeer: (peerId: string) => {
      knownPeerIds.delete(peerId);
      return connectedPeerIds.delete(peerId);
    },
  };

  return { service };
}

function createGroupSnapshot(
  groupId: string,
  membershipVersion: number,
  memberSessionIds: readonly string[],
): GroupSnapshot {
  const applicationId = 'app-1';
  const workspaceId = 'workspace-1';
  const ownerPrincipalId = memberSessionIds[0] ?? 'creator';

  return {
    stateRevision: membershipVersion,
    causalRevision: {
      groupRevision: membershipVersion,
      presenceRevision: membershipVersion,
    },
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
      ownerPrincipalId,
      snapshotVersion: membershipVersion,
      metadataVersion: 0,
      rosterVersion: membershipVersion,
      presenceVersion: 0,
      created: {
        atEpochMs: 1,
        actor: { kind: 'principal', principalId: 'creator' },
        reason: null,
        traceId: null,
        requestId: null,
      },
      updated: {
        atEpochMs: membershipVersion,
        actor: { kind: 'principal', principalId: 'creator' },
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
        actor: { kind: 'principal', principalId: 'creator' },
        reason: null,
        traceId: null,
        requestId: null,
      },
      updated: {
        atEpochMs: membershipVersion,
        actor: { kind: 'principal', principalId: 'creator' },
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
      generationVersion: membershipVersion,
      status: 'active',
      connectedAtEpochMs: 1,
      lastHeartbeatAtEpochMs: membershipVersion,
      expiresAtEpochMs: membershipVersion + 60_000,
      disconnectedAtEpochMs: null,
      disconnectReason: null,
    })),
    memberCount: memberSessionIds.length,
    onlineMemberCount: memberSessionIds.length,
  };
}

function readArg(name: string): string | undefined {
  return Deno.args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}
