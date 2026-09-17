import {
    distributedArtifactPipelineJsonRecord,
    type ParsedDistributedArtifactPipeline
} from './distributed-artifact-pipeline.ts';

export interface DistributedArtifactEvidenceSourceFiles {
    readonly parsed: ParsedDistributedArtifactPipeline;
    readonly sourceFileNames: ReadonlySet<string>;
}

/**
 * Results or events come from control-run.json when that file records any itself; the decoded control run also
 * carries the JSONL rows that stand in for it, so it cannot tell the two apart.
 */
export function resolveDistributedArtifactEvidenceSourceFile(
    input: DistributedArtifactEvidenceSourceFiles,
    controlField: 'results' | 'events',
    jsonlFile: 'results.jsonl' | 'events.jsonl'
): string {
    const recorded = distributedArtifactPipelineJsonRecord(input.parsed, 'control-run.json')[controlField];
    if (Array.isArray(recorded) && recorded.length > 0) {
        return 'control-run.json';
    }
    if (input.parsed.projectedFiles[jsonlFile] !== undefined) {
        return jsonlFile;
    }
    return input.sourceFileNames.has('control-run.json') ? 'control-run.json' : jsonlFile;
}
