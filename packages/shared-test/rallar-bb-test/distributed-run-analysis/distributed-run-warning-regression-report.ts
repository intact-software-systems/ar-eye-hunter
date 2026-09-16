import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot
} from '../control-snapshots.ts';
import { deriveDistributedRunMonitor, type DistributedRunMonitor } from '../distributed-run-monitor.ts';
import type { DistributedRunArtifactValidationStatus } from '../distributed-run-observation/distributed-run-row-contracts.ts';
import { uniqueSortedValues } from '../distributed/unique-sorted-values.ts';
import type { RallarBlackBoxTestSeverity } from '../rallar-black-box-test-contracts.ts';
import { toDistributedRunMonitorEvidenceText } from './to-distributed-run-monitor-evidence-text.ts';

export type DistributedRunWarningRegressionExpectation = Readonly<{
    messageEvidence?: readonly string[];
    diagnosticTypeIds?: readonly string[];
    compositeRecipeIds?: readonly string[];
    failOnDiagnosticSeverities?: readonly RallarBlackBoxTestSeverity[];
}>;

export type DistributedRunWarningRegressionReport = Readonly<{
    schemaVersion: 1;
    distributedRunId: string;
    ok: boolean;
    expected: Readonly<{
        messageEvidence: readonly string[];
        diagnosticTypeIds: readonly string[];
        compositeRecipeIds: readonly string[];
        failOnDiagnosticSeverities: readonly RallarBlackBoxTestSeverity[];
    }>;
    observed: Readonly<{
        monitorMessageEvidence: readonly string[];
        artifactMessageEvidence: readonly string[];
        diagnosticTypeIds: readonly string[];
        warningDiagnosticTypeIds: readonly string[];
        highSeverityDiagnosticTypeIds: readonly string[];
        compositeRecipeIds: readonly string[];
        artifactStatus: DistributedRunArtifactValidationStatus;
    }>;
    failures: readonly string[];
}>;

export function deriveDistributedRunWarningRegressionReport(
    input: Readonly<{
        distributedRun: ControlDistributedRunSnapshot;
        controlRun?: ControlRunSnapshot;
        artifactBundle?: ControlDistributedRunArtifactBundle;
        expectation?: DistributedRunWarningRegressionExpectation;
    }>
): DistributedRunWarningRegressionReport {
    const monitor = deriveDistributedRunMonitor(input);
    const expectation = input.expectation ?? {};
    const expectedMessageEvidence = expectation.messageEvidence ?? [];
    const expectedDiagnosticTypeIds = expectation.diagnosticTypeIds ?? [];
    const expectedCompositeRecipeIds = expectation.compositeRecipeIds ?? [];
    const failOnDiagnosticSeverities = expectation.failOnDiagnosticSeverities ?? ['error'];
    const observed = toWarningRegressionObservations({
        monitor,
        artifactBundle: input.artifactBundle,
        expectedMessageEvidence,
        failOnDiagnosticSeverities
    });
    const {
        monitorMessageEvidence,
        artifactMessageEvidence,
        diagnosticTypeIds,
        compositeRecipeIds,
        highSeverityDiagnosticTypeIds
    } = observed;

    const failures = toWarningRegressionFailures({
        artifactBundle: input.artifactBundle,
        artifactStatus: monitor.artifact.status,
        artifactMessage: monitor.artifact.message,
        expectedMessageEvidence,
        expectedDiagnosticTypeIds,
        expectedCompositeRecipeIds,
        monitorMessageEvidence,
        artifactMessageEvidence,
        diagnosticTypeIds,
        compositeRecipeIds,
        highSeverityDiagnosticTypeIds
    });

    return {
        schemaVersion: 1,
        distributedRunId: input.distributedRun.distributedRunId,
        ok: failures.length === 0,
        expected: {
            messageEvidence: expectedMessageEvidence,
            diagnosticTypeIds: expectedDiagnosticTypeIds,
            compositeRecipeIds: expectedCompositeRecipeIds,
            failOnDiagnosticSeverities
        },
        observed,
        failures
    };
}

function toWarningRegressionObservations(
    input: Readonly<{
        monitor: DistributedRunMonitor;
        artifactBundle: ControlDistributedRunArtifactBundle | undefined;
        expectedMessageEvidence: readonly string[];
        failOnDiagnosticSeverities: readonly RallarBlackBoxTestSeverity[];
    }>
): DistributedRunWarningRegressionReport['observed'] {
    const { monitor, expectedMessageEvidence } = input;
    const monitorEvidenceText = toDistributedRunMonitorEvidenceText(monitor);
    const artifactEvidenceText = input.artifactBundle
        ? Object.values(input.artifactBundle.files).join('\n')
        : '';
    return {
        monitorMessageEvidence: expectedMessageEvidence
            .filter((value) => monitorEvidenceText.includes(value)),
        artifactMessageEvidence: expectedMessageEvidence
            .filter((value) => artifactEvidenceText.includes(value)),
        diagnosticTypeIds: uniqueSortedValues(
            monitor.runtimeDiagnostics.map((row) => row.diagnosticTypeId)
        ),
        warningDiagnosticTypeIds: uniqueSortedValues(
            monitor.runtimeDiagnostics
                .filter((row) => row.severity === 'warning')
                .map((row) => row.diagnosticTypeId)
        ),
        highSeverityDiagnosticTypeIds: uniqueSortedValues(
            monitor.runtimeDiagnostics
                .filter((row) => input.failOnDiagnosticSeverities.includes(row.severity))
                .map((row) => row.diagnosticTypeId)
        ),
        compositeRecipeIds: uniqueSortedValues(
            monitor.compositeDrilldowns
                .map((row) => row.recipeId ?? row.commandId)
                .filter((value): value is string => Boolean(value))
        ),
        artifactStatus: monitor.artifact.status
    };
}

function toWarningRegressionFailures(
    input: Readonly<{
        artifactBundle: ControlDistributedRunArtifactBundle | undefined;
        artifactStatus: DistributedRunArtifactValidationStatus;
        artifactMessage: string;
        expectedMessageEvidence: readonly string[];
        expectedDiagnosticTypeIds: readonly string[];
        expectedCompositeRecipeIds: readonly string[];
        monitorMessageEvidence: readonly string[];
        artifactMessageEvidence: readonly string[];
        diagnosticTypeIds: readonly string[];
        compositeRecipeIds: readonly string[];
        highSeverityDiagnosticTypeIds: readonly string[];
    }>
): readonly string[] {
    const artifactHasEmbeddedEvidence = Boolean(
        input.artifactBundle?.files['events.jsonl'] || input.artifactBundle?.files['results.jsonl']
    );
    return [
        ...input.expectedMessageEvidence
            .filter((value) => !input.monitorMessageEvidence.includes(value))
            .map((value) => `Monitor evidence is missing expected message payload token: ${value}`),
        ...(
            input.artifactBundle && artifactHasEmbeddedEvidence
                ? input.expectedMessageEvidence
                    .filter((value) => !input.artifactMessageEvidence.includes(value))
                    .map((value) => `Artifact evidence is missing expected message payload token: ${value}`)
                : []
        ),
        ...input.expectedDiagnosticTypeIds
            .filter((value) => !input.diagnosticTypeIds.includes(value))
            .map((value) => `Monitor diagnostics are missing expected diagnostic type: ${value}`),
        ...input.expectedCompositeRecipeIds
            .filter((value) => !input.compositeRecipeIds.includes(value))
            .map((value) => `Monitor composite drilldowns are missing expected recipe: ${value}`),
        ...input.highSeverityDiagnosticTypeIds
            .map((value) => `High-severity runtime diagnostic observed: ${value}`),
        ...(
            input.artifactBundle && input.artifactStatus !== 'valid'
                ? [`Distributed artifact is ${input.artifactStatus}: ${input.artifactMessage}`]
                : []
        )
    ];
}
