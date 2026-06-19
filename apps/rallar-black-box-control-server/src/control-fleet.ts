import type {
  ControlDistributedRunCommandLink,
  ControlDistributedRunSnapshot,
  ControlRunSnapshot,
} from './control-service.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import type { RallarBlackBoxTestRedactionOptions } from '@shared-test/rallar-bb-test/types.ts';
import {
  type ControlFleetAgentLabel,
  type ControlFleetAgentRunOutcome,
  type ControlFleetAgentState,
  type ControlFleetAggregateReport,
  type ControlFleetFailureSignature,
  type ControlFleetRegionSummary,
  type ControlFleetReportBundle,
  type ControlFleetRunReport,
  type ControlFleetTimingDistribution,
  RALLAR_BLACK_BOX_FLEET_REPORT_SCHEMA_VERSION,
} from '@shared-test/rallar-bb-test/fleet-report.ts';
import { isDistributedRunTerminalState } from '@shared-test/rallar-bb-test/distributed-run.ts';

const UNKNOWN_REGION = 'unlabeled-region';
const UNKNOWN_PROVIDER = 'unknown-provider';
const STALE_HEARTBEAT_MS = 30_000;

type FleetReportFilter = Readonly<{
  region?: string;
  provider?: string;
  recipeId?: string;
  groupId?: string;
  state?: string;
  fromEpochMs?: number;
  toEpochMs?: number;
}>;

type MutableFailureSignature = {
  signatureId: string;
  category: ControlFleetFailureSignature['category'];
  title: string;
  normalizedMessage: string;
  code?: string;
  recipeId?: string;
  commandKind?: string;
  diagnosticTypeId?: string;
  transport?: string;
  count: number;
  firstSeenAtEpochMs?: number;
  lastSeenAtEpochMs?: number;
  affectedAgents: Set<string>;
  affectedRegions: Set<string>;
  affectedRuns: Set<string>;
  likelyCause: string;
  nextAction: string;
};

export function createControlFleetRunReport(
  input: Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    controlRun?: ControlRunSnapshot;
    generatedAtEpochMs: number;
    redaction?: RallarBlackBoxTestRedactionOptions;
  }>,
): ControlFleetRunReport {
  const commandMap = new Map(
    (input.controlRun?.commands ?? [])
      .map((command) => [command.envelope.commandId, command]),
  );
  const resultsByCommandId = new Map(
    (input.controlRun?.results ?? [])
      .map((result) => [result.commandId, result]),
  );
  const agentsById = new Map(
    (input.controlRun?.agents ?? [])
      .map((agent) => [agent.agentId, agent]),
  );
  const labelByAgentId = new Map<string, ControlFleetAgentLabel>();
  input.distributedRun.targetAgentIds.forEach((agentId) => {
    labelByAgentId.set(agentId, labelFromAgent(agentId, agentsById.get(agentId)));
  });

  const failureSignatures = new Map<string, MutableFailureSignature>();
  const failureIdsByAgent = new Map<string, Set<string>>();
  const commandDurations: number[] = [];

  for (const result of input.controlRun?.results ?? []) {
    if (!input.distributedRun.commandLinks.some((link) => link.commandId === result.commandId)) {
      continue;
    }
    const duration = resultDurationMs(result);
    if (duration !== undefined) {
      commandDurations.push(duration);
    }
    if (!result.ok) {
      const link = input.distributedRun.commandLinks.find((candidate) =>
        candidate.commandId === result.commandId
      );
      const command = commandMap.get(result.commandId);
      const commandError = result.error ?? result.result?.error;
      addFailureSignature({
        signatures: failureSignatures,
        labels: labelByAgentId,
        runId: input.distributedRun.distributedRunId,
        agentId: result.agentId,
        category: 'command',
        title: 'Command failure',
        code: errorCode(commandError),
        message: errorMessage(commandError) ?? 'Distributed command failed.',
        recipeId: link?.recipeId,
        commandKind: command?.envelope.command.kind,
        atEpochMs: result.result?.endedAtEpochMs ?? result.result?.startedAtEpochMs,
        failureIdsByAgent,
      });
    }
  }

  for (const failure of input.distributedRun.rollup.failures) {
    const affectedAgents = input.distributedRun.targetAgentIds
      .filter((agentId) => failure.key.includes(agentId));
    const agents = affectedAgents.length > 0 ? affectedAgents : input.distributedRun.targetAgentIds;
    agents.forEach((agentId) => {
      addFailureSignature({
        signatures: failureSignatures,
        labels: labelByAgentId,
        runId: input.distributedRun.distributedRunId,
        agentId,
        category: failureCategory(failure.error?.code, failure.error?.message),
        title: failure.kind === 'recipe' ? 'Recipe failure' : 'Participant failure',
        code: failure.error?.code,
        message: failure.error?.message ?? `${failure.kind} ${failure.state}`,
        recipeId: failure.kind === 'recipe' ? failure.key : undefined,
        atEpochMs: input.distributedRun.completedAtEpochMs ?? input.distributedRun.updatedAtEpochMs,
        failureIdsByAgent,
      });
    });
  }

  for (const event of input.controlRun?.events ?? []) {
    if (!linkedEvent(input.distributedRun, event.commandId, event.payload)) {
      continue;
    }
    const diagnostic = diagnosticFields(event.payload);
    if (!diagnostic || (diagnostic.severity !== 'error' && diagnostic.severity !== 'warning')) {
      continue;
    }
    addFailureSignature({
      signatures: failureSignatures,
      labels: labelByAgentId,
      runId: input.distributedRun.distributedRunId,
      agentId: event.agentId,
      category: 'diagnostic',
      title: 'Runtime diagnostic',
      code: diagnostic.severity,
      message: diagnostic.message,
      diagnosticTypeId: diagnostic.diagnosticTypeId,
      transport: diagnostic.transport,
      atEpochMs: event.atEpochMs,
      failureIdsByAgent,
    });
  }

  const outcomes = input.distributedRun.targetAgentIds.map((agentId) =>
    agentOutcome({
      agentId,
      distributedRun: input.distributedRun,
      controlRun: input.controlRun,
      links: input.distributedRun.commandLinks.filter((link) => link.agentId === agentId),
      resultsByCommandId,
      label: labelByAgentId.get(agentId) ?? { agentId },
      failureSignatureIds: [...(failureIdsByAgent.get(agentId) ?? [])].sort(),
      generatedAtEpochMs: input.generatedAtEpochMs,
    })
  );
  const regions = regionSummaries(outcomes);
  const failures = [...failureSignatures.values()]
    .map(toFailureSignature)
    .sort((left, right) =>
      right.count - left.count || left.signatureId.localeCompare(right.signatureId)
    );
  const runDuration = distributedRunDuration(input.distributedRun);
  const report = {
    fleetReportSchemaVersion: RALLAR_BLACK_BOX_FLEET_REPORT_SCHEMA_VERSION,
    distributedRunId: input.distributedRun.distributedRunId,
    controlRunId: input.distributedRun.controlRunId,
    generatedAtEpochMs: input.generatedAtEpochMs,
    state: input.distributedRun.state,
    ok: input.distributedRun.rollup.ok,
    group: input.distributedRun.manifest.group,
    recipeIds: input.distributedRun.manifest.recipes
      .map((selection) => selection.recipeId ?? selection.recipe?.recipeId ?? selection.role)
      .filter((value): value is string => Boolean(value)),
    runDurationMs: runDuration,
    summary: {
      agents: outcomes.length,
      regions:
        uniqueValues(outcomes.map((outcome) => outcome.label.region ?? UNKNOWN_REGION)).length,
      passed: outcomes.filter((outcome) => outcome.state === 'passed').length,
      failed:
        outcomes.filter((outcome) => outcome.state === 'failed' || outcome.state === 'timed-out')
          .length,
      missing: outcomes.filter((outcome) => outcome.missing).length,
      flaky: outcomes.filter((outcome) => outcome.flaky).length,
      stale: outcomes.filter((outcome) => outcome.stale).length,
      passRate: ratio(
        outcomes.filter((outcome) => outcome.state === 'passed').length,
        outcomes.length,
      ),
      failureGroups: failures.length,
    },
    timing: {
      run: timingDistribution(runDuration === undefined ? [] : [runDuration]),
      commands: timingDistribution(commandDurations),
    },
    agents: outcomes,
    regions,
    failureSignatures: failures,
    artifactRefs: {
      distributedRun: `distributed-run:${input.distributedRun.distributedRunId}`,
      controlRun: `control-run:${input.distributedRun.controlRunId}`,
      fleetReport: `fleet-report:${input.distributedRun.distributedRunId}`,
    },
  } satisfies ControlFleetRunReport;
  return redactRallarBlackBoxValue(report, input.redaction);
}

export function createControlFleetAggregateReport(
  reports: readonly ControlFleetRunReport[],
  generatedAtEpochMs = Date.now(),
): ControlFleetAggregateReport {
  const agentIds = uniqueValues(
    reports.flatMap((report) => report.agents.map((agent) => agent.agentId)),
  );
  const regions = aggregateRegions(reports);
  const failures = aggregateFailureSignatures(reports);
  const passed = reports.reduce((count, report) => count + report.summary.passed, 0);
  const totalAgents = reports.reduce((count, report) => count + report.summary.agents, 0);
  return {
    generatedAtEpochMs,
    reportCount: reports.length,
    runCount: uniqueValues(reports.map((report) => report.distributedRunId)).length,
    agentCount: agentIds.length,
    regionCount: regions.length,
    passRate: ratio(passed, totalAgents),
    staleAgentCount: uniqueValues(
      reports.flatMap((report) =>
        report.agents.filter((agent) => agent.stale).map((agent) => agent.agentId)
      ),
    ).length,
    flakyAgentCount: flakyAgentIds(reports).length,
    failureGroupCount: failures.length,
    timing: {
      runs: timingDistribution(
        reports.flatMap((report) =>
          report.runDurationMs === undefined ? [] : [report.runDurationMs]
        ),
      ),
      commands: timingDistribution(reports.flatMap((report) =>
        [
          report.timing.commands.minMs,
          report.timing.commands.p50Ms,
          report.timing.commands.p90Ms,
          report.timing.commands.p95Ms,
          report.timing.commands.maxMs,
        ].filter((value): value is number => value !== undefined)
      )),
    },
    regions,
    failureSignatures: failures,
  };
}

export function filterControlFleetReports(
  reports: readonly ControlFleetRunReport[],
  filter: FleetReportFilter,
): readonly ControlFleetRunReport[] {
  return reports
    .filter((report) => {
      if (filter.region && !report.regions.some((region) => region.region === filter.region)) {
        return false;
      }
      if (
        filter.provider && !report.regions.some((region) => region.provider === filter.provider)
      ) return false;
      if (filter.recipeId && !report.recipeIds.includes(filter.recipeId)) return false;
      if (filter.groupId && report.group.groupId !== filter.groupId) return false;
      if (filter.state && report.state !== filter.state) return false;
      if (filter.fromEpochMs !== undefined && report.generatedAtEpochMs < filter.fromEpochMs) {
        return false;
      }
      if (filter.toEpochMs !== undefined && report.generatedAtEpochMs > filter.toEpochMs) {
        return false;
      }
      return true;
    })
    .sort((left, right) => right.generatedAtEpochMs - left.generatedAtEpochMs);
}

export function createControlFleetReportBundle(
  report: ControlFleetRunReport,
): ControlFleetReportBundle {
  return {
    fleetReportSchemaVersion: RALLAR_BLACK_BOX_FLEET_REPORT_SCHEMA_VERSION,
    distributedRunId: report.distributedRunId,
    generatedAtEpochMs: Date.now(),
    files: {
      'fleet-report.json': JSON.stringify(report, null, 2),
      'summary.md': fleetSummaryMarkdown(report),
      'agent-results.csv': csv([
        [
          'agentId',
          'region',
          'provider',
          'state',
          'durationMs',
          'failedCommandCount',
          'reconnectCount',
          'stale',
        ],
        ...report.agents.map((agent) => [
          agent.agentId,
          agent.label.region ?? '',
          agent.label.provider ?? '',
          agent.state,
          stringValue(agent.durationMs),
          String(agent.failedCommandCount),
          String(agent.reconnectCount),
          String(agent.stale),
        ]),
      ]),
      'failure-signatures.csv': csv([
        [
          'signatureId',
          'category',
          'code',
          'recipeId',
          'transport',
          'count',
          'affectedAgents',
          'affectedRegions',
          'nextAction',
        ],
        ...report.failureSignatures.map((signature) => [
          signature.signatureId,
          signature.category,
          signature.code ?? '',
          signature.recipeId ?? '',
          signature.transport ?? '',
          String(signature.count),
          signature.affectedAgents.join('|'),
          signature.affectedRegions.join('|'),
          signature.nextAction,
        ]),
      ]),
    },
  };
}

export function fleetReportFilterFromUrl(url: URL): FleetReportFilter {
  return {
    region: optionalParam(url, 'region'),
    provider: optionalParam(url, 'provider'),
    recipeId: optionalParam(url, 'recipeId'),
    groupId: optionalParam(url, 'groupId'),
    state: optionalParam(url, 'state'),
    fromEpochMs: numberParam(url, 'fromEpochMs'),
    toEpochMs: numberParam(url, 'toEpochMs'),
  };
}

function agentOutcome(
  input: Readonly<{
    agentId: string;
    distributedRun: ControlDistributedRunSnapshot;
    controlRun?: ControlRunSnapshot;
    links: readonly ControlDistributedRunCommandLink[];
    resultsByCommandId: ReadonlyMap<string, ControlRunSnapshot['results'][number]>;
    label: ControlFleetAgentLabel;
    failureSignatureIds: readonly string[];
    generatedAtEpochMs: number;
  }>,
): ControlFleetAgentRunOutcome {
  const results = input.links
    .map((link) => input.resultsByCommandId.get(link.commandId))
    .filter((result): result is ControlRunSnapshot['results'][number] => Boolean(result));
  const failedResults = results.filter((result) => !result.ok);
  const agent = input.controlRun?.agents.find((candidate) => candidate.agentId === input.agentId);
  const eventCount =
    input.controlRun?.events.filter((event) => event.agentId === input.agentId).length ?? 0;
  const diagnosticCount = input.controlRun?.events
    .filter((event) => event.agentId === input.agentId && diagnosticFields(event.payload))
    .length ?? 0;
  const durations = results
    .map(resultDurationMs)
    .filter((duration): duration is number => duration !== undefined);
  const terminal = isDistributedRunTerminalState(input.distributedRun.state);
  const missing = terminal && input.links.length > 0 && results.length < input.links.length;
  const state = agentOutcomeState(
    input.distributedRun.state,
    failedResults.length,
    missing,
    input.failureSignatureIds.length,
    terminal,
  );
  return {
    agentId: input.agentId,
    label: input.label,
    state,
    ok: state === 'passed',
    missing,
    flaky: false,
    stale: isStale(agent?.lastHeartbeatAtEpochMs, input.generatedAtEpochMs),
    commandCount: input.links.length,
    failedCommandCount: failedResults.length,
    resultCount: results.length,
    eventCount,
    diagnosticCount,
    reconnectCount: agent?.reconnectCount ?? 0,
    durationMs: durations.length > 0 ? Math.max(...durations) : undefined,
    lastHeartbeatAtEpochMs: agent?.lastHeartbeatAtEpochMs,
    failureSignatureIds: input.failureSignatureIds,
  };
}

function agentOutcomeState(
  runState: ControlDistributedRunSnapshot['state'],
  failedResults: number,
  missing: boolean,
  failureSignatures: number,
  terminal: boolean,
): ControlFleetAgentState {
  if (runState === 'cancelled') return 'cancelled';
  if (runState === 'timed-out' && (missing || failureSignatures > 0)) return 'timed-out';
  if (failedResults > 0 || failureSignatures > 0) return 'failed';
  if (missing) return 'missing';
  if (!terminal) return 'running';
  if (runState === 'passed' || runState === 'failed' || runState === 'timed-out') return 'passed';
  return 'unknown';
}

function labelFromAgent(
  agentId: string,
  agent: ControlRunSnapshot['agents'][number] | undefined,
): ControlFleetAgentLabel {
  const identity = agent?.identity;
  return {
    agentId,
    region: identity?.region,
    provider: identity?.provider,
    datacenter: identity?.datacenter,
    hostId: identity?.hostId,
    agentPoolId: identity?.agentPoolId,
    deploymentId: identity?.deploymentId,
    browserName: identity?.browserName,
    browserVersion: identity?.browserVersion,
    os: identity?.os,
    tags: identity?.tags,
  };
}

function addFailureSignature(
  input: Readonly<{
    signatures: Map<string, MutableFailureSignature>;
    labels: ReadonlyMap<string, ControlFleetAgentLabel>;
    runId: string;
    agentId: string;
    category: ControlFleetFailureSignature['category'];
    title: string;
    message: string;
    code?: string;
    recipeId?: string;
    commandKind?: string;
    diagnosticTypeId?: string;
    transport?: string;
    atEpochMs?: number;
    failureIdsByAgent: Map<string, Set<string>>;
  }>,
): void {
  const normalizedMessage = normalizeMessage(input.message);
  const signatureId = safeSignatureId([
    input.category,
    input.code,
    input.recipeId,
    input.commandKind,
    input.diagnosticTypeId,
    input.transport,
    normalizedMessage,
  ]);
  const label = input.labels.get(input.agentId);
  const region = label?.region ?? UNKNOWN_REGION;
  const existing = input.signatures.get(signatureId);
  const signature = existing ?? {
    signatureId,
    category: input.category,
    title: input.title,
    normalizedMessage,
    code: input.code,
    recipeId: input.recipeId,
    commandKind: input.commandKind,
    diagnosticTypeId: input.diagnosticTypeId,
    transport: input.transport,
    count: 0,
    affectedAgents: new Set<string>(),
    affectedRegions: new Set<string>(),
    affectedRuns: new Set<string>(),
    likelyCause: likelyCause(input.category, input.code, input.message),
    nextAction: nextAction(input.category, input.code, input.transport),
  };
  signature.count += 1;
  signature.firstSeenAtEpochMs = minDefined(signature.firstSeenAtEpochMs, input.atEpochMs);
  signature.lastSeenAtEpochMs = maxDefined(signature.lastSeenAtEpochMs, input.atEpochMs);
  signature.affectedAgents.add(input.agentId);
  signature.affectedRegions.add(region);
  signature.affectedRuns.add(input.runId);
  input.signatures.set(signatureId, signature);

  const ids = input.failureIdsByAgent.get(input.agentId) ?? new Set<string>();
  ids.add(signatureId);
  input.failureIdsByAgent.set(input.agentId, ids);
}

function toFailureSignature(signature: MutableFailureSignature): ControlFleetFailureSignature {
  return {
    ...signature,
    affectedAgents: [...signature.affectedAgents].sort(),
    affectedRegions: [...signature.affectedRegions].sort(),
    affectedRuns: [...signature.affectedRuns].sort(),
  };
}

function regionSummaries(
  outcomes: readonly ControlFleetAgentRunOutcome[],
): readonly ControlFleetRegionSummary[] {
  const groups = new Map<string, ControlFleetAgentRunOutcome[]>();
  outcomes.forEach((outcome) => {
    const key = `${outcome.label.region ?? UNKNOWN_REGION}\u0000${
      outcome.label.provider ?? UNKNOWN_PROVIDER
    }`;
    groups.set(key, [...(groups.get(key) ?? []), outcome]);
  });
  return [...groups.entries()].map(([key, rows]) => {
    const [region, provider] = key.split('\u0000');
    const failureCounts = countValues(rows.flatMap((row) => row.failureSignatureIds));
    return {
      region,
      provider,
      agentCount: rows.length,
      passed: rows.filter((row) => row.state === 'passed').length,
      failed: rows.filter((row) => row.state === 'failed' || row.state === 'timed-out').length,
      missing: rows.filter((row) => row.missing).length,
      flaky: rows.filter((row) => row.flaky).length,
      stale: rows.filter((row) => row.stale).length,
      passRate: ratio(rows.filter((row) => row.state === 'passed').length, rows.length),
      timing: timingDistribution(
        rows.flatMap((row) => row.durationMs === undefined ? [] : [row.durationMs]),
      ),
      dominantFailureSignatureId: [...failureCounts.entries()].sort((left, right) =>
        right[1] - left[1]
      )[0]?.[0],
    };
  }).sort((left, right) =>
    left.region.localeCompare(right.region) ||
    (left.provider ?? '').localeCompare(right.provider ?? '')
  );
}

function aggregateRegions(
  reports: readonly ControlFleetRunReport[],
): readonly ControlFleetRegionSummary[] {
  return regionSummaries(reports.flatMap((report) =>
    report.agents.map((agent) => ({
      ...agent,
      flaky: false,
    }))
  ));
}

function aggregateFailureSignatures(
  reports: readonly ControlFleetRunReport[],
): readonly ControlFleetFailureSignature[] {
  const map = new Map<string, MutableFailureSignature>();
  reports.flatMap((report) => report.failureSignatures).forEach((signature) => {
    const existing = map.get(signature.signatureId) ?? {
      ...signature,
      count: 0,
      affectedAgents: new Set<string>(),
      affectedRegions: new Set<string>(),
      affectedRuns: new Set<string>(),
    };
    existing.count += signature.count;
    existing.firstSeenAtEpochMs = minDefined(
      existing.firstSeenAtEpochMs,
      signature.firstSeenAtEpochMs,
    );
    existing.lastSeenAtEpochMs = maxDefined(
      existing.lastSeenAtEpochMs,
      signature.lastSeenAtEpochMs,
    );
    signature.affectedAgents.forEach((agentId) => existing.affectedAgents.add(agentId));
    signature.affectedRegions.forEach((region) => existing.affectedRegions.add(region));
    signature.affectedRuns.forEach((runId) => existing.affectedRuns.add(runId));
    map.set(signature.signatureId, existing);
  });
  return [...map.values()].map(toFailureSignature)
    .sort((left, right) =>
      right.count - left.count || left.signatureId.localeCompare(right.signatureId)
    );
}

function timingDistribution(values: readonly number[]): ControlFleetTimingDistribution {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) =>
    left - right
  );
  return {
    count: sorted.length,
    minMs: sorted[0],
    p50Ms: percentile(sorted, 0.5),
    p90Ms: percentile(sorted, 0.9),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1],
  };
}

function percentile(sorted: readonly number[], point: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * point) - 1));
  return sorted[index];
}

function distributedRunDuration(run: ControlDistributedRunSnapshot): number | undefined {
  const start = run.startedAtEpochMs ?? run.stagedAtEpochMs ?? run.createdAtEpochMs;
  const end = run.completedAtEpochMs ?? run.updatedAtEpochMs;
  return end !== undefined && start !== undefined ? Math.max(0, end - start) : undefined;
}

function resultDurationMs(result: ControlRunSnapshot['results'][number]): number | undefined {
  if (typeof result.result?.durationMs === 'number') return result.result.durationMs;
  if (
    typeof result.result?.startedAtEpochMs === 'number' &&
    typeof result.result?.endedAtEpochMs === 'number'
  ) {
    return Math.max(0, result.result.endedAtEpochMs - result.result.startedAtEpochMs);
  }
  return undefined;
}

function linkedEvent(
  run: ControlDistributedRunSnapshot,
  commandId: string | undefined,
  payload: unknown,
): boolean {
  const linkedCommandIds = new Set(run.commandLinks.map((link) => link.commandId));
  return (commandId !== undefined && linkedCommandIds.has(commandId)) ||
    safeJson(payload).includes(run.distributedRunId);
}

function diagnosticFields(payload: unknown):
  | Readonly<{
    severity: string;
    message: string;
    diagnosticTypeId: string;
    transport?: string;
  }>
  | undefined {
  const record = asRecord(payload);
  const inner = asRecord(record.payload);
  const data = asRecord(record.data);
  const severity = firstString(record.severity, inner.severity, data.severity);
  const topic = firstString(
    record.diagnosticTypeId,
    inner.diagnosticTypeId,
    data.diagnosticTypeId,
    record.topic,
    inner.topic,
  );
  if (!severity && !topic) return undefined;
  return {
    severity: severity ?? 'info',
    message:
      firstString(record.message, inner.message, data.message, record.reason, inner.reason) ??
        topic ?? 'diagnostic',
    diagnosticTypeId: topic ?? 'runtime.diagnostic',
    transport: firstString(record.transport, inner.transport, data.transport),
  };
}

function failureCategory(
  code: string | undefined,
  message: string | undefined,
): ControlFleetFailureSignature['category'] {
  const text = `${code ?? ''} ${message ?? ''}`.toLowerCase();
  if (text.includes('target')) return 'targeting';
  if (text.includes('ack')) return 'readiness';
  if (text.includes('barrier')) return 'barrier';
  if (text.includes('diagnostic')) return 'diagnostic';
  if (text.includes('runtime')) return 'runtime';
  if (code || message) return 'command';
  return 'unknown';
}

function likelyCause(
  category: ControlFleetFailureSignature['category'],
  code: string | undefined,
  message: string,
): string {
  if (category === 'targeting') {
    return 'The resolved agent fleet did not match the distributed target policy.';
  }
  if (category === 'readiness') {
    return 'One or more agents did not acknowledge staging before the timeout.';
  }
  if (category === 'barrier') {
    return 'One or more agents did not reach synchronized barrier readiness.';
  }
  if (category === 'diagnostic') {
    return 'Runtime transport diagnostics correlated with the distributed run.';
  }
  if (category === 'command') {
    return message || code || 'A recipe command failed on at least one agent.';
  }
  return message || 'The distributed run recorded a failure without a more specific category.';
}

function nextAction(
  category: ControlFleetFailureSignature['category'],
  code: string | undefined,
  transport: string | undefined,
): string {
  if (category === 'targeting') {
    return 'Check agent group/application/workspace labels and expected participant count.';
  }
  if (category === 'readiness') {
    return 'Inspect missing ACK agents and confirm they are logged in, connected, and not blocked on recipe load.';
  }
  if (category === 'barrier') {
    return 'Compare per-agent barrier readiness and reconnect/heartbeat history.';
  }
  if (category === 'diagnostic' && transport === 'ws') {
    return 'Inspect WebSocket subscription/topic evidence for affected regions.';
  }
  if (category === 'diagnostic') {
    return 'Inspect RTC lane, peer, group, and topic evidence for affected agents.';
  }
  if (code?.includes('ASSERT')) {
    return 'Open the failing command result and compare expected vs observed payload evidence.';
  }
  return 'Open the run report, first failure, and raw evidence for one affected agent.';
}

function errorCode(error: unknown): string | undefined {
  return firstString(asRecord(error).code);
}

function errorMessage(error: unknown): string | undefined {
  return firstString(asRecord(error).message);
}

function normalizeMessage(value: string): string {
  return value.toLowerCase()
    .replaceAll(/[0-9a-f]{8,}/g, '<id>')
    .replaceAll(/\d+/g, '<n>')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function safeSignatureId(values: readonly (string | undefined)[]): string {
  const joined = values.filter(Boolean).join('|') || 'unknown';
  const safe = joined.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '');
  return safe.slice(0, 96) || 'unknown';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function uniqueValues(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function countValues(values: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  values.forEach((value) => map.set(value, (map.get(value) ?? 0) + 1));
  return map;
}

function flakyAgentIds(reports: readonly ControlFleetRunReport[]): readonly string[] {
  const states = new Map<string, Set<string>>();
  reports.flatMap((report) => report.agents).forEach((agent) => {
    const set = states.get(agent.agentId) ?? new Set<string>();
    set.add(agent.ok ? 'passed' : 'not-passed');
    states.set(agent.agentId, set);
  });
  return [...states.entries()].filter(([, set]) => set.size > 1).map(([agentId]) => agentId).sort();
}

function isStale(lastHeartbeatAtEpochMs: number | undefined, generatedAtEpochMs: number): boolean {
  return lastHeartbeatAtEpochMs === undefined ||
    generatedAtEpochMs - lastHeartbeatAtEpochMs > STALE_HEARTBEAT_MS;
}

function minDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function maxDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function csv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function fleetSummaryMarkdown(report: ControlFleetRunReport): string {
  return [
    `# Fleet Run Report: ${report.distributedRunId}`,
    '',
    `State: ${report.state}`,
    `Pass rate: ${Math.round(report.summary.passRate * 100)}%`,
    `Agents: ${report.summary.agents}`,
    `Regions: ${report.summary.regions}`,
    `Failure groups: ${report.summary.failureGroups}`,
    '',
    '## Dominant Failures',
    ...report.failureSignatures.slice(0, 8).map((signature) =>
      `- ${signature.title}: ${signature.count} occurrence(s), ${
        signature.affectedRegions.join(', ') || 'no region'
      } - ${signature.nextAction}`
    ),
  ].join('\n');
}

function optionalParam(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key)?.trim();
  return value ? value : undefined;
}

function numberParam(url: URL, key: string): number | undefined {
  const value = Number(url.searchParams.get(key) ?? '');
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return '';
  }
}
