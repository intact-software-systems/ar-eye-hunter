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
