type Result = Readonly<Record<string, unknown>>;

function resultKey(result: Result): string {
  return String(result.resultKey ?? result.stepResultKey ?? result.name ?? 'unknown');
}

function resultsByName(results: readonly Result[]): Record<string, readonly Result[]> {
  return results.reduce<Record<string, Result[]>>((grouped, result) => {
    const name = String(result.name ?? 'unknown');
    grouped[name] = [...(grouped[name] ?? []), result];
    return grouped;
  }, {});
}

// Connection message stores from storm-scale runs can exceed the JSON string
// length limit when the report is written; the events artifact keeps its own
// truncated stream, so the report retains a bounded per-connection tail.
const ARTIFACT_STORE_ENTRY_LIMIT_PER_KEY = 50;

const BOUNDED_ARTIFACT_STORE_NAMES = [
  'wsMessages',
  'wsCloseEvents',
  'rtcMessages',
  'rtcDiagnostics',
  'rtcCloseEvents',
] as const;

export function withBoundedArtifactReportStores(report: any): any {
  let total = 0;
  let omitted = 0;
  const boundedStores: Record<string, unknown> = {};
  for (const storeName of BOUNDED_ARTIFACT_STORE_NAMES) {
    const store = report?.[storeName];
    if (!store || typeof store !== 'object' || Array.isArray(store)) continue;
    const boundedStore: Record<string, unknown> = {};
    for (const [key, entries] of Object.entries(store as Record<string, unknown>)) {
      if (!Array.isArray(entries)) {
        boundedStore[key] = entries;
        continue;
      }
      total += entries.length;
      omitted += Math.max(0, entries.length - ARTIFACT_STORE_ENTRY_LIMIT_PER_KEY);
      boundedStore[key] = entries.slice(-ARTIFACT_STORE_ENTRY_LIMIT_PER_KEY);
    }
    boundedStores[storeName] = boundedStore;
  }
  if (omitted <= 0) return report;
  return {
    ...report,
    ...boundedStores,
    artifact: {
      ...report.artifact,
      storeEntryLimitPerKey: ARTIFACT_STORE_ENTRY_LIMIT_PER_KEY,
      storeEntriesTotal: total,
      storeEntriesOmitted: omitted,
      storeEntriesTruncated: true,
    },
  };
}

export function withBoundedArtifactReportResults(report: any, configuredLimit: unknown): any {
  const limit = Number(configuredLimit);
  if (!Number.isInteger(limit) || limit < 0) return report;
  const all = Array.isArray(report?.resultsList) ? (report.resultsList as Result[]) : [];
  if (all.length <= limit) return report;
  const failures = all.filter((result) => result.status === 'FAILURE');
  const successes = all
    .filter((result) => result.status !== 'FAILURE')
    .slice(0, Math.max(0, limit - failures.length));
  const retained = [...successes, ...failures];
  return {
    ...report,
    results: Object.fromEntries(retained.map((result) => [resultKey(result), result])),
    resultsByName: resultsByName(retained),
    resultsList: retained,
    artifact: {
      ...report.artifact,
      reportResultsTotal: all.length,
      reportResultsEmitted: retained.length,
      reportResultsOmitted: all.length - retained.length,
      reportResultsTruncated: true,
    },
  };
}
