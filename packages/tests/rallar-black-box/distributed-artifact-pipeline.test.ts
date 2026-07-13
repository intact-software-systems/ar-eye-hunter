import { describe, expect, it } from 'vitest';
import {
    distributedArtifactPipelineFile,
    parseDistributedArtifactPipeline,
    type DistributedRunArtifactFiles,
} from '../../../packages/shared-test/rallar-bb-test/mod.ts';
import { projectDistributedArtifactEnvelope } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-envelope.ts';

function jsonParseError(text: string): string {
    try {
        JSON.parse(text);
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    throw new Error('Expected malformed JSON.');
}

function envelope(distributedRunId: string, files: Record<string, unknown>): string {
    return JSON.stringify({
        artifactSchemaVersion: 2,
        distributedRunId,
        generatedAtEpochMs: 7,
        files,
    });
}

describe('distributed artifact parse pipeline', () => {
    it('visits one loose source collection and parses each document and JSONL row at most once', () => {
        const files = {
            'distributed-run.json': '{"distributedRunId":"dist-scale"}',
            'metadata.json': '  \n',
            'failures.json': '{',
            'results.jsonl': '  \n{"id":"first"}\r\nnot-json\n\n42\n',
            'events.jsonl': ' \r\n\t',
            'target-resolution.json': undefined,
        };
        const pipeline = parseDistributedArtifactPipeline(files);

        expect(pipeline.source).toBe('loose-files');
        expect(pipeline.projectedFiles).toEqual(files);
        expect(pipeline.telemetry).toEqual({
            pipelinePassCount: 1,
            sourceCollectionPassCount: 1,
            sourceFileVisitCount: 6,
            jsonDocumentParseCount: 2,
            jsonDocumentParseCountByFile: {
                'distributed-run.json': 1,
                'metadata.json': 0,
                'failures.json': 1,
                'target-resolution.json': 0,
            },
            jsonlFilePassCount: 2,
            jsonlFilePassCountByFile: {
                'results.jsonl': 1,
                'events.jsonl': 1,
            },
            jsonlRowParseCount: 3,
            jsonlRowParseCountByFile: {
                'results.jsonl': 3,
                'events.jsonl': 0,
            },
        });
        expect(pipeline.files['distributed-run.json']).toMatchObject({
            format: 'json',
            status: 'parsed',
            text: files['distributed-run.json'],
            value: { distributedRunId: 'dist-scale' },
        });
        expect(pipeline.files['metadata.json']).toMatchObject({
            format: 'json', status: 'empty', text: files['metadata.json'],
        });
        expect(pipeline.files['failures.json']).toMatchObject({
            format: 'json', status: 'malformed', text: files['failures.json'],
            message: `failures.json is not valid JSON: ${jsonParseError('{')}`,
        });
        expect(pipeline.files['results.jsonl']).toMatchObject({
            format: 'jsonl', text: files['results.jsonl'],
        });
        expect(pipeline.files['events.jsonl']).toMatchObject({
            format: 'jsonl', status: 'empty', rows: [], text: files['events.jsonl'],
        });
        expect(pipeline.files['target-resolution.json']).toMatchObject({
            format: 'json', status: 'missing',
        });
    });

    it('retains ordered JSONL rows, source lines, and exact malformed diagnostics while skipping blanks', () => {
        const text = '\n{"sequence":1}\n  \n["compatible-later"]\ninvalid\nnull';
        const pipeline = parseDistributedArtifactPipeline({ 'events.jsonl': text });
        const file = pipeline.files['events.jsonl'];

        expect(file).toMatchObject({ format: 'jsonl', status: 'malformed', text });
        if (!file || file.format !== 'jsonl') {
            throw new Error('Expected parsed events.jsonl.');
        }
        expect(file.rows).toEqual([
            { lineNumber: 2, status: 'parsed', value: { sequence: 1 } },
            { lineNumber: 4, status: 'parsed', value: ['compatible-later'] },
            {
                lineNumber: 5,
                status: 'malformed',
                message: `events.jsonl:5 is not valid JSON: ${jsonParseError('invalid')}`,
            },
            { lineNumber: 6, status: 'parsed', value: null },
        ]);
    });

    it('detects and projects a raw bundle envelope without reparsing its JSON documents', () => {
        const envelopeFileName = 'artifact-envelope.json';
        const envelopeText = envelope('dist-envelope', {
            'distributed-run.json': '{"distributedRunId":"dist-envelope"}',
            'events.jsonl': '{"kind":"diagnostic"}\n',
            'invalid.json': { not: 'text' },
        });
        const pipeline = parseDistributedArtifactPipeline({
            [envelopeFileName]: envelopeText,
        });

        expect(pipeline.source).toBe('bundle-envelope');
        expect(pipeline.envelope).toMatchObject({
            fileName: envelopeFileName,
            format: 'json',
            status: 'parsed',
            text: envelopeText,
            value: {
                artifactSchemaVersion: 2,
                distributedRunId: 'dist-envelope',
                generatedAtEpochMs: 7,
            },
        });
        expect(pipeline.projectedFiles).toEqual({
            'distributed-run.json': '{"distributedRunId":"dist-envelope"}',
            'events.jsonl': '{"kind":"diagnostic"}\n',
        });
        expect(pipeline.projection).toMatchObject({
            source: 'bundle-envelope',
            envelopeFileName,
            artifactSchemaVersion: 2,
            generatedAtEpochMs: 7,
            distributedRunId: 'dist-envelope',
            invalidFiles: {
                'invalid.json': 'invalid.json must contain text in the artifact envelope.',
            },
            outerIgnoredFiles: [],
        });
        expect(pipeline.telemetry).toEqual({
            pipelinePassCount: 1,
            sourceCollectionPassCount: 1,
            sourceFileVisitCount: 3,
            jsonDocumentParseCount: 2,
            jsonDocumentParseCountByFile: {
                [envelopeFileName]: 1,
                'distributed-run.json': 1,
                'invalid.json': 0,
            },
            jsonlFilePassCount: 1,
            jsonlFilePassCountByFile: { 'events.jsonl': 1 },
            jsonlRowParseCount: 1,
            jsonlRowParseCountByFile: { 'events.jsonl': 1 },
        });
        expect(pipeline.files['invalid.json']).toMatchObject({
            format: 'json',
            status: 'malformed',
            message: 'invalid.json must contain text in the artifact envelope.',
        });
        expect(distributedArtifactPipelineFile(pipeline, 'results.jsonl')).toEqual({
            fileName: 'results.jsonl',
            format: 'jsonl',
            status: 'missing',
            rows: [],
        });
    });

    it('semantically matches envelope projection for escaped keys and reuses a single JSONL row parse', () => {
        const escapedEnvelopeText = envelope('dist-escaped', {
            'distributed-run.json': '{"distributedRunId":"dist-escaped"}',
        }).replace('"files"', '"f\\u0069les"');
        const escapedFiles = { 'artifact-envelope': escapedEnvelopeText };
        const escaped = parseDistributedArtifactPipeline(escapedFiles);

        expect(escaped.projection).toEqual(
            projectDistributedArtifactEnvelope(escapedFiles),
        );
        expect(escaped).toMatchObject({
            source: 'bundle-envelope',
            envelope: { fileName: 'artifact-envelope', text: escapedEnvelopeText },
        });

        const jsonlEnvelopeText = envelope('dist-jsonl', {
            'events.jsonl': '{"kind":"diagnostic"}\n',
        });
        const jsonl = parseDistributedArtifactPipeline({
            'artifact-envelope.jsonl': jsonlEnvelopeText,
        });
        expect(jsonl).toMatchObject({
            source: 'bundle-envelope',
            envelope: { fileName: 'artifact-envelope.jsonl', text: jsonlEnvelopeText },
        });
        expect(jsonl.telemetry).toMatchObject({
            jsonDocumentParseCount: 0,
            jsonlFilePassCount: 2,
            jsonlRowParseCount: 2,
            jsonlFilePassCountByFile: {
                'artifact-envelope.jsonl': 1,
                'events.jsonl': 1,
            },
            jsonlRowParseCountByFile: {
                'artifact-envelope.jsonl': 1,
                'events.jsonl': 1,
            },
        });
    });

    it('matches semantic projection for a pretty JSONL envelope without probing multiple JSONL records', () => {
        const prettyEnvelopeText = JSON.stringify({
            artifactSchemaVersion: 2,
            distributedRunId: 'dist-pretty-}-\\"-{',
            generatedAtEpochMs: 7,
            files: {
                'distributed-run.json': '{"note":"quoted \\\" } { braces"}',
            },
        }, null, 2);
        const prettyFiles = { 'artifact-envelope.jsonl': prettyEnvelopeText };
        const pretty = parseDistributedArtifactPipeline(prettyFiles);

        expect(pretty.projection).toEqual(
            projectDistributedArtifactEnvelope(prettyFiles),
        );
        expect(pretty).toMatchObject({
            source: 'bundle-envelope',
            envelope: {
                fileName: 'artifact-envelope.jsonl',
                text: prettyEnvelopeText,
            },
            telemetry: {
                jsonDocumentParseCount: 1,
                jsonlFilePassCountByFile: { 'artifact-envelope.jsonl': 1 },
                jsonlRowParseCountByFile: { 'artifact-envelope.jsonl': 1 },
            },
        });
        expect(pretty.telemetry.jsonDocumentParseCountByFile[
            'artifact-envelope.jsonl'
        ]).toBeUndefined();

        const twoRecords = `${envelope('dist-first', {})}\n${envelope('dist-second', {})}`;
        const multipleFiles = { 'not-an-envelope.jsonl': twoRecords };
        const multiple = parseDistributedArtifactPipeline(multipleFiles);
        expect(multiple.projection).toEqual(
            projectDistributedArtifactEnvelope(multipleFiles),
        );
        expect(multiple).toMatchObject({
            source: 'loose-files',
            telemetry: {
                jsonDocumentParseCount: 0,
                jsonlFilePassCount: 1,
                jsonlRowParseCount: 2,
                jsonlFilePassCountByFile: { 'not-an-envelope.jsonl': 1 },
                jsonlRowParseCountByFile: { 'not-an-envelope.jsonl': 2 },
            },
        });
    });

    it('preserves deterministic mixed, multiple, and invalid-envelope projection diagnostics', () => {
        const mixed = parseDistributedArtifactPipeline({
            'bundle.json': envelope('dist-mixed', {}),
            'loose.json': '{}',
        });
        expect(mixed.projection).toMatchObject({
            source: 'bundle-envelope',
            envelopeFileName: 'bundle.json',
            outerIgnoredFiles: ['loose.json'],
            fatalCode: 'ambiguous-envelope',
            fatalMessage: 'Artifact envelope bundle.json cannot be combined with loose files in one import.',
        });

        const multiple = parseDistributedArtifactPipeline({
            'z-envelope.json': envelope('dist-z', {}),
            'a-envelope.json': envelope('dist-a', {}),
        });
        expect(multiple.projection).toMatchObject({
            source: 'bundle-envelope',
            envelopeFileName: 'a-envelope.json',
            outerIgnoredFiles: ['z-envelope.json'],
            fatalCode: 'ambiguous-envelope',
            fatalMessage: 'Select exactly one artifact envelope; found a-envelope.json, z-envelope.json.',
        });

        const invalidText = JSON.stringify({
            artifactSchemaVersion: 2,
            distributedRunId: 'dist-invalid',
            generatedAtEpochMs: 7,
            files: [],
        });
        const invalid = parseDistributedArtifactPipeline({
            'invalid-envelope.json': invalidText,
        });
        expect(invalid.envelope).toMatchObject({ status: 'parsed', text: invalidText });
        expect(invalid.projectedFiles).toEqual({});
        expect(invalid.projection).toMatchObject({
            source: 'bundle-envelope',
            envelopeFileName: 'invalid-envelope.json',
            fatalCode: 'incompatible-file',
            fatalMessage: 'invalid-envelope.json is not a compatible artifact envelope: files must be an object of artifact filename to text.',
        });
    });

    it('classifies and caches a metadata-selected extensionless control response as JSON', () => {
        const responseText = '{ "error": "denied" }';
        const pipeline = parseDistributedArtifactPipeline({
            'control-post-error-metadata.json': JSON.stringify({
                responseFile: 'control-response',
            }),
            'control-response': responseText,
            'operator-notes.txt': 'canonical operator notes',
        });

        expect(pipeline.files['control-response']).toEqual({
            fileName: 'control-response',
            format: 'json',
            status: 'parsed',
            text: responseText,
            value: { error: 'denied' },
        });
        expect(pipeline.files['operator-notes.txt']).toEqual({
            fileName: 'operator-notes.txt',
            format: 'text',
            status: 'parsed',
            text: 'canonical operator notes',
            value: 'canonical operator notes',
        });
        expect(pipeline.telemetry.jsonDocumentParseCountByFile['control-response']).toBe(1);
        expect(pipeline.telemetry.jsonDocumentParseCountByFile['operator-notes.txt']).toBe(1);
        expect(pipeline.telemetry.jsonDocumentParseCount).toBe(3);
    });

    it('classifies a metadata-selected JSONL-named control response before discovery', () => {
        const responseFile = 'control-response.jsonl';
        const responseText = '{ "error": "denied" }';
        const pipeline = parseDistributedArtifactPipeline({
            'control-post-error-metadata.json': JSON.stringify({ responseFile }),
            [responseFile]: responseText,
        });

        expect(pipeline.files[responseFile]).toEqual({
            fileName: responseFile,
            format: 'json',
            status: 'parsed',
            text: responseText,
            value: { error: 'denied' },
        });
        expect(pipeline.telemetry.jsonDocumentParseCountByFile[responseFile]).toBe(1);
        expect(pipeline.telemetry.jsonlFilePassCountByFile[responseFile]).toBeUndefined();
        expect(pipeline.telemetry.jsonlRowParseCountByFile[responseFile]).toBeUndefined();
        expect(pipeline.telemetry).toMatchObject({
            jsonDocumentParseCount: 2,
            jsonlFilePassCount: 0,
            jsonlRowParseCount: 0,
        });
    });

    it('does not mistake a metadata-selected control response for an artifact envelope', () => {
        const responseFile = 'control-response.json';
        const responseText = JSON.stringify({
            artifactSchemaVersion: 2,
            distributedRunId: 'error-payload-run',
            generatedAtEpochMs: 7,
            files: {},
        });
        const pipeline = parseDistributedArtifactPipeline({
            'control-post-error-metadata.json': JSON.stringify({ responseFile }),
            [responseFile]: responseText,
        });

        expect(pipeline.source).toBe('loose-files');
        expect(pipeline.projection.fatalMessage).toBeUndefined();
        expect(pipeline.files[responseFile]).toMatchObject({
            format: 'json',
            status: 'parsed',
        });
    });

    it('uses null-prototype dictionaries and own-property lookup for hostile artifact names', () => {
        const files = Object.create(null) as Record<string, string>;
        Object.defineProperties(files, {
            'control-post-error-metadata.json': {
                enumerable: true,
                value: JSON.stringify({ responseFile: 'constructor' }),
            },
            constructor: { enumerable: true, value: '{"key":"constructor"}' },
            'toString.json': { enumerable: true, value: '{"key":"toString"}' },
            '__proto__.json': { enumerable: true, value: '{"key":"__proto__"}' },
        });

        const pipeline = parseDistributedArtifactPipeline(
            files satisfies DistributedRunArtifactFiles,
        );

        expect(Object.getPrototypeOf(pipeline.files)).toBeNull();
        expect(Object.getPrototypeOf(pipeline.projectedFiles)).toBeNull();
        expect(Object.getPrototypeOf(
            pipeline.telemetry.jsonDocumentParseCountByFile,
        )).toBeNull();
        expect(distributedArtifactPipelineFile(pipeline, 'constructor')).toMatchObject({
            format: 'json', status: 'parsed', value: { key: 'constructor' },
        });
        expect(distributedArtifactPipelineFile(pipeline, 'toString.json')).toMatchObject({
            format: 'json', status: 'parsed', value: { key: 'toString' },
        });
        expect(distributedArtifactPipelineFile(pipeline, '__proto__.json')).toMatchObject({
            format: 'json', status: 'parsed', value: { key: '__proto__' },
        });
        expect(distributedArtifactPipelineFile(pipeline, 'toString')).toEqual({
            fileName: 'toString', format: 'text', status: 'missing',
        });
    });
});
