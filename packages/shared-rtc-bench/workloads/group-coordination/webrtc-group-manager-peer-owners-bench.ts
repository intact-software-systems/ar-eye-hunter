import { dirname } from 'node:path';

import type { ClientInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { Either } from '@shared/resilience/Either.ts';
import { WebRtcGroupManager } from '@shared/services/WebRtcGroupManager.ts';

import {
  rtcBaselineIssue,
  type RtcBaselineIssueDto,
  type RtcBaselineJson,
  type RtcBaselineResult,
  type RtcBaselineSampleDto,
  type RtcBaselineSampleIdentityDto,
} from '../../baseline/contracts/rtc-baseline-contracts.ts';
import {
  parseRtcBaselineBoundedInteger,
  parseRtcBaselineOneTokenOptions,
} from '../../baseline/command/rtc-baseline-cli-options.ts';
import { validateRtcBaselineId } from '../../baseline/contracts/rtc-baseline-validation.ts';
import {
  runRtcBaselineAcceptedWorkerSamples,
} from '../../baseline/acceptance/rtc-baseline-failure-accounting.ts';

export interface WebRtcGroupManagerPeerOwnersInput {
  readonly groups: number;
  readonly peersPerGroup: number;
  readonly lookups: number;
}

interface WebRtcGroupManagerPeerOwnersDiagnosticArguments {
  readonly mode: 'diagnostic';
  readonly input: WebRtcGroupManagerPeerOwnersInput;
  readonly runs: number;
  readonly out: string;
}

export interface WebRtcGroupManagerPeerOwnersAcceptedArguments {
  readonly mode: 'accepted';
  readonly input: WebRtcGroupManagerPeerOwnersInput;
  readonly intendedPhase: 'warmup' | 'retained';
  readonly outerOrdinal: number;
  readonly sampleIds: readonly string[];
}

export interface WebRtcGroupManagerPeerOwnersResult {
  readonly durationMs: number;
  readonly groupCount: number;
  readonly peersPerGroup: number;
  readonly lookups: number;
  readonly ownedLookups: number;
  readonly totalOwnerGroups: number;
  readonly desiredPeerCount: number;
}

interface ValidateAcceptedArgumentsInput {
  readonly options: Readonly<Record<string, string>>;
  readonly input: WebRtcGroupManagerPeerOwnersInput;
  readonly outerOrdinal: RtcBaselineResult<number>;
  readonly intendedPhase: string | undefined;
  readonly sampleIds: readonly string[];
}

interface ValidationRule {
  readonly valid: boolean;
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

const acceptedOptionNames = (
  'capture baseline-id workload case-id input-key intended-phase outer-ordinal sample-ids ' +
  'rtc-inner-runs rtc-groups rtc-peers-per-group rtc-lookups'
).split(' ');
const acceptedInput: WebRtcGroupManagerPeerOwnersInput = {
  groups: 1000,
  peersPerGroup: 10,
  lookups: 1000,
};

export function parseWebRtcGroupManagerPeerOwnersArguments(
  arguments_: readonly string[],
): RtcBaselineResult<
  | WebRtcGroupManagerPeerOwnersDiagnosticArguments
  | WebRtcGroupManagerPeerOwnersAcceptedArguments
> {
  const accepted = arguments_.some((argument) => argument.startsWith('--capture='));
  const parsed = parseRtcBaselineOneTokenOptions(
    arguments_,
    accepted ? acceptedOptionNames : ['groups', 'peers-per-group', 'lookups', 'runs', 'out'],
  );
  if (!parsed.ok) return parsed;
  return accepted ? parseAcceptedArguments(parsed.value) : parseDiagnosticArguments(parsed.value);
}

export async function runWebRtcGroupManagerPeerOwners(
  input: WebRtcGroupManagerPeerOwnersInput,
): Promise<WebRtcGroupManagerPeerOwnersResult> {
  const groupCache = new LatestRepository<string, GroupSnapshot>();
  const clientCache = new LatestRepository<string, ClientInfo>();
  const rtcQBox = createRtcQBoxHarness('self');
  const manager = new WebRtcGroupManager(rtcQBox.service as never, groupCache, clientCache);

  for (let groupIndex = 0; groupIndex < input.groups; groupIndex += 1) {
    const peerIds = Array.from({ length: input.peersPerGroup }, (_unused, peerIndex) => {
      const peerId = `peer-${(groupIndex + peerIndex) % input.groups}`;
      return peerId;
    });
    const group = createGroupSnapshot(`group-${groupIndex}`, 1, ['self', ...peerIds]);

    await manager.getOrCreate(group.group).acceptGroupUpdate(group);
  }

  const lookupPeerIds = Array.from(
    { length: input.lookups },
    (_unused, index) => `peer-${index % input.groups}`,
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

  return {
    durationMs: performance.now() - start,
    groupCount: input.groups,
    peersPerGroup: input.peersPerGroup,
    lookups: input.lookups,
    ownedLookups,
    totalOwnerGroups,
    desiredPeerCount: manager.state().desiredPeerIds.length,
  };
}

export function runWebRtcGroupManagerPeerOwnersAcceptedSamples(input: {
  readonly worker: WebRtcGroupManagerPeerOwnersAcceptedArguments;
  readonly run: () =>
    | WebRtcGroupManagerPeerOwnersResult
    | Promise<WebRtcGroupManagerPeerOwnersResult>;
}): Promise<RtcBaselineSampleDto[]> {
  return runRtcBaselineAcceptedWorkerSamples({
    worker: {
      ...input.worker,
      workloadId: 'RTC-B04',
      caseId: 'group-manager-peer-owners',
      inputKey: 'fixed',
    },
    run: input.run,
    validate: (result) => validateResult(input.worker.input, result),
    createSample: ({ identity, result, issues }) => createSample(identity, result, issues),
  });
}

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
  return {
    stateRevision: membershipVersion,
    causalRevision: {
      groupRevision: membershipVersion,
      presenceRevision: membershipVersion,
    },
    group: createGroupSnapshotGroup(groupId, membershipVersion, memberSessionIds),
    members: createGroupSnapshotMembers(groupId, membershipVersion, memberSessionIds),
    activeSessions: createGroupSnapshotSessions(groupId, membershipVersion, memberSessionIds),
    memberCount: memberSessionIds.length,
    onlineMemberCount: memberSessionIds.length,
  };
}

function createGroupSnapshotGroup(
  groupId: string,
  membershipVersion: number,
  memberSessionIds: readonly string[],
): GroupSnapshot['group'] {
  return {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
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
    ownerPrincipalId: memberSessionIds[0] ?? 'creator',
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
  };
}

function createGroupSnapshotMembers(
  groupId: string,
  membershipVersion: number,
  memberSessionIds: readonly string[],
): GroupSnapshot['members'] {
  return memberSessionIds.map((sessionId) => ({
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
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
  }));
}

function createGroupSnapshotSessions(
  groupId: string,
  membershipVersion: number,
  memberSessionIds: readonly string[],
): GroupSnapshot['activeSessions'] {
  return memberSessionIds.map((sessionId) => ({
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
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
  }));
}

function parseDiagnosticArguments(
  options: Readonly<Record<string, string>>,
): RtcBaselineResult<WebRtcGroupManagerPeerOwnersDiagnosticArguments> {
  const groups = parseRtcBaselineBoundedInteger(
    options.groups ?? '1000',
    'groups',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const peersPerGroup = parseRtcBaselineBoundedInteger(
    options['peers-per-group'] ?? '10',
    'peers-per-group',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const lookups = parseRtcBaselineBoundedInteger(
    options.lookups ?? '1000',
    'lookups',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const runs = parseRtcBaselineBoundedInteger(options.runs ?? '5', 'runs', 1, 5);
  const issues = collectParsingIssues([groups, peersPerGroup, lookups, runs]);
  return issues.length > 0 ? { ok: false, issues } : {
    ok: true,
    value: {
      mode: 'diagnostic',
      input: {
        groups: readParsedNumber(groups, 1),
        peersPerGroup: readParsedNumber(peersPerGroup, 1),
        lookups: readParsedNumber(lookups, 1),
      },
      runs: readParsedNumber(runs, 1),
      out: options.out ?? 'tmp/perf/results/webrtc-group-manager-peer-owners.json',
    },
  };
}

function parseAcceptedArguments(
  options: Readonly<Record<string, string>>,
): RtcBaselineResult<WebRtcGroupManagerPeerOwnersAcceptedArguments> {
  const groups = parseRtcBaselineBoundedInteger(
    options['rtc-groups'] ?? '',
    'rtc-groups',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const peersPerGroup = parseRtcBaselineBoundedInteger(
    options['rtc-peers-per-group'] ?? '',
    'rtc-peers-per-group',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const lookups = parseRtcBaselineBoundedInteger(
    options['rtc-lookups'] ?? '',
    'rtc-lookups',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const outerOrdinal = parseRtcBaselineBoundedInteger(
    options['outer-ordinal'] ?? '',
    'outer-ordinal',
    1,
    999,
  );
  const intendedPhase = options['intended-phase'];
  const sampleIds = (options['sample-ids'] ?? '').split(',');
  const parsedInput = {
    groups: readParsedNumber(groups, acceptedInput.groups),
    peersPerGroup: readParsedNumber(peersPerGroup, acceptedInput.peersPerGroup),
    lookups: readParsedNumber(lookups, acceptedInput.lookups),
  };
  const issues = [
    ...collectParsingIssues([groups, peersPerGroup, lookups, outerOrdinal]),
    ...validateRtcBaselineId(options['baseline-id'] ?? ''),
    ...validateAcceptedArguments({
      options,
      input: parsedInput,
      outerOrdinal,
      intendedPhase,
      sampleIds,
    }),
  ];
  return issues.length > 0 ? { ok: false, issues } : {
    ok: true,
    value: {
      mode: 'accepted',
      input: parsedInput,
      intendedPhase: intendedPhase as 'warmup' | 'retained',
      outerOrdinal: readParsedNumber(outerOrdinal, 1),
      sampleIds,
    },
  };
}

function validateAcceptedArguments(input: ValidateAcceptedArgumentsInput): RtcBaselineIssueDto[] {
  const expected = {
    capture: 'worker',
    workload: 'RTC-B04',
    'case-id': 'group-manager-peer-owners',
    'input-key': 'fixed',
    'rtc-inner-runs': '5',
    'rtc-groups': String(acceptedInput.groups),
    'rtc-peers-per-group': String(acceptedInput.peersPerGroup),
    'rtc-lookups': String(acceptedInput.lookups),
  };
  const issues = Object.entries(expected)
    .filter(([name, value]) => input.options[name] !== value)
    .map(([name, value]) =>
      rtcBaselineIssue(`$.${name}`, 'unexpected-worker-input', `Expected ${value}.`)
    );
  const phase = input.intendedPhase === 'warmup' ? 'warmup' : 'retained';
  const ordinal = readParsedNumber(input.outerOrdinal, 1);
  return [
    ...issues,
    ...validateRules([
      {
        valid: JSON.stringify(input.input) === JSON.stringify(acceptedInput),
        path: '$.input',
        code: 'unexpected-worker-input',
        message: 'Expected fixed input.',
      },
      {
        valid: input.outerOrdinal.ok && input.options['outer-ordinal'] === String(ordinal),
        path: '$.outer-ordinal',
        code: 'unexpected-worker-input',
        message: 'Expected canonical integer syntax.',
      },
      {
        valid: ['warmup', 'retained'].includes(input.intendedPhase ?? ''),
        path: '$.intended-phase',
        code: 'unexpected-worker-input',
        message: 'Invalid phase.',
      },
      {
        valid: JSON.stringify(input.sampleIds) ===
          JSON.stringify(createExpectedSampleIds(phase, ordinal)),
        path: '$.sample-ids',
        code: 'unexpected-worker-input',
        message: 'Invalid sample IDs.',
      },
    ]),
  ];
}

function createExpectedSampleIds(
  intendedPhase: 'warmup' | 'retained',
  outerOrdinal: number,
): string[] {
  const prefix = `rtc-b04-group-manager-peer-owners-fixed-${intendedPhase}-${
    String(outerOrdinal).padStart(3, '0')
  }`;
  return Array.from(
    { length: 5 },
    (_value, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`,
  );
}

function validateResult(
  input: WebRtcGroupManagerPeerOwnersInput,
  result: WebRtcGroupManagerPeerOwnersResult,
): RtcBaselineIssueDto[] {
  const counts = [result.ownedLookups, result.totalOwnerGroups, result.desiredPeerCount];
  return validateRules([
    {
      valid: JSON.stringify([result.groupCount, result.peersPerGroup, result.lookups]) ===
        JSON.stringify([input.groups, input.peersPerGroup, input.lookups]),
      path: '$.rawEvidence.input',
      code: 'input-mismatch',
      message: 'Unexpected input.',
    },
    {
      valid: counts.every(Number.isSafeInteger) && counts.every((count) => count >= 0),
      path: '$.rawEvidence.counts',
      code: 'invalid-count',
      message: 'Expected bounded counts.',
    },
    {
      valid: JSON.stringify(counts) ===
        JSON.stringify([input.lookups, input.lookups * input.peersPerGroup, input.groups]),
      path: '$.rawEvidence.owners',
      code: 'ownership-result-mismatch',
      message: 'Unexpected ownership result.',
    },
    {
      valid: Number.isFinite(result.durationMs) && result.durationMs >= 0,
      path: '$.rawEvidence.durationMs',
      code: 'invalid-timing',
      message: 'Expected nonnegative.',
    },
  ]);
}

function collectParsingIssues(
  results: readonly RtcBaselineResult<number>[],
): RtcBaselineIssueDto[] {
  return results.flatMap((result) => result.ok ? [] : result.issues);
}

function readParsedNumber(result: RtcBaselineResult<number>, fallback: number): number {
  return result.ok ? result.value : fallback;
}

function validateRules(rules: readonly ValidationRule[]): RtcBaselineIssueDto[] {
  return rules.filter((rule) => !rule.valid).map((rule) =>
    rtcBaselineIssue(rule.path, rule.code, rule.message)
  );
}

function createSample(
  identity: RtcBaselineSampleIdentityDto,
  result: WebRtcGroupManagerPeerOwnersResult | null,
  issues: readonly RtcBaselineIssueDto[],
): RtcBaselineSampleDto {
  if (result === null) {
    return {
      schema: 'rallar.rtc-baseline.sample.v1',
      identity,
      outcome: 'not-run',
      evidenceClass: 'synthetic-path',
      metrics: [],
      rawEvidence: null,
      rawReferences: [],
      issues,
      runtimeObservation: null,
    };
  }
  return {
    schema: 'rallar.rtc-baseline.sample.v1',
    identity,
    outcome: issues.length === 0 ? 'passed' : 'failed',
    evidenceClass: 'synthetic-path',
    metrics: Number.isFinite(result.durationMs) && result.durationMs >= 0
      ? [{ metric: 'durationMs', unit: 'ms', value: result.durationMs }]
      : [],
    rawEvidence: toRawEvidence(result),
    rawReferences: [],
    issues,
    runtimeObservation: null,
  };
}

function toRawEvidence(result: WebRtcGroupManagerPeerOwnersResult): RtcBaselineJson {
  return {
    durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null,
    groupCount: result.groupCount,
    peersPerGroup: result.peersPerGroup,
    lookups: result.lookups,
    ownedLookups: result.ownedLookups,
    totalOwnerGroups: result.totalOwnerGroups,
    desiredPeerCount: result.desiredPeerCount,
  };
}

async function main(): Promise<void> {
  const parsed = parseWebRtcGroupManagerPeerOwnersArguments(Deno.args);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  if (parsed.value.mode === 'accepted') {
    const worker = parsed.value;
    console.log(
      JSON.stringify(
        await runWebRtcGroupManagerPeerOwnersAcceptedSamples({
          worker,
          run: () => runWebRtcGroupManagerPeerOwners(worker.input),
        }),
      ),
    );
    return;
  }
  const diagnostic = parsed.value;
  const results = [];
  for (let run = 1; run <= diagnostic.runs; run += 1) {
    results.push({ run, ...await runWebRtcGroupManagerPeerOwners(diagnostic.input) });
  }
  const output = {
    createdAt: new Date().toISOString(),
    input: {
      groupCount: diagnostic.input.groups,
      peersPerGroup: diagnostic.input.peersPerGroup,
      lookups: diagnostic.input.lookups,
      runs: diagnostic.runs,
    },
    results,
  };
  await Deno.mkdir(dirname(diagnostic.out), { recursive: true });
  await Deno.writeTextFile(diagnostic.out, JSON.stringify(output, null, 2));
  console.log(`Wrote ${diagnostic.out}`);
}

if (import.meta.main) await main();
