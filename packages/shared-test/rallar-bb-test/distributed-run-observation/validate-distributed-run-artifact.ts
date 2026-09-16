import type { ControlDistributedRunArtifactBundle } from '../control-snapshots.ts';
import {
    distributedArtifactPipelineFile,
    type ParsedDistributedArtifactPipeline
} from '../distributed-artifact-pipeline.ts';
import type { DistributedRunArtifactValidation } from './distributed-run-row-contracts.ts';

export function validateDistributedRunArtifact(
    bundle: ControlDistributedRunArtifactBundle | undefined
): DistributedRunArtifactValidation {
    if (!bundle) {
        return {
            status: 'not-loaded',
            fileCount: 0,
            message: 'Artifact bundle has not been loaded.'
        };
    }

    const baseRequiredFiles: ReadonlyArray<keyof ControlDistributedRunArtifactBundle['files']> = [
        'distributed-run.json',
        'manifest.json',
        'control-run.json'
    ];
    const v2RequiredFiles: ReadonlyArray<keyof ControlDistributedRunArtifactBundle['files']> = [
        'report.json',
        'failures.json',
        'metadata.json'
    ];
    const requiredFiles = bundle.artifactSchemaVersion >= 2
        ? [...baseRequiredFiles, ...v2RequiredFiles]
        : baseRequiredFiles;
    const missing = requiredFiles.filter((fileName) => bundle.files[fileName] === undefined);
    if (missing.length > 0) {
        return {
            status: 'missing-file',
            fileCount: Object.keys(bundle.files).length,
            message: `Missing ${missing.join(', ')}.`
        };
    }
    try {
        [
            ...baseRequiredFiles,
            ...(
                bundle.artifactSchemaVersion >= 2
                    ? ['report.json', 'failures.json', 'metadata.json'] as const
                    : []
            )
        ].forEach((fileName) => JSON.parse(bundle.files[fileName] ?? ''));
    }
    catch (caught) {
        return {
            status: 'invalid-json',
            fileCount: Object.keys(bundle.files).length,
            message: caught instanceof Error ? caught.message : String(caught)
        };
    }
    return {
        status: 'valid',
        fileCount: Object.keys(bundle.files).length,
        message: bundle.artifactSchemaVersion >= 2
            ? 'Distributed artifact v2 analysis files are present and valid.'
            : 'Distributed artifact v1 snapshot files are present and valid JSON.'
    };
}

export function validateDistributedRunArtifactFromParsed(
    bundle: ControlDistributedRunArtifactBundle | undefined,
    parsed: ParsedDistributedArtifactPipeline
): DistributedRunArtifactValidation {
    if (!bundle) {
        return {
            status: 'not-loaded',
            fileCount: 0,
            message: 'Artifact bundle has not been loaded.'
        };
    }
    const baseRequiredFiles = [
        'distributed-run.json',
        'manifest.json',
        'control-run.json'
    ] as const;
    const v2RequiredFiles = [
        'report.json',
        'failures.json',
        'metadata.json'
    ] as const;
    const requiredFiles = bundle.artifactSchemaVersion >= 2
        ? [...baseRequiredFiles, ...v2RequiredFiles]
        : [...baseRequiredFiles];
    const missing = requiredFiles.filter((fileName) => bundle.files[fileName] === undefined);
    if (missing.length > 0) {
        return {
            status: 'missing-file',
            fileCount: Object.keys(bundle.files).length,
            message: `Missing ${missing.join(', ')}.`
        };
    }
    for (const fileName of requiredFiles) {
        const parsedFileName = fileName === 'manifest.json' &&
                parsed.projectedFiles['manifest.json'] === undefined
            ? 'distributed-run.json'
            : fileName;
        const file = distributedArtifactPipelineFile(parsed, parsedFileName);
        if (file.format !== 'json' || file.status !== 'parsed') {
            const prefix = `${parsedFileName} is not valid JSON: `;
            const message = file.message?.startsWith(prefix)
                ? file.message.slice(prefix.length)
                : file.message ?? `${fileName} is not valid JSON.`;
            return {
                status: 'invalid-json',
                fileCount: Object.keys(bundle.files).length,
                message
            };
        }
    }
    return {
        status: 'valid',
        fileCount: Object.keys(bundle.files).length,
        message: bundle.artifactSchemaVersion >= 2
            ? 'Distributed artifact v2 analysis files are present and valid.'
            : 'Distributed artifact v1 snapshot files are present and valid JSON.'
    };
}
