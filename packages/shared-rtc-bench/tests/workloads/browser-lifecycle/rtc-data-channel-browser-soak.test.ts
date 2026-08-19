import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRtcBaselineEvidenceAcceptance } from '../../../baseline/acceptance/rtc-baseline-evidence-acceptance.ts';
import type {
  RtcBaselineCaptureManifestDto,
  RtcBaselineEnvironmentDto,
  RtcBaselineExternalAttemptDto,
  RtcBaselineJson,
  RtcBaselineRuntimeObservationDto,
} from '../../../baseline/contracts/rtc-baseline-contracts.ts';
import { isRtcBaselineExternalAttemptDto } from '../../../baseline/contracts/rtc-baseline-contracts.ts';

vi.mock('@playwright/test', () => ({
  chromium: { launch: vi.fn() },
}));

interface BrowserSoakModule {
  runRtcDataChannelBrowserSoakCli(
    argumentsList: readonly string[],
    dependencies?: {
      baselineRootPath?: string;
      launchBrowser?: () => Promise<FakeBrowser>;
      nowUtc?: () => string;
    },
  ): Promise<{ mode: 'diagnostic' | 'raw-evidence'; outputPath: string; output: unknown }>;
}

interface FakeBrowser {
  newPage(): Promise<FakePage>;
  close(): Promise<void>;
}

interface FakePage {
  context(): {
    newCDPSession(): Promise<{
      send(command: string): Promise<unknown>;
    }>;
  };
  setContent(html: string): Promise<void>;
  evaluate(
    operation: unknown,
    argument?: { iterationCount: number; iterationIdPrefix: string },
  ): Promise<unknown>;
}

const scriptPath =
  'packages/shared-rtc-bench/workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs';
const caseId = 'browser-data-channel-lifecycle';
const inputKey = 'iterations-25';
const primaryBaselineId = '20260815-0d2221b3af34-e2-browser';
const repeatBaselineId = `${primaryBaselineId}-repeat-01`;
const fixedNow = '2026-08-15T18:00:00.000Z';
const originalArgv = process.argv;
let browserSoak: BrowserSoakModule;

const initializedRuntimeObservation: RtcBaselineRuntimeObservationDto = {
  git: {
    headCommit: '0'.repeat(40),
    headTree: '1'.repeat(40),
    ref: 'codex/shared-rtc-bench-task-6-b05',
    clean: true,
  },
  runtime: {
    node: 'v24.0.0',
    npm: '11.0.0',
    deno: '2.0.0',
    playwright: '1.0.0',
    chromium: 'Chromium 140.0.0',
  },
  host: {
    os: 'darwin',
    kernel: '25.0.0',
    architecture: 'arm64',
    logicalCpuCount: 10,
    cpuModel: 'Test CPU',
    totalMemoryBytes: 16_000_000_000,
    executionContext: 'local',
  },
  timing: {
    startedAtUtc: '2026-08-15T17:59:00.000Z',
    endedAtUtc: '2026-08-15T17:59:01.000Z',
    monotonicDurationMs: 1000,
    monotonicSource: 'performance.now',
  },
  deviations: [],
  sourceHashes: [
    { path: scriptPath, sha256: 'a'.repeat(64), kind: 'source' },
    {
      path: 'apps/rallar-black-box/playwright.config.ts',
      sha256: 'b'.repeat(64),
      kind: 'config',
    },
  ],
  configurationInputs: [],
  resolvedConfiguration: [
    {
      caseKey: { workloadId: 'RTC-B05', caseId, inputKey },
      field: 'iterations',
      value: 25,
      source: 'default',
    },
  ],
  controllerInputs: [
    { name: 'baselineId', value: primaryBaselineId, secret: false },
    { name: 'workloadIds', value: 'RTC-B05', secret: false },
    { name: 'environmentId', value: 'E2-browser', secret: false },
  ],
  workerCommand: {
    redactedArgv: { executable: 'node', arguments: [scriptPath] },
    projection: { fixedWorkerFlags: [], configurationFlags: [] },
  },
  allowlistedEnvironment: {},
};

function sampleId(phase: 'warmup' | 'retained', outerOrdinal: number) {
  return [
    'rtc-b05-browser-data-channel-lifecycle-iterations-25',
    phase,
    String(outerOrdinal).padStart(3, '0'),
    '001',
  ].join('-');
}

function outerAttempt(phase: 'warmup' | 'retained', outerOrdinal: number) {
  return {
    workloadId: 'RTC-B05' as const,
    caseId,
    inputKey,
    environmentId: 'E2-browser' as const,
    intendedPhase: phase,
    outerOrdinal,
    sampleIds: [sampleId(phase, outerOrdinal)],
  };
}

function manifest(
  baselineId: string,
  retainedSampleMultiplier: 1 | 2,
): RtcBaselineCaptureManifestDto {
  const retainedAttemptCount = retainedSampleMultiplier === 1 ? 5 : 10;
  const repeatLink =
    retainedSampleMultiplier === 1
      ? null
      : { primaryBaselineId, primarySummarySha256: 'c'.repeat(64) };
  return {
    schema: 'rallar.rtc-baseline.manifest.v1',
    request: {
      schema: 'rallar.rtc-baseline.capture-request.v1',
      baselineId,
      workloadIds: ['RTC-B05'],
      environmentId: 'E2-browser',
      retainedSampleMultiplier,
      repeatLink,
      conditionalEnvironmentDecisions: [],
    },
    workloadIds: ['RTC-B05'],
    cases: [{ workloadId: 'RTC-B05', caseId, inputKey }],
    outerAttempts: [
      outerAttempt('warmup', 1),
      ...Array.from({ length: retainedAttemptCount }, (_, index) =>
        outerAttempt('retained', index + 1),
      ),
    ],
    expectedCohorts: [],
    repeatLink,
  };
}

function environment(captureManifest: RtcBaselineCaptureManifestDto): RtcBaselineEnvironmentDto {
  const observation = initializedRuntimeObservation;
  return {
    schema: 'rallar.rtc-baseline.environment.v1',
    baselineId: captureManifest.request.baselineId,
    workloadIds: ['RTC-B05'],
    environmentId: 'E2-browser',
    repeatLink: captureManifest.repeatLink,
    conditionalEnvironmentDecisions: [],
    observation: {
      ...observation,
      controllerInputs: observation.controllerInputs.map((entry) =>
        entry.name === 'baselineId'
          ? { ...entry, value: captureManifest.request.baselineId }
          : entry,
      ),
    },
  };
}

function rawRelativePath(phase: 'warmup' | 'retained', outerOrdinal: number) {
  return [
    'artifacts/staging/rtc-b05-browser-data-channel-lifecycle-iterations-25',
    phase,
    `${String(outerOrdinal).padStart(3, '0')}.json`,
  ].join('-');
}

function writeInitializedBaseline(
  rootPath: string,
  captureManifest: RtcBaselineCaptureManifestDto,
) {
  const baselinePath = join(rootPath, captureManifest.request.baselineId);
  mkdirSync(join(baselinePath, 'artifacts/staging'), { recursive: true });
  writeFileSync(join(baselinePath, 'manifest.json'), `${JSON.stringify(captureManifest)}\n`);
  writeFileSync(
    join(baselinePath, 'environment.json'),
    `${JSON.stringify(environment(captureManifest))}\n`,
  );
  return baselinePath;
}

function rawArguments(
  baselineId: string,
  phase: 'warmup' | 'retained',
  outerOrdinal: number,
  rawResultRelativePath = rawRelativePath(phase, outerOrdinal),
) {
  return [
    '--capture=raw-evidence',
    `--baseline-id=${baselineId}`,
    `--case-id=${caseId}`,
    `--input-key=${inputKey}`,
    `--intended-phase=${phase}`,
    `--outer-ordinal=${outerOrdinal}`,
    `--out=${rawResultRelativePath}`,
  ];
}

function completedSoak(iterationCount: number, iterationIdPrefix: string) {
  const results = Array.from({ length: iterationCount }, (_, index) => ({
    index: index + 1,
    iterationId: `${iterationIdPrefix}-iteration-${String(index + 1).padStart(3, '0')}`,
    opened: true,
    closed: true,
    messageReceived: true,
    events: ['local-open', 'remote-open', 'remote-message', 'local-close', 'remote-close'],
    localState: 'closed',
    remoteState: 'closed',
    pcAState: 'closed',
    pcBState: 'closed',
    openDurationMs: index + 0.25,
    closeDurationMs: index + 0.5,
    failure: null,
  }));
  return {
    iterations: iterationCount,
    results,
    openedCount: iterationCount,
    closedCount: iterationCount,
    messageReceivedCount: iterationCount,
    localErrorCount: 0,
    remoteErrorCount: 0,
  };
}

class FakeDataChannel {
  readyState = 'connecting';
  counterpart?: FakeDataChannel;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: () => void;

  open() {
    this.readyState = 'open';
    this.onopen?.();
  }

  send() {
    this.counterpart?.onmessage?.();
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
    const counterpart = this.counterpart;
    if (counterpart && counterpart.readyState !== 'closed') {
      counterpart.readyState = 'closed';
      counterpart.onclose?.();
    }
  }
}

class FakePeerConnection {
  static unpaired?: FakePeerConnection;
  connectionState = 'new';
  onicecandidate?: () => void;
  ondatachannel?: (event: { channel: FakeDataChannel }) => void;
  partner?: FakePeerConnection;
  localChannel?: FakeDataChannel;

  constructor() {
    if (FakePeerConnection.unpaired) {
      this.partner = FakePeerConnection.unpaired;
      this.partner.partner = this;
      FakePeerConnection.unpaired = undefined;
    } else {
      FakePeerConnection.unpaired = this;
    }
  }

  createDataChannel() {
    this.localChannel = new FakeDataChannel();
    return this.localChannel;
  }

  async createOffer() {
    return {};
  }

  async createAnswer() {
    return {};
  }

  async setLocalDescription() {}

  async setRemoteDescription() {
    if (!this.partner?.localChannel) return;
    const remoteChannel = new FakeDataChannel();
    remoteChannel.counterpart = this.partner.localChannel;
    this.partner.localChannel.counterpart = remoteChannel;
    this.ondatachannel?.({ channel: remoteChannel });
    this.connectionState = 'connected';
    this.partner.connectionState = 'connected';
    this.partner.localChannel.open();
    remoteChannel.open();
  }

  async addIceCandidate() {}

  close() {
    this.connectionState = 'closed';
  }
}

function semanticBrowser() {
  const close = vi.fn(async () => undefined);
  const evaluate = vi.fn(async (operation: unknown, argument?: unknown) => {
    if (typeof operation !== 'function') throw new Error('Expected a browser operation');
    return argument === undefined ? await operation() : await operation(argument);
  });
  const page: FakePage = {
    context: () => ({
      newCDPSession: async () => ({
        send: async (command: string) =>
          command === 'Performance.getMetrics'
            ? { metrics: [{ name: 'JSHeapUsedSize', value: 1000 }] }
            : {},
      }),
    }),
    setContent: async () => undefined,
    evaluate,
  };
  return {
    browser: { newPage: async () => page, close },
    close,
    evaluate,
  };
}

function fakeBrowser(
  soakFactory: (iterationCount: number, iterationIdPrefix: string) => unknown = completedSoak,
  heapValues: readonly (number | null)[] = [1000, 1000],
) {
  const close = vi.fn(async () => undefined);
  let heapReadIndex = 0;
  const evaluate = vi.fn(
    async (
      _operation: unknown,
      argument?: { iterationCount: number; iterationIdPrefix: string },
    ) => (argument ? soakFactory(argument.iterationCount, argument.iterationIdPrefix) : undefined),
  );
  const page: FakePage = {
    context: () => ({
      newCDPSession: async () => ({
        send: async (command: string) => {
          if (command !== 'Performance.getMetrics') return {};
          const heapValue = heapValues[heapReadIndex++] ?? null;
          return {
            metrics: heapValue === null ? [] : [{ name: 'JSHeapUsedSize', value: heapValue }],
          };
        },
      }),
    }),
    setContent: async () => undefined,
    evaluate,
  };
  const browser: FakeBrowser = {
    newPage: async () => page,
    close,
  };
  return { browser, close, evaluate };
}

function readJson(path: string): RtcBaselineJson {
  return JSON.parse(readFileSync(path, 'utf8')) as RtcBaselineJson;
}

function readExternalAttempt(path: string): RtcBaselineExternalAttemptDto & RtcBaselineJson {
  const value = readJson(path);
  if (!isRtcBaselineExternalAttemptDto(value)) {
    throw new Error(`Expected an RTC baseline external attempt at ${path}`);
  }
  return value as RtcBaselineExternalAttemptDto & RtcBaselineJson;
}

function rtcB05IterationIds(rawEvidence: RtcBaselineJson): readonly string[] {
  if (
    typeof rawEvidence !== 'object' ||
    rawEvidence === null ||
    Array.isArray(rawEvidence) ||
    typeof rawEvidence.soak !== 'object' ||
    rawEvidence.soak === null ||
    Array.isArray(rawEvidence.soak) ||
    !Array.isArray(rawEvidence.soak.results)
  ) {
    throw new Error('Expected RTC-B05 raw evidence with iteration results');
  }
  return rawEvidence.soak.results.map((entry) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Array.isArray(entry) ||
      typeof entry.iterationId !== 'string'
    ) {
      throw new Error('Expected an RTC-B05 iteration identity');
    }
    return entry.iterationId;
  });
}

function rtcB05JsonObject(value: RtcBaselineJson, description: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected object-shaped RTC-B05 ${description}`);
  }
  return value;
}

function createAcceptance(
  captureManifest: RtcBaselineCaptureManifestDto,
  staged: RtcBaselineJson,
  written: unknown[],
) {
  const readStagedJson = vi.fn(async () => ({ ok: true as const, value: staged }));
  const acceptance = createRtcBaselineEvidenceAcceptance({
    initializeStore: async () => ({ ok: true, value: undefined }),
    readManifest: async () => ({ ok: true, value: captureManifest }),
    writeAcceptedArtifact: async (_baselineId, artifact) => {
      written.push(artifact);
      return { ok: true, value: undefined };
    },
    readStagedJson,
    runFreshWorker: async () => ({ outcomes: [] }),
    reconcileAcceptedOperation: async () => [],
  });
  return { acceptance, readStagedJson };
}

function assertAcceptedAttemptIdentity(input: {
  staged: RtcBaselineExternalAttemptDto;
  phase: 'warmup' | 'retained';
  outerOrdinal: number;
  relativePath: string;
}) {
  const expectedSampleId = sampleId(input.phase, input.outerOrdinal);
  expect(input.staged).toMatchObject({
    schema: 'rallar.rtc-baseline.external-attempt.v1',
    locator: {
      workloadId: 'RTC-B05',
      caseId,
      inputKey,
      intendedPhase: input.phase,
      outerOrdinal: input.outerOrdinal,
      environmentId: 'E2-browser',
      rawResultRelativePath: input.relativePath,
    },
    producerExitStatus: 0,
    sampleOutcomes: [{ identity: { sampleId: expectedSampleId }, outcome: 'passed', issues: [] }],
    samples: [
      {
        identity: { sampleId: expectedSampleId },
        outcome: 'passed',
        evidenceClass: 'native-browser',
        issues: [],
      },
    ],
    issues: [],
  });
}

function assertAcceptedMeasurement(input: {
  staged: RtcBaselineExternalAttemptDto;
  baselineId: string;
  phase: 'warmup' | 'retained';
  outerOrdinal: number;
  captureManifest: RtcBaselineCaptureManifestDto;
}) {
  const sample = input.staged.samples[0];
  expect(sample.rawEvidence).toMatchObject({
    identity: {
      baselineId: input.baselineId,
      workloadId: 'RTC-B05',
      caseId,
      inputKey,
      intendedPhase: input.phase,
      outerOrdinal: input.outerOrdinal,
    },
  });
  const iterationIds = rtcB05IterationIds(sample.rawEvidence);
  expect(iterationIds).toHaveLength(25);
  expect(new Set(iterationIds).size).toBe(25);
  expect(
    sample.metrics.filter(({ metric }) =>
      ['firstOpenDurationMs', 'steadyOpenMedianDurationMs'].includes(metric),
    ),
  ).toEqual([
    { metric: 'firstOpenDurationMs', unit: 'ms', value: 0.25 },
    { metric: 'steadyOpenMedianDurationMs', unit: 'ms', value: 12.75 },
  ]);
  expect(
    sample.metrics.filter(({ metric }) =>
      ['firstCloseDurationMs', 'steadyCloseMedianDurationMs'].includes(metric),
    ),
  ).toEqual([
    { metric: 'firstCloseDurationMs', unit: 'ms', value: 0.5 },
    { metric: 'steadyCloseMedianDurationMs', unit: 'ms', value: 13 },
  ]);
  expect(sample.runtimeObservation).toEqual(environment(input.captureManifest).observation);
}

function failedSoak(iterationCount: number, iterationIdPrefix: string) {
  const soak = completedSoak(iterationCount, iterationIdPrefix);
  return {
    ...soak,
    closedCount: 24,
    remoteErrorCount: 1,
    results: soak.results.map((entry, index) =>
      index === 0
        ? {
            ...entry,
            closed: false,
            remoteState: 'closing',
            events: [...entry.events, 'remote-error'],
          }
        : entry,
    ),
  };
}

function expectCausalArtifacts(written: readonly unknown[]) {
  expect(written).toEqual([
    expect.objectContaining({
      artifactKind: 'failure',
      identity: expect.objectContaining({
        sampleId: sampleId('retained', 2),
        outerOrdinal: 2,
      }),
    }),
    expect.objectContaining({
      artifactKind: 'not-run',
      identity: expect.objectContaining({ sampleId: sampleId('retained', 3) }),
    }),
    expect.objectContaining({
      artifactKind: 'not-run',
      identity: expect.objectContaining({ sampleId: sampleId('retained', 4) }),
    }),
    expect.objectContaining({
      artifactKind: 'not-run',
      identity: expect.objectContaining({ sampleId: sampleId('retained', 5) }),
    }),
  ]);
}

const acceptedRawScenarios = [
  {
    baselineId: primaryBaselineId,
    multiplier: 1 as const,
    attempts: [
      { phase: 'warmup' as const, outerOrdinal: 1 },
      { phase: 'retained' as const, outerOrdinal: 1 },
      { phase: 'retained' as const, outerOrdinal: 2 },
      { phase: 'retained' as const, outerOrdinal: 3 },
      { phase: 'retained' as const, outerOrdinal: 4 },
      { phase: 'retained' as const, outerOrdinal: 5 },
    ],
  },
  {
    baselineId: repeatBaselineId,
    multiplier: 2 as const,
    attempts: [
      { phase: 'warmup' as const, outerOrdinal: 1 },
      { phase: 'retained' as const, outerOrdinal: 1 },
      { phase: 'retained' as const, outerOrdinal: 2 },
      { phase: 'retained' as const, outerOrdinal: 3 },
      { phase: 'retained' as const, outerOrdinal: 4 },
      { phase: 'retained' as const, outerOrdinal: 5 },
      { phase: 'retained' as const, outerOrdinal: 6 },
      { phase: 'retained' as const, outerOrdinal: 7 },
      { phase: 'retained' as const, outerOrdinal: 8 },
      { phase: 'retained' as const, outerOrdinal: 9 },
      { phase: 'retained' as const, outerOrdinal: 10 },
    ],
  },
];

beforeAll(async () => {
  process.argv = [process.execPath, 'vitest'];
  browserSoak = (await import(
    // @ts-expect-error The Node entrypoint is JavaScript and owns no TypeScript declaration.
    '../../../workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs'
  )) as BrowserSoakModule;
  process.argv = originalArgv;
});

afterAll(() => {
  process.argv = originalArgv;
});

it('keeps the browser lifecycle entry syntactically valid without running B05', () => {
  const result = spawnSync('node', ['--check', scriptPath], { encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});

it('preserves the diagnostic CLI while measuring only through an injected browser', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rtc-b05-diagnostic-'));
  const outputPath = join(directory, 'diagnostic.json');
  writeFileSync(outputPath, 'old diagnostic\n');
  const launched = semanticBrowser();
  const hadPeerConnection = Reflect.has(globalThis, 'RTCPeerConnection');
  const priorPeerConnection = Reflect.get(globalThis, 'RTCPeerConnection');
  Reflect.set(globalThis, 'RTCPeerConnection', FakePeerConnection);

  try {
    const result = await browserSoak.runRtcDataChannelBrowserSoakCli(
      ['--iterations=2', `--out=${outputPath}`],
      {
        launchBrowser: async () => launched.browser,
        nowUtc: () => fixedNow,
      },
    );

    expect(result.mode).toBe('diagnostic');
    expect(readJson(outputPath)).toMatchObject({
      createdAt: fixedNow,
      input: { iterations: 2 },
      soak: { iterations: 2, openedCount: 2, closedCount: 2 },
    });
    expect(launched.evaluate).toHaveBeenCalledWith(expect.any(Function), {
      iterationCount: 2,
      iterationIdPrefix: 'diagnostic',
    });
    expect(launched.close).toHaveBeenCalledOnce();
  } finally {
    FakePeerConnection.unpaired = undefined;
    if (hadPeerConnection) Reflect.set(globalThis, 'RTCPeerConnection', priorPeerConnection);
    else Reflect.deleteProperty(globalThis, 'RTCPeerConnection');
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each(acceptedRawScenarios)(
  'stages one create-new accepted raw file for every immutable $baselineId process identity',
  async ({ baselineId, multiplier, attempts }) => {
    const rootPath = mkdtempSync(join(tmpdir(), 'rtc-b05-raw-'));
    const captureManifest = manifest(baselineId, multiplier);
    const baselinePath = writeInitializedBaseline(rootPath, captureManifest);
    const manifestBefore = readFileSync(join(baselinePath, 'manifest.json'), 'utf8');

    try {
      for (const { phase, outerOrdinal } of attempts) {
        const launched = fakeBrowser();
        const relativePath = rawRelativePath(phase, outerOrdinal);
        await browserSoak.runRtcDataChannelBrowserSoakCli(
          rawArguments(baselineId, phase, outerOrdinal),
          {
            baselineRootPath: rootPath,
            launchBrowser: async () => launched.browser,
            nowUtc: () => fixedNow,
          },
        );
        const staged = readExternalAttempt(join(baselinePath, relativePath));
        assertAcceptedAttemptIdentity({ staged, phase, outerOrdinal, relativePath });
        assertAcceptedMeasurement({ staged, baselineId, phase, outerOrdinal, captureManifest });
        const written: unknown[] = [];
        const { acceptance } = createAcceptance(captureManifest, staged, written);
        const accepted = await acceptance.recordBrowser({
          baselineId,
          locator: { workloadId: 'RTC-B05', caseId, inputKey, intendedPhase: phase, outerOrdinal },
          producerExitStatus: 0,
          rawResultRelativePath: relativePath,
        });
        expect(accepted).toEqual({ ok: true, value: { acceptedSampleCount: 1 } });
        expect(written).toEqual([staged]);
        expect(launched.close).toHaveBeenCalledOnce();
      }
      expect(readFileSync(join(baselinePath, 'manifest.json'), 'utf8')).toBe(manifestBefore);
      expect(captureManifest.outerAttempts).toHaveLength(attempts.length);
      const lastAttempt = attempts.at(-1)!;
      const launchBrowser = vi.fn(async () => fakeBrowser().browser);
      await expect(
        browserSoak.runRtcDataChannelBrowserSoakCli(
          rawArguments(baselineId, lastAttempt.phase, lastAttempt.outerOrdinal),
          { baselineRootPath: rootPath, launchBrowser },
        ),
      ).rejects.toThrow('already exists');
      expect(launchBrowser).not.toHaveBeenCalled();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  },
);

it('rejects bounds, overrides, path escapes, and changed accepted matrices before launch', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'rtc-b05-invalid-'));
  const captureManifest = manifest(primaryBaselineId, 1);
  const baselinePath = writeInitializedBaseline(rootPath, captureManifest);
  const launched = fakeBrowser();
  const launchBrowser = vi.fn(async () => launched.browser);

  try {
    const invalidArguments = [
      [...rawArguments(primaryBaselineId, 'retained', 1), '--iterations=25'],
      rawArguments(primaryBaselineId, 'retained', 0),
      rawArguments(primaryBaselineId, 'retained', 1000),
      rawArguments(primaryBaselineId, 'retained', 1, '../outside.json'),
      rawArguments(primaryBaselineId, 'retained', 1, 'artifacts/staging/other.json'),
    ];
    for (const argumentsList of invalidArguments) {
      await expect(
        browserSoak.runRtcDataChannelBrowserSoakCli(argumentsList, {
          baselineRootPath: rootPath,
          launchBrowser,
        }),
      ).rejects.toThrow();
    }

    const changedManifest = {
      ...captureManifest,
      outerAttempts: captureManifest.outerAttempts.slice(0, -1),
    };
    writeFileSync(join(baselinePath, 'manifest.json'), `${JSON.stringify(changedManifest)}\n`);
    await expect(
      browserSoak.runRtcDataChannelBrowserSoakCli(rawArguments(primaryBaselineId, 'retained', 1), {
        baselineRootPath: rootPath,
        launchBrowser,
      }),
    ).rejects.toThrow('manifest');

    expect(launchBrowser).not.toHaveBeenCalled();
    expect(existsSync(join(rootPath, 'outside.json'))).toBe(false);
  } finally {
    rmSync(rootPath, { recursive: true, force: true });
  }
});

it('rejects changed initialized B05 controller identity before browser launch', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'rtc-b05-environment-'));
  const captureManifest = manifest(primaryBaselineId, 1);
  const baselinePath = writeInitializedBaseline(rootPath, captureManifest);
  const initializedEnvironment = environment(captureManifest);
  const launchBrowser = vi.fn(async () => fakeBrowser().browser);
  if (initializedEnvironment.observation === null) {
    throw new Error('Expected an initialized B05 runtime observation');
  }
  const changedObservation = {
    ...initializedEnvironment.observation,
    controllerInputs: initializedEnvironment.observation.controllerInputs.map((entry) =>
      entry.name === 'environmentId' ? { ...entry, value: 'E1-local' } : entry,
    ),
  };
  writeFileSync(
    join(baselinePath, 'environment.json'),
    `${JSON.stringify({ ...initializedEnvironment, observation: changedObservation })}\n`,
  );

  try {
    await expect(
      browserSoak.runRtcDataChannelBrowserSoakCli(rawArguments(primaryBaselineId, 'warmup', 1), {
        baselineRootPath: rootPath,
        launchBrowser,
      }),
    ).rejects.toThrow('environment');
    expect(launchBrowser).not.toHaveBeenCalled();
  } finally {
    rmSync(rootPath, { recursive: true, force: true });
  }
});

it('rejects a staged payload whose locator differs from the bridge command', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'rtc-b05-payload-'));
  const captureManifest = manifest(primaryBaselineId, 1);
  const baselinePath = writeInitializedBaseline(rootPath, captureManifest);
  const relativePath = rawRelativePath('warmup', 1);

  try {
    await browserSoak.runRtcDataChannelBrowserSoakCli(
      rawArguments(primaryBaselineId, 'warmup', 1),
      { baselineRootPath: rootPath, launchBrowser: async () => fakeBrowser().browser },
    );
    const staged = readExternalAttempt(join(baselinePath, relativePath));
    staged.locator.outerOrdinal = 2;
    const written: unknown[] = [];
    const { acceptance } = createAcceptance(captureManifest, staged, written);
    const result = await acceptance.recordBrowser({
      baselineId: primaryBaselineId,
      locator: {
        workloadId: 'RTC-B05',
        caseId,
        inputKey,
        intendedPhase: 'warmup',
        outerOrdinal: 1,
      },
      producerExitStatus: 0,
      rawResultRelativePath: relativePath,
    });
    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'attempt-locator-mismatch' }),
      ]),
    });
    expect(written[0]).toEqual(expect.objectContaining({ artifactKind: 'failure' }));
  } finally {
    rmSync(rootPath, { recursive: true, force: true });
  }
});

it('recomputes B05 lifecycle invariants after the bridge reads staged evidence', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'rtc-b05-bridge-validation-'));
  const captureManifest = manifest(primaryBaselineId, 1);
  const baselinePath = writeInitializedBaseline(rootPath, captureManifest);
  const relativePath = rawRelativePath('warmup', 1);

  try {
    await browserSoak.runRtcDataChannelBrowserSoakCli(
      rawArguments(primaryBaselineId, 'warmup', 1),
      { baselineRootPath: rootPath, launchBrowser: async () => fakeBrowser().browser },
    );
    const staged = readExternalAttempt(join(baselinePath, relativePath));
    const rawEvidence = staged.samples[0].rawEvidence;
    if (typeof rawEvidence !== 'object' || rawEvidence === null || Array.isArray(rawEvidence)) {
      throw new Error('Expected object-shaped RTC-B05 raw evidence');
    }
    const soak = Reflect.get(rawEvidence, 'soak');
    if (typeof soak !== 'object' || soak === null || Array.isArray(soak)) {
      throw new Error('Expected object-shaped RTC-B05 soak evidence');
    }
    Reflect.set(soak, 'openedCount', 24);

    const written: unknown[] = [];
    const { acceptance } = createAcceptance(captureManifest, staged, written);
    const result = await acceptance.recordBrowser({
      baselineId: primaryBaselineId,
      locator: {
        workloadId: 'RTC-B05',
        caseId,
        inputKey,
        intendedPhase: 'warmup',
        outerOrdinal: 1,
      },
      producerExitStatus: 0,
      rawResultRelativePath: relativePath,
    });

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'incomplete-open-count' })]),
    });
    expect(written[0]).toEqual(expect.objectContaining({ artifactKind: 'failure' }));
  } finally {
    rmSync(rootPath, { recursive: true, force: true });
  }
});

it('binds staged raw baseline identity to the trusted record-browser baseline', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'rtc-b05-baseline-binding-'));
  const captureManifest = manifest(primaryBaselineId, 1);
  const baselinePath = writeInitializedBaseline(rootPath, captureManifest);
  const relativePath = rawRelativePath('warmup', 1);

  try {
    await browserSoak.runRtcDataChannelBrowserSoakCli(
      rawArguments(primaryBaselineId, 'warmup', 1),
      { baselineRootPath: rootPath, launchBrowser: async () => fakeBrowser().browser },
    );
    const staged = readExternalAttempt(join(baselinePath, relativePath));
    const sample = staged.samples[0];
    const rawEvidence = rtcB05JsonObject(sample.rawEvidence, 'raw evidence');
    const rawIdentity = rtcB05JsonObject(rawEvidence.identity, 'raw identity');
    const producerCommand = rtcB05JsonObject(rawEvidence.producerCommand, 'producer command');
    const changedBaselineId = '20260815-ffffffffffff-e2-browser';
    rawIdentity.baselineId = changedBaselineId;
    producerCommand.arguments = [scriptPath, ...rawArguments(changedBaselineId, 'warmup', 1)];
    if (sample.runtimeObservation === null) {
      throw new Error('Expected initialized RTC-B05 runtime observation');
    }
    sample.runtimeObservation.controllerInputs = sample.runtimeObservation.controllerInputs.map(
      (entry) => (entry.name === 'baselineId' ? { ...entry, value: changedBaselineId } : entry),
    );

    const written: unknown[] = [];
    const { acceptance } = createAcceptance(captureManifest, staged, written);
    const result = await acceptance.recordBrowser({
      baselineId: primaryBaselineId,
      locator: {
        workloadId: 'RTC-B05',
        caseId,
        inputKey,
        intendedPhase: 'warmup',
        outerOrdinal: 1,
      },
      producerExitStatus: 0,
      rawResultRelativePath: relativePath,
    });

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'baseline-id-mismatch' })]),
    });
    expect(written[0]).toEqual(expect.objectContaining({ artifactKind: 'failure' }));
  } finally {
    rmSync(rootPath, { recursive: true, force: true });
  }
});

it('projects lifecycle failures and the bridge preserves the exact causal remainder', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'rtc-b05-failure-'));
  const captureManifest = manifest(primaryBaselineId, 1);
  const baselinePath = writeInitializedBaseline(rootPath, captureManifest);
  const launched = fakeBrowser(failedSoak);
  const relativePath = rawRelativePath('retained', 2);

  try {
    await browserSoak.runRtcDataChannelBrowserSoakCli(
      rawArguments(primaryBaselineId, 'retained', 2),
      {
        baselineRootPath: rootPath,
        launchBrowser: async () => launched.browser,
        nowUtc: () => fixedNow,
      },
    );
    const staged = readExternalAttempt(join(baselinePath, relativePath));
    const written: unknown[] = [];
    const { acceptance, readStagedJson } = createAcceptance(captureManifest, staged, written);
    const bridgeInput = {
      baselineId: primaryBaselineId,
      locator: {
        workloadId: 'RTC-B05' as const,
        caseId,
        inputKey,
        intendedPhase: 'retained' as const,
        outerOrdinal: 2,
      },
      producerExitStatus: 0,
      rawResultRelativePath: relativePath,
    };

    const result = await acceptance.recordBrowser(bridgeInput);
    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'incomplete-close-count' }),
        expect.objectContaining({ code: 'remote-error-count' }),
      ]),
    });
    expectCausalArtifacts(written);

    written.length = 0;
    readStagedJson.mockClear();
    const producerFailure = await acceptance.recordBrowser({
      ...bridgeInput,
      producerExitStatus: 9,
    });
    expect(producerFailure).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'producer-exit-status' })],
    });
    expect(readStagedJson).not.toHaveBeenCalled();
    expect(written).toHaveLength(4);
  } finally {
    rmSync(rootPath, { recursive: true, force: true });
  }
});

it('fails raw evidence when Chromium exposes only one forced-GC heap value', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'rtc-b05-heap-'));
  const captureManifest = manifest(primaryBaselineId, 1);
  const baselinePath = writeInitializedBaseline(rootPath, captureManifest);
  const launched = fakeBrowser(completedSoak, [1000, null]);
  const relativePath = rawRelativePath('warmup', 1);

  try {
    await browserSoak.runRtcDataChannelBrowserSoakCli(
      rawArguments(primaryBaselineId, 'warmup', 1),
      {
        baselineRootPath: rootPath,
        launchBrowser: async () => launched.browser,
      },
    );
    const staged = readExternalAttempt(join(baselinePath, relativePath));
    expect(staged.sampleOutcomes).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        issues: [expect.objectContaining({ code: 'incomplete-heap-metrics' })],
      }),
    ]);
    expect(staged.samples[0].metrics.map(({ metric }) => metric)).not.toContain('heapAfterBytes');
    const written: unknown[] = [];
    const { acceptance } = createAcceptance(captureManifest, staged, written);
    const accepted = await acceptance.recordBrowser({
      baselineId: primaryBaselineId,
      locator: {
        workloadId: 'RTC-B05',
        caseId,
        inputKey,
        intendedPhase: 'warmup',
        outerOrdinal: 1,
      },
      producerExitStatus: 0,
      rawResultRelativePath: relativePath,
    });
    expect(accepted).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'incomplete-heap-metrics' }),
      ]),
    });
    expect(launched.close).toHaveBeenCalledOnce();
  } finally {
    rmSync(rootPath, { recursive: true, force: true });
  }
});

it('closes the browser and leaves no raw file when native execution throws', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'rtc-b05-cleanup-'));
  const captureManifest = manifest(primaryBaselineId, 1);
  const baselinePath = writeInitializedBaseline(rootPath, captureManifest);
  const launched = fakeBrowser();
  launched.evaluate.mockRejectedValueOnce(new Error('page failed'));
  const relativePath = rawRelativePath('warmup', 1);

  try {
    await expect(
      browserSoak.runRtcDataChannelBrowserSoakCli(rawArguments(primaryBaselineId, 'warmup', 1), {
        baselineRootPath: rootPath,
        launchBrowser: async () => launched.browser,
      }),
    ).rejects.toThrow('page failed');
    expect(launched.close).toHaveBeenCalledOnce();
    expect(existsSync(join(baselinePath, relativePath))).toBe(false);
  } finally {
    rmSync(rootPath, { recursive: true, force: true });
  }
});
