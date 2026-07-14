import type { ControlDistributedRunArtifactBundle } from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import {
    ANALYZE_AGENT_ID,
    ANALYZE_BASE_EPOCH_MS,
    ANALYZE_COMMAND_ID,
    ANALYZE_CONTROL_RUN_ID,
    ANALYZE_DIAGNOSTIC_MESSAGE,
    ANALYZE_DISTRIBUTED_RUN_ID,
    ANALYZE_FAILURE_MESSAGE,
    ANALYZE_GENERATED_AT_EPOCH_MS,
    ANALYZE_RECIPE_ID,
    createAnalyzeControlRun,
    createAnalyzeDistributedRun,
    createAnalyzeManifest,
} from './recipe-console-analyze-run-data.ts';

export type AnalyzeUploadFile = Readonly<{
    name: string;
    mimeType: string;
    buffer: Buffer;
}>;

export function createAnalyzeLooseFiles(): readonly AnalyzeUploadFile[] {
    return [
        ...Object.entries(createAnalyzeArtifactFiles()).map(([name, contents]) => ({
            name,
            mimeType: name.endsWith('.jsonl')
                ? 'application/x-ndjson'
                : 'application/json',
            buffer: Buffer.from(contents),
        })),
        {
            name: 'operator-notes.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('This file must be inventoried as ignored.'),
        },
    ];
}

export function createAnalyzeEnvelopeFile(): AnalyzeUploadFile {
    return {
        name: `${ANALYZE_DISTRIBUTED_RUN_ID}-artifact.json`,
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(createAnalyzeArtifactEnvelope(), null, 2)),
    };
}

export function createAnalyzeEnvelopeFileForSchema(
    artifactSchemaVersion: number,
): AnalyzeUploadFile {
    return upload('future-schema-artifact.json', JSON.stringify({
        ...createAnalyzeArtifactEnvelope(),
        artifactSchemaVersion,
    }, null, 2));
}

export function createAnalyzeCandidateFiles(
    count: number,
): readonly AnalyzeUploadFile[] {
    return Array.from({ length: count }, (_, index) => upload(
        `candidate-${String(index + 1).padStart(2, '0')}.json`,
        JSON.stringify({ candidate: index + 1 }),
    ));
}

export function createAnalyzeLooseFilesForIdentity(identity: Readonly<{
    distributedRunId: string;
    controlRunId: string;
}>): readonly AnalyzeUploadFile[] {
    return createAnalyzeLooseFiles().map(file => ({
        ...file,
        buffer: file.name.endsWith('.json') || file.name.endsWith('.jsonl')
            ? Buffer.from(replaceArtifactIdentity(
                file.buffer.toString('utf8'),
                identity,
            ))
            : file.buffer,
    }));
}

export function createAnalyzeArtifactEnvelopeForIdentity(input: Readonly<{
    outerDistributedRunId: string;
    fileDistributedRunId: string;
    fileControlRunId: string;
}>): ControlDistributedRunArtifactBundle {
    const files = Object.fromEntries(
        Object.entries(createAnalyzeArtifactFiles()).map(([fileName, contents]) => [
            fileName,
            replaceArtifactIdentity(contents, {
                distributedRunId: input.fileDistributedRunId,
                controlRunId: input.fileControlRunId,
            }),
        ]),
    );
    return {
        artifactSchemaVersion: 2,
        distributedRunId: input.outerDistributedRunId,
        generatedAtEpochMs: ANALYZE_GENERATED_AT_EPOCH_MS,
        files: files as ControlDistributedRunArtifactBundle['files'],
    };
}

export function createMalformedAnalyzeFiles(): readonly AnalyzeUploadFile[] {
    return [upload('malformed-artifact-envelope.json', JSON.stringify({
        artifactSchemaVersion: '2',
        distributedRunId: ANALYZE_DISTRIBUTED_RUN_ID,
        generatedAtEpochMs: ANALYZE_GENERATED_AT_EPOCH_MS,
        files: createAnalyzeArtifactFiles(),
    }))];
}

export function createDuplicateAnalyzeFiles(): readonly AnalyzeUploadFile[] {
    return [
        upload('manifest.json', JSON.stringify({ source: 'first' })),
        upload('manifest.json', JSON.stringify({ source: 'second' })),
    ];
}

export function createAnalyzeArtifactEnvelope(): ControlDistributedRunArtifactBundle {
    return {
        artifactSchemaVersion: 2,
        distributedRunId: ANALYZE_DISTRIBUTED_RUN_ID,
        generatedAtEpochMs: ANALYZE_GENERATED_AT_EPOCH_MS,
        files: createAnalyzeArtifactFiles() as ControlDistributedRunArtifactBundle['files'],
    };
}

function createAnalyzeArtifactFiles(): Readonly<Record<string, string>> {
    const diagnostic = {
        kind: 'diagnostic', protocolVersion: 1,
        runId: ANALYZE_CONTROL_RUN_ID,
        agentId: ANALYZE_AGENT_ID,
        commandId: ANALYZE_COMMAND_ID,
        eventId: 'analyze-diagnostic-relay',
        atEpochMs: ANALYZE_BASE_EPOCH_MS + 700,
        payload: {
            topic: 'rtc.route',
            diagnosticTypeId: 'rallar.browser.rtc.no_relay',
            severity: 'error', transport: 'messages.rtc',
            message: ANALYZE_DIAGNOSTIC_MESSAGE,
            data: { candidate: 'relay', region: 'eu-north', allocation: 'missing' },
        },
    };
    const priorEvent = {
        kind: 'event', protocolVersion: 1,
        runId: ANALYZE_CONTROL_RUN_ID,
        agentId: ANALYZE_AGENT_ID,
        commandId: ANALYZE_COMMAND_ID,
        eventId: 'analyze-event-prior-relay',
        atEpochMs: ANALYZE_BASE_EPOCH_MS + 200,
        payload: {
            topic: 'rtc.route.prior',
            message: 'Previous relay allocation succeeded before the regression.',
            transport: 'rtc',
        },
    };
    const failedResult = {
        resultKey: `result:${ANALYZE_COMMAND_ID}`,
        runId: ANALYZE_CONTROL_RUN_ID,
        agentId: ANALYZE_AGENT_ID,
        recipeId: ANALYZE_RECIPE_ID,
        commandId: ANALYZE_COMMAND_ID,
        status: 'FAILURE', action: 'send', transport: 'rtc',
        startedAtEpochMs: ANALYZE_BASE_EPOCH_MS + 300,
        endedAtEpochMs: ANALYZE_BASE_EPOCH_MS + 1_500,
        durationMs: 1_200,
        error: {
            code: 'RTC_NO_RELAY', message: ANALYZE_FAILURE_MESSAGE,
            details: { expectedCandidate: 'relay', region: 'eu-north' },
        },
    };
    return {
        'distributed-run.json': JSON.stringify(createAnalyzeDistributedRun(), null, 2),
        'manifest.json': JSON.stringify(createAnalyzeManifest(), null, 2),
        'control-run.json': JSON.stringify(createAnalyzeControlRun(), null, 2),
        'results.jsonl': `${JSON.stringify(failedResult)}\n`,
        'events.jsonl': [
            JSON.stringify(priorEvent),
            JSON.stringify(diagnostic),
            JSON.stringify(diagnostic),
            '{malformed-optional-row',
        ].join('\n'),
    };
}

function upload(name: string, contents: string): AnalyzeUploadFile {
    return { name, mimeType: 'application/json', buffer: Buffer.from(contents) };
}

function replaceArtifactIdentity(
    contents: string,
    identity: Readonly<{ distributedRunId: string; controlRunId: string }>,
): string {
    return contents
        .replaceAll(ANALYZE_DISTRIBUTED_RUN_ID, identity.distributedRunId)
        .replaceAll(ANALYZE_CONTROL_RUN_ID, identity.controlRunId);
}
