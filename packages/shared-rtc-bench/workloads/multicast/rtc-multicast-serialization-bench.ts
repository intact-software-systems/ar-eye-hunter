import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { WebRtcOverlayMulticastService } from '@shared/multicast/WebRtcOverlayMulticastService.ts';

import {
  rtcBaselineIssue,
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
// prettier-ignore
import {
  runRtcBaselineAcceptedWorkerSamples,
} from '../../baseline/acceptance/rtc-baseline-failure-accounting.ts';

export interface RtcMulticastSerializationInput {
  readonly peers: 10 | 100 | 1000;
  readonly payloadBytes: 4096 | 65536;
}

interface RtcMulticastSerializationDiagnosticArguments {
  readonly mode: 'diagnostic';
  readonly peerCounts: readonly number[];
  readonly payloadBytes: readonly number[];
  readonly runs: number;
  readonly out: string;
}

interface RtcMulticastSerializationAcceptedArguments {
  readonly mode: 'accepted';
  readonly input: RtcMulticastSerializationInput;
  readonly intendedPhase: 'warmup' | 'retained';
  readonly outerOrdinal: number;
  readonly sampleIds: readonly string[];
}

export interface RtcMulticastSerializationResult {
  readonly peerCount: number;
  readonly payloadBytes: number;
  readonly planDurationMs: number;
  readonly serializeDurationMs: number;
  readonly originalSerializeDurationMs: number;
  readonly transportMessages: number;
  readonly uniqueSerializedMessages: number;
  readonly totalSerializedBytes: number;
  readonly originalSerializedBytes: number;
  readonly allTransportMessagesIdentical: boolean;
}

interface CreateRtcMulticastIssueInput {
  readonly valid: boolean;
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

const acceptedNames = (
  'capture baseline-id workload case-id input-key intended-phase outer-ordinal sample-ids ' +
  'rtc-peers rtc-payload-bytes rtc-inner-runs'
).split(' ');
const frozenPeerCounts = new Set<number>([10, 100, 1000]);
const frozenPayloadBytes = new Set<number>([4096, 65536]);

export function parseRtcMulticastSerializationArguments(
  arguments_: readonly string[],
): RtcBaselineResult<
  RtcMulticastSerializationDiagnosticArguments | RtcMulticastSerializationAcceptedArguments
> {
  const accepted = arguments_.some((argument) => argument.startsWith('--capture='));
  const parsed = parseRtcBaselineOneTokenOptions(
    arguments_,
    accepted ? acceptedNames : ['peer-counts', 'payload-bytes', 'runs', 'out'],
  );
  if (!parsed.ok) return parsed;
  if (accepted) return parseAcceptedArguments(parsed.value);
  return parseDiagnosticArguments(parsed.value);
}

export function runRtcMulticastSerialization(
  input: RtcMulticastSerializationInput,
): RtcMulticastSerializationResult {
  const peerIds = createPeerIds(input.peers);
  const service = new WebRtcOverlayMulticastService(
    'group-1',
    createConnectionService(peerIds) as never,
  );
  const multicastMessage = newALMulticastMessage(
    'self',
    {
      topicId: 'chat',
      resourceId: `msg-${input.peers}-${input.payloadBytes}`,
      contextId: 'group-1',
    },
    { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' },
    'chat.message.v1',
    createPayload(input.payloadBytes),
    { qos: { durability: { algo: 'volatile' } } },
  );
  const overlayContext = createOverlayContext(peerIds);

  const planStartedAt = performance.now();
  const plan = service.createOriginatingPlan(multicastMessage, overlayContext as never);
  const planDurationMs = performance.now() - planStartedAt;

  const originalSerializationStartedAt = performance.now();
  const originalSerialized = JSON.stringify(multicastMessage);
  const originalSerializeDurationMs = performance.now() - originalSerializationStartedAt;

  const transportSerializationStartedAt = performance.now();
  const serializedTransportMessages = plan.transportMessages.map((message) =>
    JSON.stringify(message)
  );
  const serializeDurationMs = performance.now() - transportSerializationStartedAt;
  const uniqueSerializedMessages = new Set(serializedTransportMessages).size;

  return {
    peerCount: input.peers,
    payloadBytes: input.payloadBytes,
    planDurationMs,
    serializeDurationMs,
    originalSerializeDurationMs,
    transportMessages: plan.transportMessages.length,
    uniqueSerializedMessages,
    totalSerializedBytes: serializedTransportMessages.reduce(
      (total, serializedTransportMessage) => total + serializedTransportMessage.length,
      0,
    ),
    originalSerializedBytes: originalSerialized.length,
    allTransportMessagesIdentical: uniqueSerializedMessages <= 1,
  };
}

export async function runRtcMulticastSerializationAcceptedSamples(input: {
  readonly worker: RtcMulticastSerializationAcceptedArguments;
  readonly run: () => RtcMulticastSerializationResult | Promise<RtcMulticastSerializationResult>;
}): Promise<RtcBaselineSampleDto[]> {
  return runRtcBaselineAcceptedWorkerSamples({
    worker: {
      ...input.worker,
      workloadId: 'RTC-B04',
      caseId: 'multicast-serialization',
      inputKey: `peers-${input.worker.input.peers}-payload-${input.worker.input.payloadBytes}`,
    },
    run: input.run,
    validate: (result) => validateResult(input.worker.input, result),
    createSample: ({ identity, result, issues }) => createSample(identity, result, issues),
  });
}

function parseDiagnosticArguments(
  options: Readonly<Record<string, string>>,
): RtcBaselineResult<RtcMulticastSerializationDiagnosticArguments> {
  const peerCounts = parseDiagnosticPositiveIntegers(
    readOption(options, 'peer-counts', '10,100,1000'),
    'peer-counts',
  );
  if (!peerCounts.ok) return peerCounts;
  const payloadBytes = parseDiagnosticPositiveIntegers(
    readOption(options, 'payload-bytes', '4096,65536'),
    'payload-bytes',
  );
  if (!payloadBytes.ok) return payloadBytes;
  const runs = parseRtcBaselineBoundedInteger(readOption(options, 'runs', '3'), 'runs', 1, 5);
  if (!runs.ok) return runs;
  return {
    ok: true as const,
    value: {
      mode: 'diagnostic' as const,
      peerCounts: peerCounts.value,
      payloadBytes: payloadBytes.value,
      runs: runs.value,
      out: readOption(options, 'out', 'tmp/perf/results/rtc-multicast-serialization.json'),
    },
  };
}

function readOption(options: Readonly<Record<string, string>>, name: string, fallback: string) {
  return options[name] ?? fallback;
}

function parseAcceptedArguments(
  options: Readonly<Record<string, string>>,
): RtcBaselineResult<RtcMulticastSerializationAcceptedArguments> {
  const peers = parseRtcBaselineBoundedInteger(options['rtc-peers'] ?? '', 'rtc-peers', 10, 1000);
  const payloadBytes = parseRtcBaselineBoundedInteger(
    options['rtc-payload-bytes'] ?? '',
    'rtc-payload-bytes',
    4096,
    65536,
  );
  const outerOrdinal = parseRtcBaselineBoundedInteger(
    options['outer-ordinal'] ?? '',
    'outer-ordinal',
    1,
    999,
  );
  const issues = [
    ...(!peers.ok ? peers.issues : []),
    ...(!payloadBytes.ok ? payloadBytes.issues : []),
    ...(!outerOrdinal.ok ? outerOrdinal.issues : []),
    ...validateRtcBaselineId(options['baseline-id'] ?? ''),
  ];
  if (peers.ok && !frozenPeerCounts.has(peers.value)) {
    issues.push(
      rtcBaselineIssue('$.rtc-peers', 'unexpected-worker-input', 'Expected 10, 100, or 1000.'),
    );
  }
  if (payloadBytes.ok && !frozenPayloadBytes.has(payloadBytes.value)) {
    issues.push(
      rtcBaselineIssue('$.rtc-payload-bytes', 'unexpected-worker-input', 'Expected 4096 or 65536.'),
    );
  }

  const input: RtcMulticastSerializationInput = {
    peers: (peers.ok ? peers.value : 10) as 10 | 100 | 1000,
    payloadBytes: (payloadBytes.ok ? payloadBytes.value : 4096) as 4096 | 65536,
  };
  const expected = {
    capture: 'worker',
    workload: 'RTC-B04',
    'case-id': 'multicast-serialization',
    'input-key': `peers-${input.peers}-payload-${input.payloadBytes}`,
    'rtc-peers': String(input.peers),
    'rtc-payload-bytes': String(input.payloadBytes),
    'rtc-inner-runs': '5',
  };
  for (const [name, expectedValue] of Object.entries(expected)) {
    if (options[name] !== expectedValue) {
      issues.push(
        rtcBaselineIssue(`$.${name}`, 'unexpected-worker-input', `Expected ${expectedValue}.`),
      );
    }
  }
  if (outerOrdinal.ok && options['outer-ordinal'] !== String(outerOrdinal.value)) {
    issues.push(
      rtcBaselineIssue(
        '$.outer-ordinal',
        'unexpected-worker-input',
        'Expected canonical integer syntax.',
      ),
    );
  }
  const intendedPhase = options['intended-phase'];
  if (intendedPhase !== 'warmup' && intendedPhase !== 'retained') {
    issues.push(rtcBaselineIssue('$.intended-phase', 'unexpected-worker-input', 'Invalid phase.'));
  }
  const ordinal = outerOrdinal.ok ? outerOrdinal.value : 1;
  const sampleIds = (options['sample-ids'] ?? '').split(',');
  const expectedSampleIds = createExpectedSampleIds(
    input,
    intendedPhase === 'warmup' ? intendedPhase : 'retained',
    ordinal,
  );
  if (JSON.stringify(sampleIds) !== JSON.stringify(expectedSampleIds)) {
    issues.push(rtcBaselineIssue('$.sample-ids', 'unexpected-worker-input', 'Invalid sample IDs.'));
  }
  return issues.length > 0 ? { ok: false as const, issues } : {
    ok: true as const,
    value: {
      mode: 'accepted' as const,
      input,
      intendedPhase: intendedPhase as 'warmup' | 'retained',
      outerOrdinal: ordinal,
      sampleIds,
    },
  };
}

function parseDiagnosticPositiveIntegers(
  value: string,
  name: string,
): RtcBaselineResult<number[]> {
  const values = value.split(',');
  const issues = values.flatMap((entry, index) => {
    const parsed = parseRtcBaselineBoundedInteger(entry, name, 1, Number.MAX_SAFE_INTEGER);
    return parsed.ok ? [] : [
      rtcBaselineIssue(`$.${name}[${index}]`, parsed.issues[0]!.code, parsed.issues[0]!.message),
    ];
  });
  return issues.length > 0
    ? { ok: false as const, issues }
    : { ok: true as const, value: values.map((entry) => Number(entry)) };
}

function createExpectedSampleIds(
  input: RtcMulticastSerializationInput,
  intendedPhase: 'warmup' | 'retained',
  outerOrdinal: number,
): string[] {
  const prefix =
    `rtc-b04-multicast-serialization-peers-${input.peers}-payload-${input.payloadBytes}-` +
    `${intendedPhase}-${String(outerOrdinal).padStart(3, '0')}`;
  return Array.from(
    { length: 5 },
    (_value, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`,
  );
}

function validateResult(
  input: RtcMulticastSerializationInput,
  result: RtcMulticastSerializationResult,
) {
  const timingIssues = Object.entries({
    planDurationMs: result.planDurationMs,
    originalSerializeDurationMs: result.originalSerializeDurationMs,
    serializeDurationMs: result.serializeDurationMs,
  })
    .flatMap(([metric, value]) =>
      createIssueWhen(
        {
          valid: Number.isFinite(value) && value >= 0,
          path: `$.rawEvidence.${metric}`,
          code: 'invalid-timing',
          message: 'Expected nonnegative.',
        },
      )
    );
  return [
    ...createIssueWhen(
      {
        valid: JSON.stringify([result.peerCount, result.payloadBytes]) ===
          JSON.stringify([input.peers, input.payloadBytes]),
        path: '$.rawEvidence.input',
        code: 'input-mismatch',
        message: 'Unexpected multicast input.',
      },
    ),
    ...createIssueWhen({
      valid: result.transportMessages === input.peers,
      path: '$.rawEvidence.transportMessages',
      code: 'transport-count-mismatch',
      message: 'Unexpected count.',
    }),
    ...createIssueWhen({
      valid:
        JSON.stringify([result.uniqueSerializedMessages, result.allTransportMessagesIdentical]) ===
          JSON.stringify([input.peers, false]),
      path: '$.rawEvidence.uniqueSerializedMessages',
      code: 'serialization-identity-mismatch',
      message: 'Expected distinct serialized transport messages.',
    }),
    ...createIssueWhen({
      valid: Math.min(
        result.originalSerializedBytes - 1,
        result.totalSerializedBytes - result.originalSerializedBytes * result.transportMessages,
      ) >= 0,
      path: '$.rawEvidence.bytes',
      code: 'byte-evidence-mismatch',
      message: 'Unexpected bytes.',
    }),
    ...timingIssues,
  ];
}

function createIssueWhen(input: CreateRtcMulticastIssueInput) {
  return input.valid ? [] : [rtcBaselineIssue(input.path, input.code, input.message)];
}

function createSample(
  identity: RtcBaselineSampleIdentityDto,
  result: RtcMulticastSerializationResult | null,
  issues: RtcBaselineSampleDto['issues'],
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
    metrics: [
      { metric: 'planDurationMs', unit: 'ms', value: result.planDurationMs },
      {
        metric: 'originalSerializeDurationMs',
        unit: 'ms',
        value: result.originalSerializeDurationMs,
      },
      { metric: 'serializeDurationMs', unit: 'ms', value: result.serializeDurationMs },
    ],
    rawEvidence: toRawEvidence(result),
    rawReferences: [],
    issues,
    runtimeObservation: null,
  };
}

function toRawEvidence(result: RtcMulticastSerializationResult): RtcBaselineJson {
  return {
    peerCount: result.peerCount,
    payloadBytes: result.payloadBytes,
    planDurationMs: result.planDurationMs,
    serializeDurationMs: result.serializeDurationMs,
    originalSerializeDurationMs: result.originalSerializeDurationMs,
    transportMessages: result.transportMessages,
    uniqueSerializedMessages: result.uniqueSerializedMessages,
    totalSerializedBytes: result.totalSerializedBytes,
    originalSerializedBytes: result.originalSerializedBytes,
    allTransportMessagesIdentical: result.allTransportMessagesIdentical,
  };
}

function createConnectionService(peerIds: readonly string[]) {
  return {
    input: { sessionId: 'self' },
    readyPeerIdsForLane: () => [...peerIds],
  };
}

function createOverlayContext(peerIds: readonly string[]) {
  const applicationId = 'app-1';
  const workspaceId = 'workspace-1';
  const groupId = 'group-1';
  const memberSessionIds = ['self', ...peerIds];
  return {
    overlayId: groupId,
    room: {
      group: {
        applicationId,
        workspaceId,
        groupId,
        displayName: 'Group 1',
        kind: 'room',
        status: 'active',
        joinMode: 'open',
        metadata: {},
        snapshotVersion: 1,
        metadataVersion: 0,
        rosterVersion: 1,
        presenceVersion: 0,
        created: { atEpochMs: 1, byPrincipalId: 'owner' },
        updated: { atEpochMs: 1, byPrincipalId: 'owner' },
      },
      members: memberSessionIds.map((sessionId) => ({
        applicationId,
        workspaceId,
        groupId,
        principalId: sessionId,
        role: 'member',
        status: 'active',
        joined: { atEpochMs: 1, byPrincipalId: 'owner' },
        updated: { atEpochMs: 1, byPrincipalId: 'owner' },
      })),
      activeSessions: memberSessionIds.map((sessionId) => ({
        applicationId,
        workspaceId,
        groupId,
        sessionId,
        principalId: sessionId,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 60_001,
      })),
      memberCount: memberSessionIds.length,
      onlineMemberCount: memberSessionIds.length,
    },
    overlay: {
      overlayId: groupId,
      name: 'Group 1',
      createdByClientId: 'owner',
      createdAtEpochMs: 1,
      nextHopSessionIds: peerIds,
      overlayVersion: 1,
      updatedAtEpochMs: 1,
    },
  };
}

function createPayload(payloadBytes: number) {
  return { text: 'x'.repeat(payloadBytes), createdAtEpochMs: 1 };
}

function createPeerIds(peerCount: number): readonly string[] {
  return Array.from(
    { length: peerCount },
    (_value, index) => `peer-${String(index + 1).padStart(5, '0')}`,
  );
}

async function main(): Promise<void> {
  const parsed = parseRtcMulticastSerializationArguments(Deno.args);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  if (parsed.value.mode === 'accepted') {
    const worker = parsed.value;
    const samples = await runRtcMulticastSerializationAcceptedSamples({
      worker,
      run: () => runRtcMulticastSerialization(worker.input),
    });
    console.log(JSON.stringify(samples));
    return;
  }
  const diagnostic = parsed.value;
  const results = [];
  const diagnosticInputs = diagnostic.peerCounts.flatMap((peerCount) =>
    diagnostic.payloadBytes.map((payloadBytes) => ({ peerCount, payloadBytes }))
  );
  for (const diagnosticInput of diagnosticInputs) {
    for (let run = 1; run <= diagnostic.runs; run += 1) {
      results.push({
        run,
        ...runRtcMulticastSerialization({
          peers: diagnosticInput.peerCount as 10 | 100 | 1000,
          payloadBytes: diagnosticInput.payloadBytes as 4096 | 65536,
        }),
      });
    }
  }
  const output = {
    command: Deno.args,
    peerCounts: diagnostic.peerCounts,
    payloadBytes: diagnostic.payloadBytes,
    runs: diagnostic.runs,
    results,
  };
  await Deno.writeTextFile(diagnostic.out, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
}

if (import.meta.main) await main();
