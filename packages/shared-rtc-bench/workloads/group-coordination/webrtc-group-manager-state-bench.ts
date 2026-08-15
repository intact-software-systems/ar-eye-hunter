import { dirname } from 'node:path';

import type { ClientInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import type { ReadableKeyedValues } from '@shared/cache/RepositoryInterfaces.ts';
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

export interface WebRtcGroupManagerStateInput {
  readonly clients: number;
  readonly desired: number;
  readonly lookups: number;
}

interface WebRtcGroupManagerStateDiagnosticArguments {
  readonly mode: 'diagnostic';
  readonly input: WebRtcGroupManagerStateInput;
  readonly runs: number;
  readonly out: string;
}

export interface WebRtcGroupManagerStateAcceptedArguments {
  readonly mode: 'accepted';
  readonly input: WebRtcGroupManagerStateInput;
  readonly intendedPhase: 'warmup' | 'retained';
  readonly outerOrdinal: number;
  readonly sampleIds: readonly string[];
}

export interface WebRtcGroupManagerStateResult {
  readonly durationMs: number;
  readonly clientCount: number;
  readonly desiredPeerCount: number;
  readonly lookups: number;
  readonly keysCalls: number;
  readonly readCalls: number;
  readonly onlineDesiredPeerCount: number;
  readonly onlinePeerCount: number;
}

interface ValidateAcceptedArgumentsInput {
  readonly options: Readonly<Record<string, string>>;
  readonly input: WebRtcGroupManagerStateInput;
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
  'rtc-inner-runs rtc-clients rtc-desired rtc-lookups'
).split(' ');
const acceptedInput: WebRtcGroupManagerStateInput = { clients: 5000, desired: 1000, lookups: 20 };

class CountingClientCache implements ReadableKeyedValues<string, ClientInfo> {
  keysCalls = 0;
  readCalls = 0;
  private readonly values = new Map<string, ClientInfo>();

  set(key: string, value: ClientInfo): void {
    this.values.set(key, value);
  }

  resetCounters(): void {
    this.keysCalls = 0;
    this.readCalls = 0;
  }

  read(key: string): ClientInfo | undefined {
    this.readCalls += 1;
    return this.values.get(key);
  }

  peek(key: string): ClientInfo | undefined {
    return this.values.get(key);
  }

  hasValue(key: string): boolean {
    return this.values.has(key);
  }

  expired(key: string): boolean {
    return !this.values.has(key);
  }

  refreshing(_key: string): boolean {
    return false;
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  delete(key: string): boolean {
    return this.values.delete(key);
  }

  clear(key: string): void {
    this.values.delete(key);
  }

  clearAll(): void {
    this.values.clear();
  }

  deleteExpired(): number {
    return 0;
  }

  size(): number {
    return this.values.size;
  }

  keys(): IterableIterator<string> {
    this.keysCalls += 1;
    return this.values.keys();
  }

  readAllValues(): ClientInfo[] {
    return Array.from(this.values.values());
  }
}

export function parseWebRtcGroupManagerStateArguments(
  arguments_: readonly string[],
): RtcBaselineResult<
  WebRtcGroupManagerStateDiagnosticArguments | WebRtcGroupManagerStateAcceptedArguments
> {
  const accepted = arguments_.some((argument) => argument.startsWith('--capture='));
  const parsed = parseRtcBaselineOneTokenOptions(
    arguments_,
    accepted ? acceptedOptionNames : ['clients', 'desired', 'lookups', 'runs', 'out'],
  );
  if (!parsed.ok) return parsed;
  return accepted ? parseAcceptedArguments(parsed.value) : parseDiagnosticArguments(parsed.value);
}

export async function runWebRtcGroupManagerState(
  input: WebRtcGroupManagerStateInput,
): Promise<WebRtcGroupManagerStateResult> {
  const groupCache = new LatestRepository<string, GroupSnapshot>();
  const clientCache = new CountingClientCache();
  const rtcQBox = createRtcQBoxHarness('self');
  const manager = new WebRtcGroupManager(rtcQBox.service as never, groupCache, clientCache);

  for (let index = 0; index < input.clients; index += 1) {
    const peerId = `peer-${index}`;
    clientCache.set(peerId, {
      clientId: peerId,
      sessionId: peerId,
      isOnline: true,
    });
  }

  await manager.acceptGroupUpdate(
    createGroupSnapshot('room-1', 1, [
      'self',
      ...Array.from({ length: input.desired }, (_, index) => `peer-${index}`),
    ]),
  );

  clientCache.resetCounters();
  let onlineDesiredPeerCount = 0;
  let onlinePeerCount = 0;
  const start = performance.now();

  for (let lookup = 0; lookup < input.lookups; lookup += 1) {
    const state = manager.state();
    onlineDesiredPeerCount = state.onlineDesiredPeerIds.length;
    onlinePeerCount = state.onlinePeerIds.length;
  }

  return {
    durationMs: performance.now() - start,
    clientCount: input.clients,
    desiredPeerCount: input.desired,
    lookups: input.lookups,
    keysCalls: clientCache.keysCalls,
    readCalls: clientCache.readCalls,
    onlineDesiredPeerCount,
    onlinePeerCount,
  };
}

export function runWebRtcGroupManagerStateAcceptedSamples(input: {
  readonly worker: WebRtcGroupManagerStateAcceptedArguments;
  readonly run: () => WebRtcGroupManagerStateResult | Promise<WebRtcGroupManagerStateResult>;
}): Promise<RtcBaselineSampleDto[]> {
  return runRtcBaselineAcceptedWorkerSamples({
    worker: {
      ...input.worker,
      workloadId: 'RTC-B04',
      caseId: 'group-manager-state',
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

  return {
    service,
  };
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
): RtcBaselineResult<WebRtcGroupManagerStateDiagnosticArguments> {
  const clients = parseRtcBaselineBoundedInteger(
    options.clients ?? '5000',
    'clients',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const desired = parseRtcBaselineBoundedInteger(
    options.desired ?? '1000',
    'desired',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const lookups = parseRtcBaselineBoundedInteger(
    options.lookups ?? '20',
    'lookups',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const runs = parseRtcBaselineBoundedInteger(options.runs ?? '5', 'runs', 1, 5);
  const issues = collectParsingIssues([clients, desired, lookups, runs]);
  return issues.length > 0 ? { ok: false, issues } : {
    ok: true,
    value: {
      mode: 'diagnostic',
      input: {
        clients: readParsedNumber(clients, 1),
        desired: readParsedNumber(desired, 1),
        lookups: readParsedNumber(lookups, 1),
      },
      runs: readParsedNumber(runs, 1),
      out: options.out ?? 'tmp/perf/results/webrtc-group-manager-state.json',
    },
  };
}

function parseAcceptedArguments(
  options: Readonly<Record<string, string>>,
): RtcBaselineResult<WebRtcGroupManagerStateAcceptedArguments> {
  const clients = parseRtcBaselineBoundedInteger(
    options['rtc-clients'] ?? '',
    'rtc-clients',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const desired = parseRtcBaselineBoundedInteger(
    options['rtc-desired'] ?? '',
    'rtc-desired',
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
    clients: readParsedNumber(clients, acceptedInput.clients),
    desired: readParsedNumber(desired, acceptedInput.desired),
    lookups: readParsedNumber(lookups, acceptedInput.lookups),
  };
  const issues = [
    ...collectParsingIssues([clients, desired, lookups, outerOrdinal]),
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
    'case-id': 'group-manager-state',
    'input-key': 'fixed',
    'rtc-inner-runs': '5',
    'rtc-clients': String(acceptedInput.clients),
    'rtc-desired': String(acceptedInput.desired),
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
  const prefix = `rtc-b04-group-manager-state-fixed-${intendedPhase}-${
    String(outerOrdinal).padStart(3, '0')
  }`;
  return Array.from(
    { length: 5 },
    (_value, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`,
  );
}

function validateResult(
  input: WebRtcGroupManagerStateInput,
  result: WebRtcGroupManagerStateResult,
): RtcBaselineIssueDto[] {
  return validateRules([
    {
      valid: JSON.stringify([result.clientCount, result.desiredPeerCount, result.lookups]) ===
        JSON.stringify([input.clients, input.desired, input.lookups]),
      path: '$.rawEvidence.input',
      code: 'input-mismatch',
      message: 'Unexpected input.',
    },
    {
      valid: JSON.stringify([result.keysCalls, result.readCalls]) ===
          JSON.stringify([input.lookups, input.clients * input.lookups]) &&
        [result.keysCalls, result.readCalls].every(Number.isSafeInteger),
      path: '$.rawEvidence.calls',
      code: 'call-count-mismatch',
      message: 'Unexpected calls.',
    },
    {
      valid: JSON.stringify([result.onlineDesiredPeerCount, result.onlinePeerCount]) ===
        JSON.stringify([input.desired, input.desired]),
      path: '$.rawEvidence.state',
      code: 'state-result-mismatch',
      message: 'Unexpected state result.',
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
  result: WebRtcGroupManagerStateResult | null,
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

function toRawEvidence(result: WebRtcGroupManagerStateResult): RtcBaselineJson {
  return {
    durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null,
    clientCount: result.clientCount,
    desiredPeerCount: result.desiredPeerCount,
    lookups: result.lookups,
    keysCalls: result.keysCalls,
    readCalls: result.readCalls,
    onlineDesiredPeerCount: result.onlineDesiredPeerCount,
    onlinePeerCount: result.onlinePeerCount,
  };
}

async function main(): Promise<void> {
  const parsed = parseWebRtcGroupManagerStateArguments(Deno.args);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  if (parsed.value.mode === 'accepted') {
    const worker = parsed.value;
    console.log(
      JSON.stringify(
        await runWebRtcGroupManagerStateAcceptedSamples({
          worker,
          run: () => runWebRtcGroupManagerState(worker.input),
        }),
      ),
    );
    return;
  }
  const diagnostic = parsed.value;
  const results = [];
  for (let run = 1; run <= diagnostic.runs; run += 1) {
    results.push({ run, ...await runWebRtcGroupManagerState(diagnostic.input) });
  }
  const output = {
    createdAt: new Date().toISOString(),
    input: {
      clientCount: diagnostic.input.clients,
      desiredPeerCount: diagnostic.input.desired,
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
