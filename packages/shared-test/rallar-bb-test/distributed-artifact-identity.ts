import type { DistributedRunArtifactFiles } from './distributed-artifact-analysis.ts';
import type { DistributedArtifactWorkspaceIssue } from './distributed-artifact-workspace-contracts.ts';

type IdentityEvidence = Readonly<{
    fileName: string;
    distributedRunId?: string;
    controlRunId?: string;
}>;

export function distributedArtifactIdentityIssues(
    files: DistributedRunArtifactFiles,
): readonly DistributedArtifactWorkspaceIssue[] {
    const distributed = recordFromFile(files['distributed-run.json']);
    const embeddedManifest = record(distributed.manifest);
    const manifest = recordFromFile(files['manifest.json']);
    const controlRun = recordFromFile(files['control-run.json']);
    const report = recordFromFile(files['report.json']);
    const metadata = recordFromFile(files['metadata.json']);
    const evidence: IdentityEvidence[] = [
        {
            fileName: 'distributed-run.json',
            distributedRunId: string(distributed.distributedRunId),
            controlRunId: string(distributed.controlRunId),
        },
        {
            fileName: 'distributed-run.json#manifest',
            distributedRunId: string(embeddedManifest.distributedRunId),
            controlRunId: string(embeddedManifest.controlRunId),
        },
        {
            fileName: 'manifest.json',
            distributedRunId: string(manifest.distributedRunId),
            controlRunId: string(manifest.controlRunId),
        },
        {
            fileName: 'control-run.json',
            controlRunId: string(controlRun.runId),
        },
        {
            fileName: 'report.json',
            distributedRunId: string(report.distributedRunId),
            controlRunId: string(report.controlRunId),
        },
        {
            fileName: 'metadata.json',
            distributedRunId: string(metadata.distributedRunId),
            controlRunId: string(metadata.controlRunId),
        },
    ];
    return [
        ...dimensionIssues(
            evidence,
            'distributedRunId',
            'distributed run',
        ),
        ...dimensionIssues(evidence, 'controlRunId', 'control run'),
    ];
}

function dimensionIssues(
    evidence: readonly IdentityEvidence[],
    dimension: 'distributedRunId' | 'controlRunId',
    label: string,
): DistributedArtifactWorkspaceIssue[] {
    const canonical = evidence.find(item => item[dimension])?.[dimension];
    if (!canonical) return [];
    return evidence.flatMap(item => {
        const observed = item[dimension];
        if (!observed || observed === canonical) return [];
        return [{
            code: 'identity-conflict' as const,
            severity: 'error' as const,
            fileName: item.fileName.split('#')[0],
            message: `${item.fileName} identifies ${label} ${observed}, but the imported artifact workspace identifies ${canonical}.`,
        }];
    });
}

function recordFromFile(text: string | undefined): Record<string, unknown> {
    if (text === undefined) return {};
    try {
        return record(JSON.parse(text));
    } catch {
        return {};
    }
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function string(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
        ? value
        : undefined;
}
