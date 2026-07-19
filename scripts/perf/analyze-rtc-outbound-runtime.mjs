import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const OUTBOUND_TOPIC = 'rallar.browser.al.outbound_runtime';
const COMPLETED_TOPIC = 'rallar.browser.messages.rtc.send_completed';
const STREAM_TYPE_ID = 'black-box.group.multicast.position';
const FINALIZATION_MODES = [
  'background-existing-drain',
  'awaited-existing-drain',
  'awaited-new-drain',
  'deferred',
];
const EFFECT_KINDS = [
  'send-prepared',
  'enqueue-outbox',
  'fallback-dispatch',
  'ack-timeout',
  'repair-hint',
  'nack-retry',
];
const HISTOGRAM_KEYS = [
  'le0Ms',
  'le10Ms',
  'le50Ms',
  'le100Ms',
  'le250Ms',
  'le500Ms',
  'le1000Ms',
  'le2500Ms',
  'le5000Ms',
  'gt5000Ms',
];

function toNumericRecord(keys) {
  return Object.fromEntries(keys.map(key => [key, 0]));
}

function addNumericRecord(target, source) {
  for (const key of Object.keys(target)) {
    target[key] += Number(source?.[key] ?? 0);
  }
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * quantile) - 1,
  )];
}

function toStats(values) {
  return {
    count: values.length,
    min: values.length > 0 ? Math.min(...values) : null,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length > 0 ? Math.max(...values) : null,
    average: values.length > 0
      ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
      : null,
  };
}

function summarizeEnqueueByMode(matched) {
  return Object.fromEntries(
    FINALIZATION_MODES.map(mode => {
      const selected = matched.filter(event => event.mode === mode);
      return [mode, {
        count: selected.length,
        finalizationDurationMs: toStats(selected.map(event => event.durationMs)),
        sendDurationMs: toStats(selected.map(event => event.sendDurationMs)),
      }];
    }),
  );
}

function summarizeDrainComposition(drains) {
  const summary = {
    drainCount: drains.length,
    claimedByKind: toNumericRecord(EFFECT_KINDS),
    completedByKind: toNumericRecord(EFFECT_KINDS),
    rescheduledByKind: toNumericRecord(EFFECT_KINDS),
    claimedFirstAttemptCount: 0,
    claimedRetryAttemptCount: 0,
    firstAttemptReadyLateness: toNumericRecord(HISTOGRAM_KEYS),
    retryAttemptReadyLateness: toNumericRecord(HISTOGRAM_KEYS),
  };
  for (const drain of drains) {
    addNumericRecord(summary.claimedByKind, drain.claimedByKind);
    addNumericRecord(summary.completedByKind, drain.completedByKind);
    addNumericRecord(summary.rescheduledByKind, drain.rescheduledByKind);
    addNumericRecord(
      summary.firstAttemptReadyLateness,
      drain.firstAttemptReadyLateness,
    );
    addNumericRecord(
      summary.retryAttemptReadyLateness,
      drain.retryAttemptReadyLateness,
    );
    summary.claimedFirstAttemptCount +=
      Number(drain.claimedFirstAttemptCount ?? 0);
    summary.claimedRetryAttemptCount +=
      Number(drain.claimedRetryAttemptCount ?? 0);
  }
  return summary;
}

function toEventTimestamp(event) {
  return event.value?.payload?.atEpochMs ?? event.atEpochMs;
}

export function analyzeRtcOutboundRuntimeEvents(events) {
  const runtimeEvents = events
    .filter(event => event.value?.topic === OUTBOUND_TOPIC)
    .map(event => ({
      agentId: event.agentId,
      atEpochMs: toEventTimestamp(event),
      ...event.value.payload.data,
    }))
    .filter(event => event.runtime === 'rtc-overlay');
  const finalizationsByMessage = new Map();
  const drains = [];
  for (const event of runtimeEvents) {
    if (event.kind === 'outbound-finalization') {
      const key = event.agentId + '\0' + event.message.msgId;
      const bucket = finalizationsByMessage.get(key) ?? [];
      bucket.push(event);
      finalizationsByMessage.set(key, bucket);
      continue;
    }
    if (event.kind === 'effect-drain') {
      drains.push(event);
    }
  }

  const completions = events.flatMap(event => {
    if (event.value?.topic !== COMPLETED_TOPIC) return [];
    const message = event.value.payload.data?.message?.message;
    if (!message || message.payload?.typeId !== STREAM_TYPE_ID) return [];
    return [{
      agentId: event.agentId,
      atEpochMs: toEventTimestamp(event),
      message,
    }];
  });
  const matched = [];
  const completedByAgent = new Map();
  const missingByAgent = new Map();
  const ambiguousByAgent = new Map();
  let missingEnqueueFinalizations = 0;
  let ambiguousEnqueueFinalizations = 0;
  for (const completion of completions) {
    completedByAgent.set(
      completion.agentId,
      (completedByAgent.get(completion.agentId) ?? 0) + 1,
    );
    const key = completion.agentId + '\0' + completion.message.id.msgId;
    const candidates = (finalizationsByMessage.get(key) ?? [])
      .filter(event =>
        event.intent === 'enqueue' &&
        event.phase === 'immediate' &&
        event.atEpochMs <= completion.atEpochMs
      )
      .sort((left, right) => left.atEpochMs - right.atEpochMs);
    if (candidates.length === 0) {
      missingEnqueueFinalizations += 1;
      missingByAgent.set(
        completion.agentId,
        (missingByAgent.get(completion.agentId) ?? 0) + 1,
      );
      continue;
    }
    if (candidates.length > 1) {
      ambiguousEnqueueFinalizations += 1;
      ambiguousByAgent.set(
        completion.agentId,
        (ambiguousByAgent.get(completion.agentId) ?? 0) + 1,
      );
    }
    matched.push({
      ...candidates[0],
      sendDurationMs: completion.atEpochMs - completion.message.id.ts,
    });
  }

  const enqueueByMode = summarizeEnqueueByMode(matched);
  const drainComposition = summarizeDrainComposition(drains);
  const agentIds = new Set([
    ...runtimeEvents.map(event => event.agentId),
    ...completions.map(event => event.agentId),
  ]);
  const agents = Object.fromEntries(
    [...agentIds].sort().map(agentId => {
      const agentMatched = matched.filter(event => event.agentId === agentId);
      return [agentId, {
        coverage: {
          completedStreamMessages: completedByAgent.get(agentId) ?? 0,
          matchedEnqueueFinalizations: agentMatched.length,
          missingEnqueueFinalizations: missingByAgent.get(agentId) ?? 0,
          ambiguousEnqueueFinalizations: ambiguousByAgent.get(agentId) ?? 0,
        },
        enqueueByMode: summarizeEnqueueByMode(agentMatched),
        drainComposition: summarizeDrainComposition(
          drains.filter(event => event.agentId === agentId),
        ),
      }];
    }),
  );

  const evidenceErrors = [];
  if (completions.length === 0) {
    evidenceErrors.push(
      'No completed stream messages are available for outbound runtime analysis.',
    );
  }
  if (missingEnqueueFinalizations > 0) {
    evidenceErrors.push(
      missingEnqueueFinalizations +
        ' completed stream messages are missing enqueue finalization diagnostics.',
    );
  }
  if (ambiguousEnqueueFinalizations > 0) {
    evidenceErrors.push(
      ambiguousEnqueueFinalizations +
        ' completed stream messages have ambiguous enqueue finalization diagnostics.',
    );
  }
  return {
    coverage: {
      completedStreamMessages: completions.length,
      matchedEnqueueFinalizations: matched.length,
      missingEnqueueFinalizations,
      ambiguousEnqueueFinalizations,
    },
    enqueueByMode,
    drainComposition,
    agents,
    evidenceErrors,
  };
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(JSON.parse);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const artifactDir = process.argv[2];
  if (!artifactDir) {
    throw new Error(
      'Usage: node analyze-rtc-outbound-runtime.mjs <artifact-directory>',
    );
  }
  const result = analyzeRtcOutboundRuntimeEvents(
    readJsonl(path.join(artifactDir, 'events.jsonl')),
  );
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.evidenceErrors.length > 0) {
    process.exitCode = 2;
  }
}
