import { describe, expect, it } from 'vitest';
import { createRtcBaselineFinalizedReader } from '../../../baseline/evidence/rtc-baseline-finalized-reader.ts';
import { validateRtcBaselineRawArtifactMembership } from '../../../baseline/evidence/rtc-baseline-evidence-layout.ts';
const encoder = new TextEncoder();
const primaryId = '20260807-0123456789ab-e1-local';
const repeatId = '20260807-0123456789ab-e1-local-repeat-01';
const candidateId = '20260808-fedcba987654-e1-local';
const fileMap = (record: Record<string, string>) => new Map(Object.entries(record).reverse());
const primaryFiles = fileMap({
  'environment.json': `{"schema":"rallar.rtc-baseline.environment.v1","baselineId":"20260807-0123456789ab-e1-local","workloadIds":["RTC-B01"],"environmentId":"E1-local","repeatLink":null,"conditionalEnvironmentDecisions":[],"observation":{"git":{"headCommit":"0000000000000000000000000000000000000000","headTree":"1111111111111111111111111111111111111111","ref":"codex/rtc-baseline","clean":true},"runtime":{"node":"24","npm":"11","deno":"2","playwright":"1","chromium":"139"},"host":{"os":"darwin","kernel":"24.6.0","architecture":"arm64","logicalCpuCount":10,"cpuModel":"Apple M4","totalMemoryBytes":17179869184,"executionContext":"local"},"timing":{"startedAtUtc":"2026-08-07T10:00:00.000Z","endedAtUtc":"2026-08-07T10:00:01.000Z","monotonicDurationMs":1000,"monotonicSource":"performance.now"},"deviations":[],"sourceHashes":[],"configurationInputs":[],"resolvedConfiguration":[],"controllerInputs":[],"allowlistedEnvironment":{},"workerCommand":{"redactedArgv":{"executable":"deno","arguments":["run","scripts/perf/rtc.ts"]},"projection":{"fixedWorkerFlags":["--capture=worker"],"configurationFlags":[]}}}}`,
  'manifest.json': `{"schema":"rallar.rtc-baseline.manifest.v1","request":{"schema":"rallar.rtc-baseline.capture-request.v1","baselineId":"20260807-0123456789ab-e1-local","workloadIds":["RTC-B01"],"environmentId":"E1-local","retainedSampleMultiplier":1,"repeatLink":null,"conditionalEnvironmentDecisions":[]},"workloadIds":["RTC-B01"],"cases":[{"workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500"}],"outerAttempts":[{"workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","environmentId":"E1-local","intendedPhase":"retained","outerOrdinal":1,"sampleIds":["rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-001"]}],"expectedCohorts":[],"repeatLink":null}`,
  'results/samples/sample.json': `{"schema":"rallar.rtc-baseline.sample.v1","identity":{"sampleId":"rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-001","workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","intendedPhase":"retained","outerOrdinal":1,"innerOrdinal":1},"outcome":"passed","evidenceClass":"synthetic-path","metrics":[{"metric":"durationMs","unit":"ms","value":89},{"metric":"durationMs","unit":"ms","value":111},{"metric":"heapBytes","unit":"bytes","value":100}],"rawEvidence":{"durationMs":100},"rawReferences":[],"issues":[],"runtimeObservation":{"git":{"headCommit":"0000000000000000000000000000000000000000","headTree":"1111111111111111111111111111111111111111","ref":"codex/rtc-baseline","clean":true},"runtime":{"node":"24","npm":"11","deno":"2","playwright":"1","chromium":"139"},"host":{"os":"darwin","kernel":"24.6.0","architecture":"arm64","logicalCpuCount":10,"cpuModel":"Apple M4","totalMemoryBytes":17179869184,"executionContext":"local"},"timing":{"startedAtUtc":"2026-08-07T10:00:00.000Z","endedAtUtc":"2026-08-07T10:00:01.000Z","monotonicDurationMs":1000,"monotonicSource":"performance.now"},"deviations":[],"sourceHashes":[],"configurationInputs":[],"resolvedConfiguration":[],"controllerInputs":[],"allowlistedEnvironment":{},"workerCommand":{"redactedArgv":{"executable":"deno","arguments":["run","scripts/perf/rtc.ts"]},"projection":{"fixedWorkerFlags":["--capture=worker"],"configurationFlags":[]}}}}`,
  'summary.json': `{"schema":"rallar.rtc-baseline.summary.v1","baselineId":"20260807-0123456789ab-e1-local","workloadIds":["RTC-B01"],"environmentId":"E1-local","repeatLink":null,"conditionalEnvironmentDecisions":[],"sampleOutcomes":[{"identity":{"sampleId":"rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-001","workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","intendedPhase":"retained","outerOrdinal":1,"innerOrdinal":1},"outcome":"passed","issues":[]}],"cohortOutcomes":[],"metricSummaries":[{"workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","metric":"durationMs","unit":"ms","count":2,"minimum":89,"median":100,"maximum":111,"mad":11,"coefficientOfVariation":0.11},{"workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","metric":"heapBytes","unit":"bytes","count":1,"minimum":100,"median":100,"maximum":100,"mad":0,"coefficientOfVariation":0}],"rawReferences":[]}`,
  SHA256SUMS: `1111111111111111111111111111111111111111111111111111111111111111  environment.json\n2222222222222222222222222222222222222222222222222222222222222222  manifest.json\n3333333333333333333333333333333333333333333333333333333333333333  results/samples/sample.json\ndddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd  summary.json\n`,
});
const repeatFiles = fileMap({
  'environment.json': `{"schema":"rallar.rtc-baseline.environment.v1","baselineId":"20260807-0123456789ab-e1-local-repeat-01","workloadIds":["RTC-B01"],"environmentId":"E1-local","repeatLink":{"primaryBaselineId":"20260807-0123456789ab-e1-local","primarySummarySha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},"conditionalEnvironmentDecisions":[],"observation":{"git":{"headCommit":"0000000000000000000000000000000000000000","headTree":"1111111111111111111111111111111111111111","ref":"codex/rtc-baseline","clean":true},"runtime":{"node":"24","npm":"11","deno":"2","playwright":"1","chromium":"139"},"host":{"os":"darwin","kernel":"24.6.0","architecture":"arm64","logicalCpuCount":10,"cpuModel":"Apple M4","totalMemoryBytes":17179869184,"executionContext":"local"},"timing":{"startedAtUtc":"2026-08-07T11:00:00.000Z","endedAtUtc":"2026-08-07T11:00:01.000Z","monotonicDurationMs":1000,"monotonicSource":"performance.now"},"deviations":[],"sourceHashes":[],"configurationInputs":[],"resolvedConfiguration":[],"controllerInputs":[],"allowlistedEnvironment":{},"workerCommand":{"redactedArgv":{"executable":"deno","arguments":["run","scripts/perf/rtc.ts"]},"projection":{"fixedWorkerFlags":["--capture=worker"],"configurationFlags":[]}}}}`,
  'manifest.json': `{"schema":"rallar.rtc-baseline.manifest.v1","request":{"schema":"rallar.rtc-baseline.capture-request.v1","baselineId":"20260807-0123456789ab-e1-local-repeat-01","workloadIds":["RTC-B01"],"environmentId":"E1-local","retainedSampleMultiplier":2,"repeatLink":{"primaryBaselineId":"20260807-0123456789ab-e1-local","primarySummarySha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},"conditionalEnvironmentDecisions":[]},"workloadIds":["RTC-B01"],"cases":[{"workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500"}],"outerAttempts":[{"workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","environmentId":"E1-local","intendedPhase":"retained","outerOrdinal":1,"sampleIds":["rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-001"]}],"expectedCohorts":[],"repeatLink":{"primaryBaselineId":"20260807-0123456789ab-e1-local","primarySummarySha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}}`,
  'results/samples/sample.json': `{"schema":"rallar.rtc-baseline.sample.v1","identity":{"sampleId":"rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-001","workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","intendedPhase":"retained","outerOrdinal":1,"innerOrdinal":1},"outcome":"passed","evidenceClass":"synthetic-path","metrics":[{"metric":"durationMs","unit":"ms","value":8},{"metric":"heapBytes","unit":"bytes","value":100}],"rawEvidence":{"durationMs":8},"rawReferences":[],"issues":[],"runtimeObservation":{"git":{"headCommit":"0000000000000000000000000000000000000000","headTree":"1111111111111111111111111111111111111111","ref":"codex/rtc-baseline","clean":true},"runtime":{"node":"24","npm":"11","deno":"2","playwright":"1","chromium":"139"},"host":{"os":"darwin","kernel":"24.6.0","architecture":"arm64","logicalCpuCount":10,"cpuModel":"Apple M4","totalMemoryBytes":17179869184,"executionContext":"local"},"timing":{"startedAtUtc":"2026-08-07T11:00:00.000Z","endedAtUtc":"2026-08-07T11:00:01.000Z","monotonicDurationMs":1000,"monotonicSource":"performance.now"},"deviations":[],"sourceHashes":[],"configurationInputs":[],"resolvedConfiguration":[],"controllerInputs":[],"allowlistedEnvironment":{},"workerCommand":{"redactedArgv":{"executable":"deno","arguments":["run","scripts/perf/rtc.ts"]},"projection":{"fixedWorkerFlags":["--capture=worker"],"configurationFlags":[]}}}}`,
  'summary.json': `{"schema":"rallar.rtc-baseline.summary.v1","baselineId":"20260807-0123456789ab-e1-local-repeat-01","workloadIds":["RTC-B01"],"environmentId":"E1-local","repeatLink":{"primaryBaselineId":"20260807-0123456789ab-e1-local","primarySummarySha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},"conditionalEnvironmentDecisions":[],"sampleOutcomes":[{"identity":{"sampleId":"rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-001","workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","intendedPhase":"retained","outerOrdinal":1,"innerOrdinal":1},"outcome":"passed","issues":[]}],"cohortOutcomes":[],"metricSummaries":[{"workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","metric":"durationMs","unit":"ms","count":1,"minimum":8,"median":8,"maximum":8,"mad":0,"coefficientOfVariation":0},{"workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","metric":"heapBytes","unit":"bytes","count":1,"minimum":100,"median":100,"maximum":100,"mad":0,"coefficientOfVariation":0}],"rawReferences":[]}`,
  SHA256SUMS: `eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee  environment.json\neeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee  manifest.json\neeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee  results/samples/sample.json\neeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee  summary.json\n`,
});
const candidateFiles = fileMap({
  'environment.json': `{"schema":"rallar.rtc-baseline.environment.v1","baselineId":"20260808-fedcba987654-e1-local","workloadIds":["RTC-B01"],"environmentId":"E1-local","repeatLink":null,"conditionalEnvironmentDecisions":[],"observation":{"git":{"headCommit":"2222222222222222222222222222222222222222","headTree":"3333333333333333333333333333333333333333","ref":"codex/rtc-baseline","clean":true},"runtime":{"node":"24","npm":"11","deno":"2","playwright":"1","chromium":"139"},"host":{"os":"darwin","kernel":"24.6.0","architecture":"arm64","logicalCpuCount":10,"cpuModel":"Apple M4","totalMemoryBytes":17179869184,"executionContext":"local"},"timing":{"startedAtUtc":"2026-08-08T10:00:00.000Z","endedAtUtc":"2026-08-08T10:00:01.000Z","monotonicDurationMs":1000,"monotonicSource":"performance.now"},"deviations":[],"sourceHashes":[],"configurationInputs":[],"resolvedConfiguration":[],"controllerInputs":[],"allowlistedEnvironment":{},"workerCommand":{"redactedArgv":{"executable":"deno","arguments":["run","scripts/perf/rtc.ts"]},"projection":{"fixedWorkerFlags":["--capture=worker"],"configurationFlags":[]}}}}`,
  'manifest.json': `{"schema":"rallar.rtc-baseline.manifest.v1","request":{"schema":"rallar.rtc-baseline.capture-request.v1","baselineId":"20260808-fedcba987654-e1-local","workloadIds":["RTC-B01"],"environmentId":"E1-local","retainedSampleMultiplier":1,"repeatLink":null,"conditionalEnvironmentDecisions":[]},"workloadIds":["RTC-B01"],"cases":[{"workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500"}],"outerAttempts":[{"workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","environmentId":"E1-local","intendedPhase":"retained","outerOrdinal":1,"sampleIds":["rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-001"]}],"expectedCohorts":[],"repeatLink":null}`,
  'results/samples/sample.json': `{"schema":"rallar.rtc-baseline.sample.v1","identity":{"sampleId":"rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-001","workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","intendedPhase":"retained","outerOrdinal":1,"innerOrdinal":1},"outcome":"passed","evidenceClass":"synthetic-path","metrics":[{"metric":"durationMs","unit":"ms","value":10},{"metric":"heapBytes","unit":"bytes","value":125}],"rawEvidence":{"durationMs":10},"rawReferences":[],"issues":[],"runtimeObservation":{"git":{"headCommit":"2222222222222222222222222222222222222222","headTree":"3333333333333333333333333333333333333333","ref":"codex/rtc-baseline","clean":true},"runtime":{"node":"24","npm":"11","deno":"2","playwright":"1","chromium":"139"},"host":{"os":"darwin","kernel":"24.6.0","architecture":"arm64","logicalCpuCount":10,"cpuModel":"Apple M4","totalMemoryBytes":17179869184,"executionContext":"local"},"timing":{"startedAtUtc":"2026-08-08T10:00:00.000Z","endedAtUtc":"2026-08-08T10:00:01.000Z","monotonicDurationMs":1000,"monotonicSource":"performance.now"},"deviations":[],"sourceHashes":[],"configurationInputs":[],"resolvedConfiguration":[],"controllerInputs":[],"allowlistedEnvironment":{},"workerCommand":{"redactedArgv":{"executable":"deno","arguments":["run","scripts/perf/rtc.ts"]},"projection":{"fixedWorkerFlags":["--capture=worker"],"configurationFlags":[]}}}}`,
  'summary.json': `{"schema":"rallar.rtc-baseline.summary.v1","baselineId":"20260808-fedcba987654-e1-local","workloadIds":["RTC-B01"],"environmentId":"E1-local","repeatLink":null,"conditionalEnvironmentDecisions":[],"sampleOutcomes":[{"identity":{"sampleId":"rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-001","workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","intendedPhase":"retained","outerOrdinal":1,"innerOrdinal":1},"outcome":"passed","issues":[]}],"cohortOutcomes":[],"metricSummaries":[{"workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","metric":"durationMs","unit":"ms","count":1,"minimum":10,"median":10,"maximum":10,"mad":0,"coefficientOfVariation":0},{"workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","metric":"heapBytes","unit":"bytes","count":1,"minimum":125,"median":125,"maximum":125,"mad":0,"coefficientOfVariation":0}],"rawReferences":[]}`,
  SHA256SUMS: `eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee  environment.json\neeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee  manifest.json\neeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee  results/samples/sample.json\nffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff  summary.json\n`,
});
const badRepeatEnvironment = `{"schema":"rallar.rtc-baseline.environment.v1","baselineId":"20260807-0123456789ab-e1-local-repeat-01","workloadIds":["RTC-B01"],"environmentId":"E1-local","repeatLink":{"primaryBaselineId":"20260807-0123456789ab-e1-local","primarySummarySha256":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"},"conditionalEnvironmentDecisions":[],"observation":{"git":{"headCommit":"0000000000000000000000000000000000000000","headTree":"1111111111111111111111111111111111111111","ref":"codex/rtc-baseline","clean":true},"runtime":{"node":"24","npm":"11","deno":"2","playwright":"1","chromium":"139"},"host":{"os":"darwin","kernel":"24.6.0","architecture":"arm64","logicalCpuCount":10,"cpuModel":"Apple M4","totalMemoryBytes":17179869184,"executionContext":"local"},"timing":{"startedAtUtc":"2026-08-07T11:00:00.000Z","endedAtUtc":"2026-08-07T11:00:01.000Z","monotonicDurationMs":1000,"monotonicSource":"performance.now"},"deviations":[],"sourceHashes":[],"configurationInputs":[],"resolvedConfiguration":[],"controllerInputs":[],"allowlistedEnvironment":{},"workerCommand":{"redactedArgv":{"executable":"deno","arguments":["run","scripts/perf/rtc.ts"]},"projection":{"fixedWorkerFlags":["--capture=worker"],"configurationFlags":[]}}}}`;
const noisyRepeatSummary = `{"schema":"rallar.rtc-baseline.summary.v1","baselineId":"20260807-0123456789ab-e1-local-repeat-01","workloadIds":["RTC-B01"],"environmentId":"E1-local","repeatLink":{"primaryBaselineId":"20260807-0123456789ab-e1-local","primarySummarySha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},"conditionalEnvironmentDecisions":[],"sampleOutcomes":[{"identity":{"sampleId":"rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-001","workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","intendedPhase":"retained","outerOrdinal":1,"innerOrdinal":1},"outcome":"passed","issues":[]}],"cohortOutcomes":[],"metricSummaries":[{"workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","metric":"durationMs","unit":"ms","count":2,"minimum":89,"median":100,"maximum":111,"mad":11,"coefficientOfVariation":0.11},{"workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","metric":"heapBytes","unit":"bytes","count":1,"minimum":100,"median":100,"maximum":100,"mad":0,"coefficientOfVariation":0}],"rawReferences":[]}`;
const stablePrimarySummary = `{"schema":"rallar.rtc-baseline.summary.v1","baselineId":"20260807-0123456789ab-e1-local","workloadIds":["RTC-B01"],"environmentId":"E1-local","repeatLink":null,"conditionalEnvironmentDecisions":[],"sampleOutcomes":[{"identity":{"sampleId":"rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-001","workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","intendedPhase":"retained","outerOrdinal":1,"innerOrdinal":1},"outcome":"passed","issues":[]}],"cohortOutcomes":[],"metricSummaries":[{"workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","metric":"durationMs","unit":"ms","count":1,"minimum":9,"median":9,"maximum":9,"mad":0,"coefficientOfVariation":0}],"rawReferences":[]}`;
type ValidationIssue = Readonly<Record<'path' | 'code' | 'message', string>>;
function issueText(result: { readonly ok: boolean; readonly issues?: readonly ValidationIssue[] }) {
  const issues = result.ok ? [] : (result.issues ?? []);
  return issues.map(({ path, code, message }) => `${path}\t${code}\t${message}`).join('\n') || null;
}
const issuesFrom = async (result: Promise<Parameters<typeof issueText>[0]>) =>
  issueText(await result);
function readerFor(
  filesByBaseline: ReadonlyMap<string, ReadonlyMap<string, string>>,
  hashedTexts: string[] = [],
  readPaths: string[] = [],
) {
  return createRtcBaselineFinalizedReader({
    readJson: async () => ({ ok: true, value: { unexpected: 'semantic-port' } }),
    readBytes: async (baselineId, path) => {
      readPaths.push(`${baselineId}:${path}`);
      return { ok: true, value: encoder.encode(filesByBaseline.get(baselineId)!.get(path)!) };
    },
    listArtifactPaths: async (baselineId) => ({
      ok: true,
      value: [...filesByBaseline.get(baselineId)!.keys()].filter((path) => path !== 'SHA256SUMS'),
    }),
    sha256: async (bytes) => {
      const text = new TextDecoder().decode(bytes);
      hashedTexts.push(text);
      if (text === primaryFiles.get('environment.json'))
        return '1111111111111111111111111111111111111111111111111111111111111111';
      if (text === primaryFiles.get('manifest.json'))
        return '2222222222222222222222222222222222222222222222222222222222222222';
      if (text === primaryFiles.get('results/samples/sample.json'))
        return '3333333333333333333333333333333333333333333333333333333333333333';
      if (text === primaryFiles.get('summary.json'))
        return 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
      if (text === candidateFiles.get('summary.json'))
        return 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
      return 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    },
  });
}
describe('RTC baseline finalized reader', () => {
  it('validates exhaustive raw artifact membership', () => {
    const membershipIssues = validateRtcBaselineRawArtifactMembership({
      retainedArtifactPaths: ['artifacts/kept.bin', 'artifacts/unreferenced.bin'],
      rawReferencePaths: ['artifacts/kept.bin', 'artifacts/missing.bin'],
    });
    expect(issueText({ ok: false, issues: membershipIssues }))
      .toBe(`$.summary.rawReferences[1].relativePath\tmissing-raw-artifact\tRaw reference artifacts/missing.bin is not retained.
$.retainedArtifactPaths\tunreferenced-raw-artifact\tRetained raw artifact artifacts/unreferenced.bin is not referenced.`);
  });
  it('lists external attempts from a complete manifest in execution order', async () => {
    const baselineId = '20260807-0123456789ab-e2-browser';
    const manifest = JSON.parse(
      `{"schema":"rallar.rtc-baseline.manifest.v1","request":{"schema":"rallar.rtc-baseline.capture-request.v1","baselineId":"20260807-0123456789ab-e2-browser","workloadIds":["RTC-B05"],"environmentId":"E2-browser","retainedSampleMultiplier":1,"repeatLink":null,"conditionalEnvironmentDecisions":[]},"workloadIds":["RTC-B05"],"cases":[{"workloadId":"RTC-B05","caseId":"browser-data-channel-lifecycle","inputKey":"iterations-25"}],"outerAttempts":[{"workloadId":"RTC-B05","caseId":"browser-data-channel-lifecycle","inputKey":"iterations-25","environmentId":"E2-browser","intendedPhase":"warmup","outerOrdinal":1,"sampleIds":["warmup-sample"]},{"workloadId":"RTC-B05","caseId":"browser-data-channel-lifecycle","inputKey":"iterations-25","environmentId":"E2-browser","intendedPhase":"retained","outerOrdinal":1,"sampleIds":["retained-sample"]}],"expectedCohorts":[],"repeatLink":null}`,
    );
    const reader = createRtcBaselineFinalizedReader({
      readJson: async () => ({ ok: true, value: manifest }),
      readBytes: async () => ({ ok: true, value: new Uint8Array() }),
      listArtifactPaths: async () => ({ ok: true, value: [] }),
      sha256: async () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    const result = await reader.readExternalAttempts({ baselineId, workloadId: 'RTC-B05' });
    expect(result.ok ? result.value : null).toEqual(
      JSON.parse(
        '[{"workloadId":"RTC-B05","caseId":"browser-data-channel-lifecycle","inputKey":"iterations-25","intendedPhase":"warmup","outerOrdinal":1,"environmentId":"E2-browser","rawResultRelativePath":"artifacts/staging/rtc-b05-browser-data-channel-lifecycle-iterations-25-warmup-001.json"},{"workloadId":"RTC-B05","caseId":"browser-data-channel-lifecycle","inputKey":"iterations-25","intendedPhase":"retained","outerOrdinal":1,"environmentId":"E2-browser","rawResultRelativePath":"artifacts/staging/rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-001.json"}]',
      ),
    );
  });
  it('rejects malformed, duplicate, traversing, missing, extra, and tampered checksums', async () => {
    const checksumBytes = encoder.encode(`malformed
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  summary.json
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  summary.json
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  ../escape
cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc  extra.json
dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd  results/failures/null.json
`);
    const reader = createRtcBaselineFinalizedReader({
      readJson: async () => ({ ok: true, value: {} }),
      readBytes: async (_baselineId, path) => ({
        ok: true,
        value:
          path === 'SHA256SUMS'
            ? checksumBytes
            : encoder.encode(path === 'results/failures/null.json' ? 'null' : '{}'),
      }),
      listArtifactPaths: async () => ({
        ok: true,
        value: ['environment.json', 'manifest.json', 'results/failures/null.json', 'summary.json'],
      }),
      sha256: async () => 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    });
    expect(await issuesFrom(reader.readBaselineValidation({ baselineId: primaryId })))
      .toBe(`$.SHA256SUMS[0]\tmalformed-checksum-entry\tExpected lowercase SHA-256, two spaces, and a relative path.
$.SHA256SUMS[2]\tduplicate-checksum-entry\tChecksum path summary.json appears more than once.
$.SHA256SUMS[3]\tunconfined-checksum-path\tChecksum paths must be relative and non-traversing.
$.SHA256SUMS\tmissing-checksum-entry\tMissing checksum for environment.json.
$.SHA256SUMS\tmissing-checksum-entry\tMissing checksum for manifest.json.
$.SHA256SUMS\textra-checksum-entry\tChecksum references unretained path extra.json.
$\texpected-object\tExpected a failure outcome object.
$.summary.json\tchecksum-mismatch\tStored bytes do not match the SHA-256 checksum.`);
  });
  it('accepts literal full decoder-safe artifacts with exact checksum membership', async () => {
    const reader = readerFor(new Map([[primaryId, primaryFiles]]));
    const result = await reader.readBaselineValidation({ baselineId: primaryId });
    expect(result).toEqual({
      ok: true,
      value: {
        baselineId: '20260807-0123456789ab-e1-local',
        retainedArtifactPaths: [
          'environment.json',
          'manifest.json',
          'results/samples/sample.json',
          'summary.json',
        ],
        checksumEntryCount: 4,
      },
    });
    const verified = await reader.readVerifiedRepeatPrimary({ baselineId: primaryId });
    expect(
      verified.ok
        ? [
            verified.value.environment.schema,
            verified.value.manifest.schema,
            verified.value.summarySha256,
            verified.value.triggeredWorkloadIds,
          ]
        : verified,
    ).toEqual([
      'rallar.rtc-baseline.environment.v1',
      'rallar.rtc-baseline.manifest.v1',
      'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      ['RTC-B01'],
    ]);
    const driftFiles = new Map(primaryFiles);
    driftFiles.set(
      'results/samples/sample.json',
      primaryFiles
        .get('results/samples/sample.json')!
        .replace('"logicalCpuCount":10', '"logicalCpuCount":12'),
    );
    driftFiles.set(
      'SHA256SUMS',
      primaryFiles
        .get('SHA256SUMS')!
        .replace(
          `${'3'.repeat(64)}  results/samples/sample.json`,
          `${'e'.repeat(64)}  results/samples/sample.json`,
        ),
    );
    const driftReader = readerFor(new Map([[primaryId, driftFiles]]));
    expect(await issuesFrom(driftReader.readBaselineValidation({ baselineId: primaryId }))).toBe(
      '$.samples[0].runtimeObservation.host\treconciliation-mismatch\tRuntime observation field host changed.',
    );
  });
  it('verifies literal repeat byte/hash/link equality and rejects link drift and noise', async () => {
    const files = new Map([
      [primaryId, primaryFiles],
      [repeatId, repeatFiles],
    ]);
    expect(await readerFor(files).readRepeatRequirement({ baselineId: repeatId })).toEqual({
      ok: true,
      value: { workloadIds: [] },
    });
    const checksumDrift = new Map(repeatFiles);
    checksumDrift.set(
      'SHA256SUMS',
      repeatFiles
        .get('SHA256SUMS')!
        .replace(
          `${'e'.repeat(64)}  results/samples/sample.json`,
          `${'a'.repeat(64)}  results/samples/sample.json`,
        ),
    );
    expect(
      await issuesFrom(
        readerFor(
          new Map([
            [primaryId, primaryFiles],
            [repeatId, checksumDrift],
          ]),
        ).readRepeatRequirement({ baselineId: repeatId }),
      ),
    ).toBe(
      `$.results/samples/sample.json\tchecksum-mismatch\tStored bytes do not match the SHA-256 checksum.
$.summary.metricSummaries\tmetric-summary-mismatch\tMetric summaries must exactly match checksum-verified retained samples.
$.summary.sampleOutcomes\tsample-outcome-mismatch\tSummary sample outcomes differ from retained artifacts.`,
    );
    const missingLink = new Map(repeatFiles);
    const linkText = `{"primaryBaselineId":"${primaryId}","primarySummarySha256":"${'d'.repeat(64)}"}`;
    for (const path of ['environment.json', 'manifest.json', 'summary.json']) {
      missingLink.set(path, repeatFiles.get(path)!.replaceAll(linkText, 'null'));
    }
    expect(
      await issuesFrom(
        readerFor(new Map([[repeatId, missingLink]])).readBaselineValidation({
          baselineId: repeatId,
        }),
      ),
    ).toBe(
      '$.repeatLink\tmissing-repeat-link\tA -repeat-01 baseline requires its primary repeat link.',
    );
    const badLinkFiles = new Map(repeatFiles);
    badLinkFiles.set('environment.json', badRepeatEnvironment);
    expect(
      await issuesFrom(
        readerFor(
          new Map([
            [primaryId, primaryFiles],
            [repeatId, badLinkFiles],
          ]),
        ).readRepeatRequirement({ baselineId: repeatId }),
      ),
    ).toBe(
      '$.environment.repeatLink\tartifact-repeat-link-mismatch\tEnvironment repeat link differs.',
    );
    const corruptPrimary = new Map(primaryFiles);
    corruptPrimary.set(
      'SHA256SUMS',
      primaryFiles
        .get('SHA256SUMS')!
        .replace(`${'d'.repeat(64)}  summary.json`, `${'e'.repeat(64)}  summary.json`),
    );
    const corruptFiles = new Map([
      [primaryId, corruptPrimary],
      [repeatId, repeatFiles],
    ]);
    expect(
      await issuesFrom(readerFor(corruptFiles).readBaselineValidation({ baselineId: repeatId })),
    ).toBe(
      '$.repeatLink.primarySummarySha256\trepeat-primary-checksum-mismatch\tRepeat link does not match primary SHA256SUMS.',
    );
    const noisyFiles = new Map(repeatFiles);
    noisyFiles.set('results/samples/sample.json', primaryFiles.get('results/samples/sample.json')!);
    noisyFiles.set('summary.json', noisyRepeatSummary);
    noisyFiles.set(
      'SHA256SUMS',
      repeatFiles
        .get('SHA256SUMS')!
        .replace(
          `${'e'.repeat(64)}  results/samples/sample.json`,
          `${'3'.repeat(64)}  results/samples/sample.json`,
        ),
    );
    expect(
      await issuesFrom(
        readerFor(
          new Map([
            [primaryId, primaryFiles],
            [repeatId, noisyFiles],
          ]),
        ).readRepeatRequirement({ baselineId: repeatId }),
      ),
    ).toBe(
      '$.metricSummaries\trepeat-still-noisy\tControlled repeat remains above its coefficient-of-variation threshold.',
    );
  });
  it('reads a successful distinct-anchor paired comparison with literal facts', async () => {
    const hashedTexts: string[] = [];
    const readPaths: string[] = [];
    const reader = readerFor(
      new Map([
        [primaryId, primaryFiles],
        [repeatId, repeatFiles],
        [candidateId, candidateFiles],
      ]),
      hashedTexts,
      readPaths,
    );
    const pairedInput = {
      primaryBaselineId: primaryId,
      primaryComparisonCohortId: repeatId,
      candidateBaselineId: candidateId,
      candidateComparisonCohortId: candidateId,
      workloadId: 'RTC-B01' as const,
    };
    const paired = await reader.readPairedComparison(pairedInput);
    expect(
      paired.ok ? [paired.value.outcome, paired.value.primary, paired.value.candidate] : paired,
    ).toEqual([
      'conclusive',
      {
        primaryBaselineId: primaryId,
        comparisonBaselineId: repeatId,
        repeatRequired: true,
      },
      {
        primaryBaselineId: candidateId,
        comparisonBaselineId: candidateId,
        repeatRequired: false,
      },
    ]);
    expect(
      paired.ok
        ? paired.value.comparisons.map((entry) => [
            entry.baseline.median,
            entry.candidate.median,
            entry.absoluteMedianChange,
            entry.relativeMedianChange,
          ])
        : paired,
    ).toEqual([
      [8, 10, 2, { kind: 'defined', value: 0.25 }],
      [100, 125, 25, { kind: 'defined', value: 0.25 }],
    ]);
    expect(hashedTexts).toContain(candidateFiles.get('summary.json'));
    expect(readPaths).toContain(`${primaryId}:SHA256SUMS`);
    expect(
      await issuesFrom(
        reader.readPairedComparison({
          ...pairedInput,
          primaryComparisonCohortId: candidateId,
        }),
      ),
    ).toBe(
      '$.primaryComparisonCohortId\tinvalid-comparison-baseline\tA noisy primary requires its exact -repeat-01 baseline.',
    );
    const incompleteRepeat = new Map(repeatFiles)
      .set(
        'results/samples/sample.json',
        repeatFiles
          .get('results/samples/sample.json')!
          .replace('{"metric":"durationMs","unit":"ms","value":8},', ''),
      )
      .set(
        'summary.json',
        repeatFiles
          .get('summary.json')!
          .replace(
            '{"workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","metric":"durationMs","unit":"ms","count":1,"minimum":8,"median":8,"maximum":8,"mad":0,"coefficientOfVariation":0},',
            '',
          ),
      );
    const incompleteReader = readerFor(
      new Map([
        [primaryId, primaryFiles],
        [repeatId, incompleteRepeat],
      ]),
    );
    expect(
      await issuesFrom(
        incompleteReader.readPairedComparison({
          ...pairedInput,
          candidateBaselineId: primaryId,
          candidateComparisonCohortId: repeatId,
        }),
      ),
    ).toBe(
      '$.repeatMetrics\tmissing-repeat-metric\tControlled repeat is missing peer-connection-diagnostics-burst/pairs-500/durationMs/ms.',
    );
  });
  it('does not cache finalized summary bytes or decoded values between reads', async () => {
    const liveFiles = new Map(primaryFiles);
    const readPaths: string[] = [];
    const reader = readerFor(new Map([[primaryId, liveFiles]]), [], readPaths);
    const first = await reader.readRepeatRequirement({ baselineId: primaryId });
    expect(first.ok ? first.value.workloadIds : null).toEqual(['RTC-B01']);
    liveFiles.set('summary.json', stablePrimarySummary);
    liveFiles.set(
      'SHA256SUMS',
      primaryFiles
        .get('SHA256SUMS')!
        .replace(`${'d'.repeat(64)}  summary.json`, `${'e'.repeat(64)}  summary.json`),
    );
    expect(await issuesFrom(reader.readRepeatRequirement({ baselineId: primaryId }))).toContain(
      'metric-summary-mismatch',
    );
    expect(readPaths.filter((path) => path === `${primaryId}:summary.json`)).toHaveLength(2);
  });
});
