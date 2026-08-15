import { dirname } from 'node:path';

import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { ReadableKeyedValues } from '@shared/cache/RepositoryInterfaces.ts';
import { WebRtcGroupService } from '@shared/services/WebRtcGroupService.ts';

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

export interface WebRtcGroupCacheFallbackInput {
  readonly snapshots: number;
  readonly matchingVersions: number;
  readonly lookups: number;
}

interface WebRtcGroupCacheFallbackDiagnosticArguments {
  readonly mode: 'diagnostic';
  readonly input: WebRtcGroupCacheFallbackInput;
  readonly runs: number;
  readonly out: string;
}

export interface WebRtcGroupCacheFallbackAcceptedArguments {
  readonly mode: 'accepted';
  readonly input: WebRtcGroupCacheFallbackInput;
  readonly intendedPhase: 'warmup' | 'retained';
  readonly outerOrdinal: number;
  readonly sampleIds: readonly string[];
}

export interface WebRtcGroupCacheFallbackResult {
  readonly durationMs: number;
  readonly snapshotCount: number;
  readonly matchingVersions: number;
  readonly lookups: number;
  readonly readCalls: number;
  readonly peekCalls: number;
  readonly readAllValuesCalls: number;
  readonly latestVersion: number | undefined;
  readonly targetPeerCount: number;
}

interface ValidateAcceptedArgumentsInput {
  readonly options: Readonly<Record<string, string>>;
  readonly input: WebRtcGroupCacheFallbackInput;
  readonly outerOrdinal: RtcBaselineResult<number>;
  readonly intendedPhase: string | undefined;
  readonly sampleIds: readonly string[];
}

interface CreateGroupSnapshotInput {
  readonly groupId: string;
  readonly version: number;
  readonly memberSessionIds: readonly string[];
  readonly scope: Readonly<{ applicationId: string; workspaceId: string }>;
}

interface ValidationRule {
  readonly valid: boolean;
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

const acceptedOptionNames = (
  'capture baseline-id workload case-id input-key intended-phase outer-ordinal sample-ids ' +
  'rtc-inner-runs rtc-snapshots rtc-matching-versions rtc-lookups'
).split(' ');
const acceptedInput: WebRtcGroupCacheFallbackInput = {
  snapshots: 20000,
  matchingVersions: 5000,
  lookups: 500,
};

class FallbackOnlyGroupCache implements ReadableKeyedValues<string, GroupSnapshot> {
  private readonly snapshots: readonly GroupSnapshot[];
  readCalls = 0;
  peekCalls = 0;
  readAllValuesCalls = 0;

  constructor(snapshots: readonly GroupSnapshot[]) {
    this.snapshots = snapshots;
  }

  read(_key: string): GroupSnapshot | undefined {
    this.readCalls += 1;
    return undefined;
  }

  peek(_key: string): GroupSnapshot | undefined {
    this.peekCalls += 1;
    return undefined;
  }

  hasValue(_key: string): boolean {
    return false;
  }

  expired(_key: string): boolean {
    return true;
  }

  refreshing(_key: string): boolean {
    return false;
  }

  has(_key: string): boolean {
    return false;
  }

  delete(_key: string): boolean {
    return false;
  }

  clear(_key: string): void {}

  clearAll(): void {}

  deleteExpired(): number {
    return 0;
  }

  size(): number {
    return this.snapshots.length;
  }

  keys(): IterableIterator<string> {
    return [][Symbol.iterator]();
  }

  readAllValues(): GroupSnapshot[] {
    this.readAllValuesCalls += 1;
    return [...this.snapshots];
  }
}

const targetGroupId = 'target-room';
const targetScope = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
};

export function parseWebRtcGroupCacheFallbackArguments(
  arguments_: readonly string[],
): RtcBaselineResult<
  WebRtcGroupCacheFallbackDiagnosticArguments | WebRtcGroupCacheFallbackAcceptedArguments
> {
  const accepted = arguments_.some((argument) => argument.startsWith('--capture='));
  const parsed = parseRtcBaselineOneTokenOptions(
    arguments_,
    accepted ? acceptedOptionNames : ['snapshots', 'matching-versions', 'lookups', 'runs', 'out'],
  );
  if (!parsed.ok) return parsed;
  return accepted ? parseAcceptedArguments(parsed.value) : parseDiagnosticArguments(parsed.value);
}

export function runWebRtcGroupCacheFallback(
  input: WebRtcGroupCacheFallbackInput,
): WebRtcGroupCacheFallbackResult {
  const snapshots = createSnapshots(input.snapshots, input.matchingVersions);
  const cache = new FallbackOnlyGroupCache(snapshots);
  const service = new WebRtcGroupService(
    {
      input: {
        sessionId: 'self',
      },
    } as never,
    {
      ...targetScope,
      groupId: targetGroupId,
    },
    cache,
  );
  let latestVersion: number | undefined;
  let targetPeerCount = 0;
  const start = performance.now();

  for (let index = 0; index < input.lookups; index += 1) {
    const snapshot = service.readGroup();
    latestVersion = snapshot?.group.rosterVersion;
    targetPeerCount = service.targetPeerIds().length;
  }

  return {
    durationMs: performance.now() - start,
    snapshotCount: input.snapshots,
    matchingVersions: input.matchingVersions,
    lookups: input.lookups,
    readCalls: cache.readCalls,
    peekCalls: cache.peekCalls,
    readAllValuesCalls: cache.readAllValuesCalls,
    latestVersion,
    targetPeerCount,
  };
}

export function runWebRtcGroupCacheFallbackAcceptedSamples(input: {
  readonly worker: WebRtcGroupCacheFallbackAcceptedArguments;
  readonly run: () => WebRtcGroupCacheFallbackResult | Promise<WebRtcGroupCacheFallbackResult>;
}): Promise<RtcBaselineSampleDto[]> {
  return runRtcBaselineAcceptedWorkerSamples({
    worker: {
      ...input.worker,
      workloadId: 'RTC-B04',
      caseId: 'group-cache-fallback',
      inputKey: 'fixed',
    },
    run: input.run,
    validate: (result) => validateResult(input.worker.input, result),
    createSample: ({ identity, result, issues }) => createSample(identity, result, issues),
  });
}

function createSnapshots(
  snapshotCount: number,
  matchingVersions: number,
): readonly GroupSnapshot[] {
  const snapshots: GroupSnapshot[] = [];
  for (let version = 1; version <= matchingVersions; version++) {
    snapshots.push(
      createGroupSnapshot({
        groupId: targetGroupId,
        version,
        memberSessionIds: ['self', `target-peer-${version}`],
        scope: targetScope,
      }),
    );
  }

  for (let index = matchingVersions; index < snapshotCount; index++) {
    snapshots.push(
      createGroupSnapshot({
        groupId: `other-room-${index}`,
        version: index + 1,
        memberSessionIds: ['self', `other-peer-${index}`],
        scope: {
          applicationId: 'app-1',
          workspaceId: `workspace-${index % 20}`,
        },
      }),
    );
  }

  return shuffleDeterministically(snapshots);
}

function shuffleDeterministically<T>(values: readonly T[]): readonly T[] {
  const shuffled = [...values];
  for (let index = 0; index < shuffled.length; index++) {
    const swapIndex = (index * 48271 + 17) % shuffled.length;
    const current = shuffled[index];
    shuffled[index] = shuffled[swapIndex];
    shuffled[swapIndex] = current;
  }
  return shuffled;
}

function createGroupSnapshot(input: CreateGroupSnapshotInput): GroupSnapshot {
  const { memberSessionIds, version } = input;
  return {
    stateRevision: version,
    causalRevision: {
      groupRevision: version,
      presenceRevision: version,
    },
    group: createGroupSnapshotGroup(input),
    members: createGroupSnapshotMembers(input),
    activeSessions: createGroupSnapshotSessions(input),
    memberCount: memberSessionIds.length,
    onlineMemberCount: memberSessionIds.length,
  };
}

function createGroupSnapshotGroup(input: CreateGroupSnapshotInput): GroupSnapshot['group'] {
  return {
    applicationId: input.scope.applicationId,
    workspaceId: input.scope.workspaceId,
    groupId: input.groupId,
    slug: input.groupId,
    displayName: input.groupId,
    description: null,
    kind: 'room',
    status: 'active',
    archived: null,
    deleted: null,
    joinMode: 'open',
    maxMembers: null,
    maxSessionsPerMember: null,
    metadata: {},
    activeMemberCount: input.memberSessionIds.length,
    ownerPrincipalId: input.memberSessionIds[0] ?? 'creator',
    snapshotVersion: input.version,
    metadataVersion: 0,
    rosterVersion: input.version,
    presenceVersion: 0,
    created: {
      atEpochMs: 1,
      actor: { kind: 'principal', principalId: 'creator' },
      reason: null,
      traceId: null,
      requestId: null,
    },
    updated: {
      atEpochMs: input.version,
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

function createGroupSnapshotMembers(input: CreateGroupSnapshotInput): GroupSnapshot['members'] {
  return input.memberSessionIds.map((sessionId) => ({
    applicationId: input.scope.applicationId,
    workspaceId: input.scope.workspaceId,
    groupId: input.groupId,
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
      atEpochMs: input.version,
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
  input: CreateGroupSnapshotInput,
): GroupSnapshot['activeSessions'] {
  return input.memberSessionIds.map((sessionId) => ({
    applicationId: input.scope.applicationId,
    workspaceId: input.scope.workspaceId,
    groupId: input.groupId,
    sessionId,
    principalId: sessionId,
    generationId: `generation-${sessionId}`,
    generationVersion: input.version,
    status: 'active',
    connectedAtEpochMs: 1,
    lastHeartbeatAtEpochMs: input.version,
    expiresAtEpochMs: input.version + 60_000,
    disconnectedAtEpochMs: null,
    disconnectReason: null,
  }));
}

function parseDiagnosticArguments(
  options: Readonly<Record<string, string>>,
): RtcBaselineResult<WebRtcGroupCacheFallbackDiagnosticArguments> {
  const snapshots = parseRtcBaselineBoundedInteger(
    options.snapshots ?? '20000',
    'snapshots',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const matchingVersions = parseRtcBaselineBoundedInteger(
    options['matching-versions'] ?? '5000',
    'matching-versions',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const lookups = parseRtcBaselineBoundedInteger(
    options.lookups ?? '500',
    'lookups',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const runs = parseRtcBaselineBoundedInteger(options.runs ?? '5', 'runs', 1, 5);
  const issues = collectParsingIssues([snapshots, matchingVersions, lookups, runs]);
  return issues.length > 0 ? { ok: false, issues } : {
    ok: true,
    value: {
      mode: 'diagnostic',
      input: {
        snapshots: readParsedNumber(snapshots, 1),
        matchingVersions: readParsedNumber(matchingVersions, 1),
        lookups: readParsedNumber(lookups, 1),
      },
      runs: readParsedNumber(runs, 1),
      out: options.out ?? 'tmp/perf/results/webrtc-group-cache-fallback.json',
    },
  };
}

function parseAcceptedArguments(
  options: Readonly<Record<string, string>>,
): RtcBaselineResult<WebRtcGroupCacheFallbackAcceptedArguments> {
  const snapshots = parseRtcBaselineBoundedInteger(
    options['rtc-snapshots'] ?? '',
    'rtc-snapshots',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const matchingVersions = parseRtcBaselineBoundedInteger(
    options['rtc-matching-versions'] ?? '',
    'rtc-matching-versions',
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
  const issues = [
    ...collectParsingIssues([snapshots, matchingVersions, lookups, outerOrdinal]),
    ...validateRtcBaselineId(options['baseline-id'] ?? ''),
  ];
  const parsedInput = {
    snapshots: readParsedNumber(snapshots, acceptedInput.snapshots),
    matchingVersions: readParsedNumber(matchingVersions, acceptedInput.matchingVersions),
    lookups: readParsedNumber(lookups, acceptedInput.lookups),
  };
  issues.push(
    ...validateAcceptedArguments({
      options,
      input: parsedInput,
      outerOrdinal,
      intendedPhase,
      sampleIds,
    }),
  );
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
    'case-id': 'group-cache-fallback',
    'input-key': 'fixed',
    'rtc-inner-runs': '5',
    'rtc-snapshots': String(acceptedInput.snapshots),
    'rtc-matching-versions': String(acceptedInput.matchingVersions),
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
  const prefix = `rtc-b04-group-cache-fallback-fixed-${intendedPhase}-${
    String(outerOrdinal).padStart(3, '0')
  }`;
  return Array.from(
    { length: 5 },
    (_value, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`,
  );
}

function validateResult(
  input: WebRtcGroupCacheFallbackInput,
  result: WebRtcGroupCacheFallbackResult,
): RtcBaselineIssueDto[] {
  const counters = [result.readCalls, result.peekCalls, result.readAllValuesCalls];
  return validateRules([
    {
      valid: JSON.stringify([result.snapshotCount, result.matchingVersions, result.lookups]) ===
        JSON.stringify([input.snapshots, input.matchingVersions, input.lookups]),
      path: '$.rawEvidence.input',
      code: 'input-mismatch',
      message: 'Unexpected input.',
    },
    {
      valid: counters.every(Number.isSafeInteger) &&
        counters.every((count) => count === input.lookups),
      path: '$.rawEvidence.calls',
      code: 'call-count-mismatch',
      message: 'Unexpected calls.',
    },
    {
      valid: JSON.stringify([result.latestVersion, result.targetPeerCount]) ===
        JSON.stringify([input.matchingVersions, 1]),
      path: '$.rawEvidence.result',
      code: 'fallback-result-mismatch',
      message: 'Unexpected fallback result.',
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
  result: WebRtcGroupCacheFallbackResult | null,
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

function toRawEvidence(result: WebRtcGroupCacheFallbackResult): RtcBaselineJson {
  return {
    durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null,
    snapshotCount: result.snapshotCount,
    matchingVersions: result.matchingVersions,
    lookups: result.lookups,
    readCalls: result.readCalls,
    peekCalls: result.peekCalls,
    readAllValuesCalls: result.readAllValuesCalls,
    latestVersion: result.latestVersion ?? null,
    targetPeerCount: result.targetPeerCount,
  };
}

async function main(): Promise<void> {
  const parsed = parseWebRtcGroupCacheFallbackArguments(Deno.args);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  if (parsed.value.mode === 'accepted') {
    const worker = parsed.value;
    console.log(
      JSON.stringify(
        await runWebRtcGroupCacheFallbackAcceptedSamples({
          worker,
          run: () => runWebRtcGroupCacheFallback(worker.input),
        }),
      ),
    );
    return;
  }
  const diagnostic = parsed.value;
  const results = [];
  for (let run = 1; run <= diagnostic.runs; run += 1) {
    results.push({ run, ...runWebRtcGroupCacheFallback(diagnostic.input) });
  }
  const output = {
    createdAt: new Date().toISOString(),
    input: {
      snapshotCount: diagnostic.input.snapshots,
      matchingVersions: diagnostic.input.matchingVersions,
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
