import type {
    ControlFleetReportBundle,
    ControlFleetReportFiles,
} from '@shared-test/rallar-bb-test/fleet-report.ts';

export const FLEET_ARTIFACT_FILE_NAMES = [
    'fleet-report.json',
    'summary.md',
    'agent-results.csv',
    'failure-signatures.csv',
] as const satisfies readonly (keyof ControlFleetReportFiles)[];

export type FleetArtifactModel = Readonly<{
    distributedRunId: string;
    generatedAtEpochMs: number;
    files: readonly Readonly<{
        name: typeof FLEET_ARTIFACT_FILE_NAMES[number];
        content: string;
        utf8Bytes: number;
    }>[];
    totalUtf8Bytes: number;
    bundle: ControlFleetReportBundle;
}>;

export function deriveFleetArtifactModel(
    bundle: ControlFleetReportBundle,
): FleetArtifactModel {
    const encoder = new TextEncoder();
    const files = FLEET_ARTIFACT_FILE_NAMES.map(name => {
        const content = bundle.files[name];
        return {
            name,
            content,
            utf8Bytes: encoder.encode(content).byteLength,
        } as const;
    });
    return {
        distributedRunId: bundle.distributedRunId,
        generatedAtEpochMs: bundle.generatedAtEpochMs,
        files,
        totalUtf8Bytes: files.reduce((total, file) => total + file.utf8Bytes, 0),
        bundle,
    };
}
