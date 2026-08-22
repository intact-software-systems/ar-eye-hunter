import { describe, expect, it } from 'vitest';
import * as decoding from '../../../baseline/contracts/rtc-baseline-artifact-decoding.ts';
import * as validation from '../../../baseline/contracts/rtc-baseline-artifact-validation.ts';
import type { RtcBaselineExternalAttemptDto, RtcBaselineExternalCohortDto, RtcBaselineJson } from '../../../baseline/contracts/rtc-baseline-contracts.ts';
type Issue = Readonly<Record<'path' | 'code' | 'message', string>>;
type DecodeResult = { readonly ok: boolean; readonly issues?: readonly Issue[]; };
const condition = { environmentId: 'E4-pg', decision: 'required', reason: 'Postgres is selected.' };
const recordedIssue = { path: '$.worker', code: 'failed', message: 'worker failed' };
const { repeatLink, identity, cohortIdentity, producerFacts, metricSummary } = JSON.parse(
    `{"repeatLink":{"primaryBaselineId":"20260807-0123456789ab-e3-memory","primarySummarySha256":"${
        'c'.repeat(64)
    }"},"identity":{"sampleId":"rtc-b06-retention-100-e3-memory-retained-001-001","workloadId":"RTC-B06","caseId":"retention-100","inputKey":"e3-memory-retention-100","intendedPhase":"retained","outerOrdinal":1,"innerOrdinal":1},"cohortIdentity":{"cohortId":"rtc-b06-e3-retention","workloadId":"RTC-B06","memberSampleIds":["rtc-b06-retention-100-e3-memory-retained-001-001"]},"producerFacts":{"databaseUrl":"absent","allScenariosPresent":false,"allScenariosRaw":null,"retentionSoakPresent":true,"retentionSoakRaw":"1","retentionCyclesPresent":true,"retentionCyclesRaw":"100","iceModePresent":false,"iceModeRaw":null},"metricSummary":{"workloadId":"RTC-B06","caseId":"retention-100","inputKey":"e3-memory-retention-100","metric":"heapBytes","unit":"bytes","count":1,"minimum":1024,"median":1024,"maximum":1024,"mad":0,"coefficientOfVariation":0}}`
);
const observation = JSON.parse(
    `{"git":{"headCommit":"0000000000000000000000000000000000000000","headTree":"1111111111111111111111111111111111111111","ref":"codex/rtc","clean":true},"runtime":{"node":"24","npm":"11","deno":"2","playwright":"1","chromium":"139"},"host":{"os":"darwin","kernel":"24.6.0","architecture":"arm64","logicalCpuCount":10,"cpuModel":"Apple M4","totalMemoryBytes":17179869184,"executionContext":"local"},"timing":{"startedAtUtc":"2026-08-07T10:00:00.000Z","endedAtUtc":"2026-08-07T10:00:01.000Z","monotonicDurationMs":1000,"monotonicSource":"performance.now"},"deviations":["no deviation"],"sourceHashes":[{"path":"scripts/perf/rtc.ts","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","kind":"source"}],"configurationInputs":[{"name":"DATABASE_URL","value":"absent","secret":true}],"resolvedConfiguration":[{"caseKey":{"workloadId":"RTC-B06","caseId":"retention-100","inputKey":"e3-memory-retention-100"},"field":"retentionCycles","value":100,"source":"environment"}],"controllerInputs":[{"name":"producerExitStatus","value":0,"secret":false}],"workerCommand":{"redactedArgv":{"executable":"deno","arguments":["run","scripts/perf/rtc.ts"]},"projection":{"fixedWorkerFlags":["--capture=worker"],"configurationFlags":["--cycles=100"]}},"allowlistedEnvironment":{"DATABASE_URL":"absent"}}`
);
const environment = JSON.parse(
    `{"schema":"rallar.rtc-baseline.environment.v1","baselineId":"20260807-0123456789ab-e3-memory-repeat-01","workloadIds":["RTC-B06"],"environmentId":"E3-memory","repeatLink":${
        JSON.stringify(repeatLink)
    },"conditionalEnvironmentDecisions":[${JSON.stringify(condition)}],"observation":${JSON.stringify(observation)}}`
);
const manifest = JSON.parse(
    `{"schema":"rallar.rtc-baseline.manifest.v1","request":{"schema":"rallar.rtc-baseline.capture-request.v1","baselineId":"20260807-0123456789ab-e3-memory-repeat-01","workloadIds":["RTC-B06"],"environmentId":"E3-memory","retainedSampleMultiplier":2,"repeatLink":${
        JSON.stringify(repeatLink)
    },"conditionalEnvironmentDecisions":[${
        JSON.stringify(condition)
    }]},"workloadIds":["RTC-B06"],"cases":[{"workloadId":"RTC-B06","caseId":"retention-100","inputKey":"e3-memory-retention-100"}],"outerAttempts":[{"workloadId":"RTC-B06","caseId":"retention-100","inputKey":"e3-memory-retention-100","environmentId":"E3-memory","intendedPhase":"retained","outerOrdinal":1,"sampleIds":["rtc-b06-retention-100-e3-memory-retained-001-001"]}],"expectedCohorts":[${
        JSON.stringify(cohortIdentity)
    }],"repeatLink":${JSON.stringify(repeatLink)}}`
);
const sample = JSON.parse(
    `{"schema":"rallar.rtc-baseline.sample.v1","identity":${
        JSON.stringify(identity)
    },"outcome":"failed","evidenceClass":"local-full-stack","metrics":[{"metric":"heapBytes","unit":"bytes","value":1024}],"rawEvidence":{"settledPeers":1},"rawReferences":[{"relativePath":"artifacts/raw.json","sha256":"${
        'b'.repeat(64)
    }","bytes":12}],"issues":[${JSON.stringify(recordedIssue)}],"runtimeObservation":${JSON.stringify(observation)}}`
);
const attempt = JSON.parse(
    `{"schema":"rallar.rtc-baseline.external-attempt.v1","locator":{"workloadId":"RTC-B06","caseId":"retention-100","inputKey":"e3-memory-retention-100","intendedPhase":"retained","outerOrdinal":1,"environmentId":"E3-memory","rawResultRelativePath":"artifacts/staging/attempt.json"},"producerExitStatus":1,"producerFacts":${
        JSON.stringify(producerFacts)
    },"sampleOutcomes":[{"identity":${JSON.stringify(identity)},"outcome":"failed","issues":[${JSON.stringify(recordedIssue)}]}],"samples":[${
        JSON.stringify(sample)
    }],"issues":[${JSON.stringify(recordedIssue)}]}`
);
const cohort = JSON.parse(
    `{"schema":"rallar.rtc-baseline.external-cohort.v1","identity":${
        JSON.stringify(cohortIdentity)
    },"outcome":"failed","rawEvidence":{"breachCount":1},"issues":[${JSON.stringify(recordedIssue)}],"samples":[${JSON.stringify(sample)}]}`
);
const failure = JSON.parse(
    `{"schema":"rallar.rtc-baseline.finalization-failure.v1","baselineId":"20260807-0123456789ab-e3-memory-repeat-01","failureId":"finalization-001","issues":[${
        JSON.stringify(recordedIssue)
    }],"rawEvidence":{"disk":"full"}}`
);
const summary = JSON.parse(
    `{"schema":"rallar.rtc-baseline.summary.v1","baselineId":"20260807-0123456789ab-e3-memory-repeat-01","workloadIds":["RTC-B06"],"environmentId":"E3-memory","repeatLink":${
        JSON.stringify(repeatLink)
    },"conditionalEnvironmentDecisions":[${JSON.stringify(condition)}],"sampleOutcomes":[{"identity":${JSON.stringify(identity)},"outcome":"failed","issues":[${
        JSON.stringify(recordedIssue)
    }]}],"cohortOutcomes":[{"identity":${JSON.stringify(cohortIdentity)},"outcome":"failed","issues":[${JSON.stringify(recordedIssue)}]}],"metricSummaries":[${
        JSON.stringify(metricSummary)
    }],"rawReferences":[{"relativePath":"artifacts/raw.json","sha256":"${'b'.repeat(64)}","bytes":12}]}`
);
const runtime = observation;
const artifacts = { environment, manifest, sample, attempt, cohort, failure, summary, runtime };
type ArtifactName = keyof typeof artifacts;
const decoders: Record<ArtifactName, (value: Record<string, unknown>) => DecodeResult> = {
    environment: (value) => decoding.decodeRtcBaselineEnvironment(value as RtcBaselineJson),
    manifest: (value) => decoding.decodeRtcBaselineManifest(value as RtcBaselineJson),
    sample: (value) => decoding.decodeRtcBaselineSample(value as RtcBaselineJson),
    attempt: (value) => decoding.decodeRtcBaselineExternalAttempt(value as RtcBaselineJson),
    cohort: (value) => decoding.decodeRtcBaselineExternalCohort(value as RtcBaselineJson),
    failure: (value) => decoding.decodeRtcBaselineFinalizationFailure(value as RtcBaselineJson),
    summary: (value) => decoding.decodeRtcBaselineSummary(value as RtcBaselineJson),
    runtime: (value) => decoding.decodeRtcBaselineRuntimeObservation(value as RtcBaselineJson)
};
function paths(text: string) {
    return text.trim().split(/\s+/);
}
function artifactPathPairs(text: string) {
    const tokens = paths(text);
    const pairs: [ArtifactName, string][] = [];
    while (tokens.length > 0) {
        pairs.push([tokens.shift() as ArtifactName, tokens.shift()!]);
    }
    return pairs;
}
const mandatoryPaths: Record<ArtifactName, readonly string[]> = {
    environment: paths(`
    $.schema $.baselineId $.workloadIds $.environmentId $.repeatLink $.repeatLink.primaryBaselineId $.repeatLink.primarySummarySha256 $.conditionalEnvironmentDecisions $.conditionalEnvironmentDecisions[0].environmentId $.conditionalEnvironmentDecisions[0].decision $.conditionalEnvironmentDecisions[0].reason $.observation
  `),
    manifest: paths(`
    $.schema $.request $.request.schema $.request.baselineId $.request.workloadIds $.request.environmentId $.request.retainedSampleMultiplier $.request.repeatLink $.request.repeatLink.primaryBaselineId $.request.repeatLink.primarySummarySha256 $.request.conditionalEnvironmentDecisions $.request.conditionalEnvironmentDecisions[0].environmentId $.request.conditionalEnvironmentDecisions[0].decision $.request.conditionalEnvironmentDecisions[0].reason $.workloadIds $.cases $.cases[0].workloadId $.cases[0].caseId $.cases[0].inputKey $.outerAttempts $.outerAttempts[0].workloadId $.outerAttempts[0].caseId $.outerAttempts[0].inputKey $.outerAttempts[0].environmentId $.outerAttempts[0].intendedPhase $.outerAttempts[0].outerOrdinal $.outerAttempts[0].sampleIds $.expectedCohorts $.expectedCohorts[0].cohortId $.expectedCohorts[0].workloadId $.expectedCohorts[0].memberSampleIds $.repeatLink $.repeatLink.primaryBaselineId $.repeatLink.primarySummarySha256
  `),
    sample: paths(`
    $.schema $.identity $.identity.sampleId $.identity.workloadId $.identity.caseId $.identity.inputKey $.identity.intendedPhase $.identity.outerOrdinal $.identity.innerOrdinal $.outcome $.evidenceClass $.metrics $.metrics[0].metric $.metrics[0].unit $.metrics[0].value $.rawEvidence $.rawReferences $.rawReferences[0].relativePath $.rawReferences[0].sha256 $.rawReferences[0].bytes $.issues $.issues[0].path $.issues[0].code $.issues[0].message $.runtimeObservation
  `),
    attempt: paths(`
    $.schema $.locator $.locator.workloadId $.locator.caseId $.locator.inputKey $.locator.intendedPhase $.locator.outerOrdinal $.locator.environmentId $.locator.rawResultRelativePath $.producerExitStatus $.producerFacts $.producerFacts.databaseUrl $.producerFacts.allScenariosPresent $.producerFacts.allScenariosRaw $.producerFacts.retentionSoakPresent $.producerFacts.retentionSoakRaw $.producerFacts.retentionCyclesPresent $.producerFacts.retentionCyclesRaw $.producerFacts.iceModePresent $.producerFacts.iceModeRaw $.sampleOutcomes $.sampleOutcomes[0].identity $.sampleOutcomes[0].identity.sampleId $.sampleOutcomes[0].identity.workloadId $.sampleOutcomes[0].identity.caseId $.sampleOutcomes[0].identity.inputKey $.sampleOutcomes[0].identity.intendedPhase $.sampleOutcomes[0].identity.outerOrdinal $.sampleOutcomes[0].identity.innerOrdinal $.sampleOutcomes[0].outcome $.sampleOutcomes[0].issues $.sampleOutcomes[0].issues[0].path $.sampleOutcomes[0].issues[0].code $.sampleOutcomes[0].issues[0].message $.samples $.samples[0].schema $.samples[0].identity $.samples[0].identity.sampleId $.samples[0].identity.workloadId $.samples[0].identity.caseId $.samples[0].identity.inputKey $.samples[0].identity.intendedPhase $.samples[0].identity.outerOrdinal $.samples[0].identity.innerOrdinal $.samples[0].outcome $.samples[0].evidenceClass $.samples[0].metrics $.samples[0].metrics[0].metric $.samples[0].metrics[0].unit $.samples[0].metrics[0].value $.samples[0].rawEvidence $.samples[0].rawReferences $.samples[0].rawReferences[0].relativePath $.samples[0].rawReferences[0].sha256 $.samples[0].rawReferences[0].bytes $.samples[0].issues $.samples[0].issues[0].path $.samples[0].issues[0].code $.samples[0].issues[0].message $.samples[0].runtimeObservation $.issues $.issues[0].path $.issues[0].code $.issues[0].message
  `),
    cohort: paths(`
    $.schema $.identity $.identity.cohortId $.identity.workloadId $.identity.memberSampleIds $.outcome $.rawEvidence $.issues $.issues[0].path $.issues[0].code $.issues[0].message $.samples $.samples[0].schema $.samples[0].identity $.samples[0].identity.sampleId $.samples[0].identity.workloadId $.samples[0].identity.caseId $.samples[0].identity.inputKey $.samples[0].identity.intendedPhase $.samples[0].identity.outerOrdinal $.samples[0].identity.innerOrdinal $.samples[0].outcome $.samples[0].evidenceClass $.samples[0].metrics $.samples[0].metrics[0].metric $.samples[0].metrics[0].unit $.samples[0].metrics[0].value $.samples[0].rawEvidence $.samples[0].rawReferences $.samples[0].rawReferences[0].relativePath $.samples[0].rawReferences[0].sha256 $.samples[0].rawReferences[0].bytes $.samples[0].issues $.samples[0].issues[0].path $.samples[0].issues[0].code $.samples[0].issues[0].message $.samples[0].runtimeObservation
  `),
    failure: paths(`
    $.schema $.baselineId $.failureId $.issues $.issues[0].path $.issues[0].code $.issues[0].message $.rawEvidence
  `),
    summary: paths(`
    $.schema $.baselineId $.workloadIds $.environmentId $.repeatLink $.repeatLink.primaryBaselineId $.repeatLink.primarySummarySha256 $.conditionalEnvironmentDecisions $.conditionalEnvironmentDecisions[0].environmentId $.conditionalEnvironmentDecisions[0].decision $.conditionalEnvironmentDecisions[0].reason $.sampleOutcomes $.sampleOutcomes[0].identity $.sampleOutcomes[0].identity.sampleId $.sampleOutcomes[0].identity.workloadId $.sampleOutcomes[0].identity.caseId $.sampleOutcomes[0].identity.inputKey $.sampleOutcomes[0].identity.intendedPhase $.sampleOutcomes[0].identity.outerOrdinal $.sampleOutcomes[0].identity.innerOrdinal $.sampleOutcomes[0].outcome $.sampleOutcomes[0].issues $.sampleOutcomes[0].issues[0].path $.sampleOutcomes[0].issues[0].code $.sampleOutcomes[0].issues[0].message $.cohortOutcomes $.cohortOutcomes[0].identity $.cohortOutcomes[0].identity.cohortId $.cohortOutcomes[0].identity.workloadId $.cohortOutcomes[0].identity.memberSampleIds $.cohortOutcomes[0].outcome $.cohortOutcomes[0].issues $.cohortOutcomes[0].issues[0].path $.cohortOutcomes[0].issues[0].code $.cohortOutcomes[0].issues[0].message $.metricSummaries $.metricSummaries[0].workloadId $.metricSummaries[0].caseId $.metricSummaries[0].inputKey $.metricSummaries[0].metric $.metricSummaries[0].unit $.metricSummaries[0].count $.metricSummaries[0].minimum $.metricSummaries[0].median $.metricSummaries[0].maximum $.metricSummaries[0].mad $.metricSummaries[0].coefficientOfVariation $.rawReferences $.rawReferences[0].relativePath $.rawReferences[0].sha256 $.rawReferences[0].bytes
  `),
    runtime: paths(`
    $.git $.git.headCommit $.git.headTree $.git.ref $.git.clean $.runtime $.runtime.node $.runtime.npm $.runtime.deno $.runtime.playwright $.runtime.chromium $.host $.host.os $.host.kernel $.host.architecture $.host.logicalCpuCount $.host.cpuModel $.host.totalMemoryBytes $.host.executionContext $.timing $.timing.startedAtUtc $.timing.endedAtUtc $.timing.monotonicDurationMs $.timing.monotonicSource $.deviations $.sourceHashes $.sourceHashes[0].path $.sourceHashes[0].sha256 $.sourceHashes[0].kind $.configurationInputs $.configurationInputs[0].name $.configurationInputs[0].value $.configurationInputs[0].secret $.resolvedConfiguration $.resolvedConfiguration[0].caseKey $.resolvedConfiguration[0].caseKey.workloadId $.resolvedConfiguration[0].caseKey.caseId $.resolvedConfiguration[0].caseKey.inputKey $.resolvedConfiguration[0].field $.resolvedConfiguration[0].value $.resolvedConfiguration[0].source $.controllerInputs $.controllerInputs[0].name $.controllerInputs[0].value $.controllerInputs[0].secret $.workerCommand $.workerCommand.redactedArgv $.workerCommand.redactedArgv.executable $.workerCommand.redactedArgv.arguments $.workerCommand.projection $.workerCommand.projection.fixedWorkerFlags $.workerCommand.projection.configurationFlags $.allowlistedEnvironment
  `)
};
const denseArrays = artifactPathPairs(`
  environment $.workloadIds environment $.conditionalEnvironmentDecisions manifest $.request.workloadIds manifest $.request.conditionalEnvironmentDecisions manifest $.workloadIds manifest $.cases manifest $.outerAttempts manifest $.outerAttempts[0].sampleIds manifest $.expectedCohorts manifest $.expectedCohorts[0].memberSampleIds sample $.metrics sample $.rawReferences sample $.issues attempt $.sampleOutcomes attempt $.sampleOutcomes[0].issues attempt $.samples attempt $.samples[0].metrics attempt $.samples[0].rawReferences attempt $.samples[0].issues attempt $.issues cohort $.identity.memberSampleIds cohort $.issues cohort $.samples cohort $.samples[0].metrics cohort $.samples[0].rawReferences cohort $.samples[0].issues failure $.issues summary $.workloadIds summary $.conditionalEnvironmentDecisions summary $.sampleOutcomes summary $.sampleOutcomes[0].issues summary $.cohortOutcomes summary $.cohortOutcomes[0].issues summary $.metricSummaries summary $.rawReferences runtime $.deviations runtime $.sourceHashes runtime $.configurationInputs runtime $.resolvedConfiguration runtime $.controllerInputs runtime $.workerCommand.redactedArgv.arguments runtime $.workerCommand.projection.fixedWorkerFlags runtime $.workerCommand.projection.configurationFlags
`);
const discriminants = artifactPathPairs(`
  environment $.schema environment $.environmentId environment $.workloadIds[0] environment $.conditionalEnvironmentDecisions[0].environmentId environment $.conditionalEnvironmentDecisions[0].decision manifest $.schema manifest $.request.schema manifest $.request.environmentId manifest $.request.workloadIds[0] manifest $.request.conditionalEnvironmentDecisions[0].environmentId manifest $.request.conditionalEnvironmentDecisions[0].decision manifest $.workloadIds[0] manifest $.cases[0].workloadId manifest $.outerAttempts[0].workloadId manifest $.outerAttempts[0].environmentId manifest $.outerAttempts[0].intendedPhase manifest $.expectedCohorts[0].workloadId sample $.schema sample $.identity.workloadId sample $.identity.intendedPhase sample $.outcome sample $.evidenceClass attempt $.schema attempt $.locator.workloadId attempt $.locator.environmentId attempt $.locator.intendedPhase attempt $.producerFacts.databaseUrl attempt $.sampleOutcomes[0].identity.workloadId attempt $.sampleOutcomes[0].identity.intendedPhase attempt $.sampleOutcomes[0].outcome attempt $.samples[0].schema attempt $.samples[0].identity.workloadId attempt $.samples[0].identity.intendedPhase attempt $.samples[0].outcome attempt $.samples[0].evidenceClass cohort $.schema cohort $.identity.workloadId cohort $.outcome cohort $.samples[0].schema cohort $.samples[0].identity.workloadId cohort $.samples[0].identity.intendedPhase cohort $.samples[0].outcome cohort $.samples[0].evidenceClass failure $.schema summary $.schema summary $.environmentId summary $.workloadIds[0] summary $.conditionalEnvironmentDecisions[0].environmentId summary $.conditionalEnvironmentDecisions[0].decision summary $.sampleOutcomes[0].identity.workloadId summary $.sampleOutcomes[0].identity.intendedPhase summary $.sampleOutcomes[0].outcome summary $.cohortOutcomes[0].identity.workloadId summary $.cohortOutcomes[0].outcome summary $.metricSummaries[0].workloadId runtime $.host.executionContext runtime $.sourceHashes[0].kind runtime $.resolvedConfiguration[0].source
`);
const objectPaths = artifactPathPairs(`
  environment $ environment $.repeatLink environment $.conditionalEnvironmentDecisions[0] manifest $ manifest $.request manifest $.request.repeatLink manifest $.request.conditionalEnvironmentDecisions[0] manifest $.cases[0] manifest $.outerAttempts[0] manifest $.expectedCohorts[0] manifest $.repeatLink sample $ sample $.identity sample $.metrics[0] sample $.rawReferences[0] sample $.issues[0] attempt $ attempt $.locator attempt $.producerFacts attempt $.sampleOutcomes[0] attempt $.sampleOutcomes[0].identity attempt $.sampleOutcomes[0].issues[0] attempt $.samples[0] attempt $.samples[0].identity attempt $.samples[0].metrics[0] attempt $.samples[0].rawReferences[0] attempt $.samples[0].issues[0] attempt $.issues[0] cohort $ cohort $.identity cohort $.issues[0] cohort $.samples[0] cohort $.samples[0].identity cohort $.samples[0].metrics[0] cohort $.samples[0].rawReferences[0] cohort $.samples[0].issues[0] failure $ failure $.issues[0] summary $ summary $.repeatLink summary $.conditionalEnvironmentDecisions[0] summary $.sampleOutcomes[0] summary $.sampleOutcomes[0].identity summary $.sampleOutcomes[0].issues[0] summary $.cohortOutcomes[0] summary $.cohortOutcomes[0].identity summary $.cohortOutcomes[0].issues[0] summary $.metricSummaries[0] summary $.rawReferences[0] runtime $ runtime $.git runtime $.runtime runtime $.host runtime $.timing runtime $.sourceHashes[0] runtime $.configurationInputs[0] runtime $.resolvedConfiguration[0] runtime $.resolvedConfiguration[0].caseKey runtime $.controllerInputs[0] runtime $.workerCommand runtime $.workerCommand.redactedArgv runtime $.workerCommand.projection
`);
function copyArtifact(value: unknown) {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
function changed<T>(value: T, path: string, replacement: unknown) {
    const copy = copyArtifact(value);
    const { owner, field } = ownerAndField(copy, path);
    owner[field] = replacement;
    return copy as unknown as T;
}
function valueAtPath(root: Record<string, unknown>, path: string) {
    let value: unknown = root;
    for (const key of pathParts(path)) {
        value = (value as Record<string, unknown>)[key];
    }
    return value;
}
function pathParts(path: string) {
    return path
        .replace(/^\$\.?/, '')
        .replaceAll('[', '.')
        .replaceAll(']', '')
        .split('.')
        .filter(Boolean);
}
function ownerAndField(root: Record<string, unknown>, path: string) {
    const parts = pathParts(path);
    return {
        owner: valueAtPath(root, `$.${parts.slice(0, -1).join('.')}`) as unknown as Record<string, unknown>,
        field: parts.at(-1)!
    };
}
function issueRows(result: DecodeResult) {
    return result.ok
        ? null
        : (result.issues ?? []).map(({ path, code, message }) => [path, code, message]);
}
function issueText(result: DecodeResult) {
    return result.ok
        ? null
        : (result.issues ?? [])
            .map(({ path, code, message }) => `${path}\t${code}\t${message}`)
            .join('\n');
}
type SemanticValidator<T> = (value: T) => readonly Issue[];
function invalidText<T>(
    validate: SemanticValidator<T>,
    value: T,
    path: string,
    replacement: unknown
) {
    return issueText({ ok: false, issues: validate(changed(value, path, replacement)) });
}
function failedOutcome(value: typeof identity | typeof cohortIdentity) {
    return { identity: value, outcome: 'failed', issues: [recordedIssue] };
}
describe('RTC baseline artifact decoding and validation', () => {
    it('rejects every missing mandatory artifact and runtime observation field', () => {
        for (const artifactName of Object.keys(mandatoryPaths) as ArtifactName[]) {
            for (const path of mandatoryPaths[artifactName]) {
                const malformed = copyArtifact(artifacts[artifactName]);
                const { owner, field } = ownerAndField(malformed, path);
                delete owner[field];
                expect(issueRows(decoders[artifactName](malformed))).toEqual([
                    [path, 'missing-field', 'Required.']
                ]);
            }
        }
    });
    it('rejects holes in every nested persisted array', () => {
        for (const [artifactName, path] of denseArrays) {
            const malformed = copyArtifact(artifacts[artifactName]);
            delete (valueAtPath(malformed, path) as unknown as unknown[])[0];
            expect(issueRows(decoders[artifactName](malformed))).toEqual([
                [`${path}[0]`, 'sparse-array', 'Array entries must be dense JSON values.']
            ]);
        }
    });
    it('rejects every closed persisted discriminant', () => {
        for (const [artifactName, path] of discriminants) {
            const malformed = copyArtifact(artifacts[artifactName]);
            const { owner, field } = ownerAndField(malformed, path);
            owner[field] = 'unknown';
            expect(issueRows(decoders[artifactName](malformed))).toEqual([
                [path, 'unsupported-value', 'Unsupported value.']
            ]);
        }
    });
    it('rejects unexpected fields at every persisted object boundary', () => {
        for (const [artifactName, path] of objectPaths) {
            const malformed = copyArtifact(artifacts[artifactName]);
            (valueAtPath(malformed, path) as unknown as Record<string, unknown>).unexpected = true;
            const issuePath = path === '$' ? '$.unexpected' : `${path}.unexpected`;
            expect(issueRows(decoders[artifactName](malformed))).toEqual([
                [issuePath, 'unexpected-field', 'Unexpected field.']
            ]);
        }
    });
    it('rejects wrong primitive, range, timestamp, path, and digest values exactly', () => {
        const malformedSample = copyArtifact(sample);
        Object.assign(valueAtPath(malformedSample, '$.metrics[0]') as object, { value: '1024' });
        Object.assign(valueAtPath(malformedSample, '$.rawReferences[0]') as object, {
            relativePath: '../raw.json',
            sha256: 'not-a-digest',
            bytes: -1
        });
        expect(
            issueText(decoding.decodeRtcBaselineSample(malformedSample as unknown as RtcBaselineJson))
        ).toBe(`$.metrics[0].value\texpected-number\tExpected a number.
$.rawReferences[0].relativePath\tinvalid-relative-path\tExpected a confined relative path.
$.rawReferences[0].sha256\tinvalid-sha256\tExpected a lowercase 64-character SHA-256 digest.
$.rawReferences[0].bytes\texpected-nonnegative-integer\tExpected a nonnegative integer.`);
        const malformedRuntime = copyArtifact(observation);
        Object.assign(valueAtPath(malformedRuntime, '$.host') as object, { logicalCpuCount: -1 });
        Object.assign(valueAtPath(malformedRuntime, '$.timing') as object, {
            startedAtUtc: 'yesterday'
        });
        Object.assign(valueAtPath(malformedRuntime, '$.sourceHashes[0]') as object, {
            path: '/absolute.ts',
            sha256: 'not-a-digest'
        });
        Object.assign(valueAtPath(malformedRuntime, '$.configurationInputs[0]') as object, {
            value: []
        });
        Object.assign(valueAtPath(malformedRuntime, '$.resolvedConfiguration[0]') as object, {
            value: null
        });
        Object.assign(valueAtPath(malformedRuntime, '$.allowlistedEnvironment') as object, {
            DATABASE_URL: 0
        });
        expect(
            issueText(
                decoding.decodeRtcBaselineRuntimeObservation(
                    malformedRuntime as unknown as RtcBaselineJson
                )
            )
        ).toBe(`$.host.logicalCpuCount\texpected-positive-integer\tExpected a positive integer.
$.timing.startedAtUtc\tinvalid-timestamp\tExpected an ISO 8601 UTC timestamp.
$.sourceHashes[0].path\tinvalid-relative-path\tExpected a confined relative path.
$.sourceHashes[0].sha256\tinvalid-sha256\tExpected a lowercase 64-character SHA-256 digest.
$.configurationInputs[0].value\texpected-scalar\tExpected a boolean, number, string, or null.
$.resolvedConfiguration[0].value\texpected-scalar\tExpected a boolean, number, or string.
$.allowlistedEnvironment.DATABASE_URL\texpected-string\tExpected a string.`);
        expect(
            decoding.decodeRtcBaselineSample(
                changed(sample, '$.issues[0].details', { stderr: ['producer failed'], retryable: false })
            ).ok
        ).toBe(true);
        expect(
            issueRows(decoding.decodeRtcBaselineSample(changed(sample, '$.rawEvidence', undefined)))
        ).toEqual([['$.rawEvidence', 'invalid-json-value', 'Expected a JSON value.']]);
    });
    it('runs every semantic artifact validator and complete accounting owner', () => {
        const v = validation;
        expect([
            invalidText(
                v.validateRtcBaselineManifest,
                manifest,
                '$.repeatLink.primarySummarySha256',
                'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
            ),
            invalidText(v.validateRtcBaselineSample, sample, '$.identity.sampleId', 'wrong'),
            invalidText(v.validateRtcBaselineSummary, summary, '$.baselineId', 'invalid'),
            invalidText(v.validateRtcBaselineFinalizationFailure, failure, '$.baselineId', 'invalid'),
            invalidText(v.validateRtcBaselineExternalCohort, cohort, '$.identity.memberSampleIds', [
                identity.sampleId,
                identity.sampleId
            ]),
            invalidText(
                v.validateRtcBaselineRuntimeObservation,
                observation,
                '$.timing.endedAtUtc',
                '2026-08-07T09:00:00.000Z'
            )
        ]).toEqual([
            '$.repeatLink\trepeat-link-mismatch\tManifest request and artifact repeat links must match.',
            '$.identity.sampleId\tsample-id-mismatch\tSample ID does not match its identity fields.',
            '$.baselineId\tinvalid-baseline-id\tBaseline ID does not match the canonical grammar.',
            '$.baselineId\tinvalid-baseline-id\tBaseline ID does not match the canonical grammar.',
            `$.identity.memberSampleIds[1]\tduplicate-member-sample\tCohort member sample IDs must be unique.
$.samples\tcohort-member-samples-mismatch\tExternal cohort samples must exactly match its ordered member sample IDs.`,
            '$.timing.endedAtUtc\tinvalid-timing-order\tRuntime observation must end after it starts.'
        ]);
        const invalidProducerFacts = copyArtifact(attempt);
        (invalidProducerFacts.producerFacts as Record<string, unknown>).allScenariosPresent = true;
        (invalidProducerFacts.producerFacts as Record<string, unknown>).allScenariosRaw = '1';
        expect(
            issueText({
                ok: false,
                issues: validation.validateRtcBaselineExternalAttempt(
                    invalidProducerFacts as unknown as RtcBaselineExternalAttemptDto
                )
            })
        ).toBe(
            '$.producerFacts.allScenariosRaw\tproducer-fact-mismatch\tStored B06 producer facts do not match the selected case.'
        );
        const invalidAttempt = copyArtifact(attempt);
        Object.assign((invalidAttempt.samples as Record<string, unknown>[])[0]!.identity!, {
            caseId: 'wrong-case'
        });
        (invalidAttempt.samples as Record<string, unknown>[])[0]!.evidenceClass = 'synthetic-path';
        expect(
            issueRows({
                ok: false,
                issues: validation.validateRtcBaselineExternalAttempt(
                    invalidAttempt as unknown as RtcBaselineExternalAttemptDto
                )
            })
        ).toEqual([
            [
                '$.samples[0].identity',
                'attempt-sample-identity-mismatch',
                'External attempt sample identity differs from its locator.'
            ],
            [
                '$.samples[0].evidenceClass',
                'attempt-evidence-class-mismatch',
                'External attempt sample has the wrong evidence class.'
            ],
            [
                '$.sampleOutcomes',
                'attempt-outcome-projection-mismatch',
                'External attempt outcomes must exactly project its samples.'
            ]
        ]);
        const invalidCohort = copyArtifact(cohort);
        (invalidCohort.identity as Record<string, unknown>).memberSampleIds = ['wrong'];
        (invalidCohort.samples as Record<string, unknown>[])[0]!.evidenceClass = 'native-browser';
        expect(
            issueRows({
                ok: false,
                issues: validation.validateRtcBaselineExternalCohort(
                    invalidCohort as unknown as RtcBaselineExternalCohortDto
                )
            })
        ).toEqual([
            [
                '$.samples',
                'cohort-member-samples-mismatch',
                'External cohort samples must exactly match its ordered member sample IDs.'
            ],
            [
                '$.samples[0].evidenceClass',
                'cohort-evidence-class-mismatch',
                'External cohort samples must contain local full-stack evidence.'
            ]
        ]);
        expect(
            issueRows({
                ok: false,
                issues: validation.validateRtcBaselineCompleteAccounting({
                    expectedSamples: [identity, { ...identity, sampleId: 'missing' }],
                    expectedCohorts: [cohortIdentity, { ...cohortIdentity, cohortId: 'missing' }],
                    sampleOutcomes: [
                        failedOutcome({ ...identity, caseId: 'wrong' }),
                        failedOutcome(identity),
                        failedOutcome({ ...identity, sampleId: 'extra' })
                    ],
                    cohortOutcomes: [
                        failedOutcome({ ...cohortIdentity, memberSampleIds: ['wrong'] }),
                        failedOutcome(cohortIdentity),
                        failedOutcome({ ...cohortIdentity, cohortId: 'extra' })
                    ]
                })
            })
        ).toEqual([
            ['$.sampleOutcomes[0].identity', 'sample-identity-mismatch', 'Sample identity differs.'],
            ['$.sampleOutcomes[1]', 'duplicate-sample-outcome', 'Sample outcome is duplicated.'],
            ['$.sampleOutcomes[2]', 'extra-sample-outcome', 'Sample outcome is extra.'],
            ['$.sampleOutcomes', 'missing-sample-outcome', 'Sample outcome is missing.'],
            ['$.cohortOutcomes[0].identity', 'cohort-identity-mismatch', 'Cohort identity differs.'],
            ['$.cohortOutcomes[1]', 'duplicate-cohort-outcome', 'Cohort outcome is duplicated.'],
            ['$.cohortOutcomes[2]', 'extra-cohort-outcome', 'Cohort outcome is extra.'],
            ['$.cohortOutcomes', 'missing-cohort-outcome', 'Cohort outcome is missing.']
        ]);
        for (
            const [field, message] of [
                ['git', 'Runtime observation field git changed.'],
                ['runtime', 'Runtime observation field runtime changed.'],
                ['host', 'Runtime observation field host changed.'],
                ['sourceHashes', 'Runtime observation field sourceHashes changed.'],
                ['configurationInputs', 'Runtime observation field configurationInputs changed.'],
                ['resolvedConfiguration', 'Runtime observation field resolvedConfiguration changed.'],
                ['controllerInputs', 'Runtime observation field controllerInputs changed.'],
                ['workerCommand', 'Runtime observation field workerCommand changed.'],
                ['allowlistedEnvironment', 'Runtime observation field allowlistedEnvironment changed.']
            ] as const
        ) {
            expect(
                issueRows({
                    ok: false,
                    issues: v.validateRtcBaselineReconciliation(
                        observation,
                        changed(observation, `$.${field}`, [])
                    )
                })
            ).toEqual([[`$.${field}`, 'reconciliation-mismatch', message]]);
        }
        const driftedSummary = changed(summary, '$.environmentId', 'E4-pg');
        driftedSummary.repeatLink = null;
        driftedSummary.conditionalEnvironmentDecisions = [];
        expect(
            issueRows({
                ok: false,
                issues: v.validateRtcBaselineArtifactReconciliation({
                    baselineId: environment.baselineId,
                    environment: changed(environment, '$.baselineId', repeatLink.primaryBaselineId),
                    manifest: changed(manifest, '$.workloadIds', ['RTC-B05']),
                    summary: driftedSummary
                })
            })
        ).toEqual([
            [
                '$.environment.baselineId',
                'artifact-baseline-id-mismatch',
                'Environment baseline ID differs.'
            ],
            [
                '$.manifest.workloadIds',
                'artifact-workload-list-mismatch',
                'Manifest workload list differs.'
            ],
            [
                '$.summary.environmentId',
                'artifact-environment-id-mismatch',
                'Summary environment differs.'
            ],
            ['$.summary.repeatLink', 'artifact-repeat-link-mismatch', 'Summary repeat link differs.'],
            [
                '$.summary.conditionalEnvironmentDecisions',
                'artifact-decisions-mismatch',
                'Summary decisions differ.'
            ]
        ]);
    });
});
