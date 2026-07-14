import { describe, expect, it, vi } from 'vitest';
import {
    ANALYZE_ARTIFACT_AUTHORITATIVE_BASENAMES,
    ANALYZE_ARTIFACT_MAX_FILE_BYTES,
    ANALYZE_ARTIFACT_MAX_FILE_COUNT,
    ANALYZE_ARTIFACT_MAX_TOTAL_BYTES,
    AnalyzeFileIntakeError,
    readAnalyzeArtifactFiles,
    readAnalyzeArtifactTransferFiles,
    type AnalyzeFileLike,
    type AnalyzeTransferFileLike,
} from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-file-boundary.ts';

const utf8 = new TextEncoder();

function file(
    name: string,
    contents = '{}',
    options: Readonly<{
        size?: number;
        type?: string;
        webkitRelativePath?: string;
        read?: () => Promise<string>;
    }> = {},
): AnalyzeFileLike {
    return {
        name,
        size: options.size ?? utf8.encode(contents).byteLength,
        ...(options.type === undefined ? {} : { type: options.type }),
        ...(options.webkitRelativePath === undefined
            ? {}
            : { webkitRelativePath: options.webkitRelativePath }),
        text: options.read ?? (async () => contents),
    };
}

function bufferFromText(contents: string): ArrayBuffer {
    const bytes = utf8.encode(contents);
    return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
}

function transferFile(
    name: string,
    contents = '{}',
    options: Readonly<{
        size?: number;
        type?: string;
        webkitRelativePath?: string;
        read?: () => Promise<ArrayBuffer>;
    }> = {},
): AnalyzeTransferFileLike {
    const bytes = bufferFromText(contents);
    return {
        name,
        size: options.size ?? bytes.byteLength,
        ...(options.type === undefined ? {} : { type: options.type }),
        ...(options.webkitRelativePath === undefined
            ? {}
            : { webkitRelativePath: options.webkitRelativePath }),
        arrayBuffer: options.read ?? (async () => bytes),
    };
}

async function expectIntakeError(
    promise: Promise<unknown>,
    code: AnalyzeFileIntakeError['code'],
    message: string | RegExp,
) {
    const error = await promise.catch(reason => reason);
    expect(error).toBeInstanceOf(AnalyzeFileIntakeError);
    expect(error).toMatchObject({ code });
    if (typeof message === 'string') {
        expect(error.message).toBe(message);
    } else {
        expect(error.message).toMatch(message);
    }
}

describe('Recipe Console Analyze file boundary', () => {
    it('exports the binding intake bounds and authoritative loose-file basenames', () => {
        expect(ANALYZE_ARTIFACT_MAX_FILE_COUNT).toBe(24);
        expect(ANALYZE_ARTIFACT_MAX_FILE_BYTES).toBe(16 * 1024 * 1024);
        expect(ANALYZE_ARTIFACT_MAX_TOTAL_BYTES).toBe(48 * 1024 * 1024);
        expect(ANALYZE_ARTIFACT_AUTHORITATIVE_BASENAMES).toEqual([
            'distributed-run.json',
            'manifest.json',
            'target-resolution.json',
            'runner-summary.json',
            'control-post-create-error.json',
            'control-post-stage-error.json',
            'control-post-start-error.json',
            'control-post-request-error.json',
            'control-post-error-metadata.json',
            'control-run.json',
            'fleet-report.json',
            'report.json',
            'results.jsonl',
            'events.jsonl',
            'failures.json',
            'metadata.json',
        ]);
    });

    it('reads JSON and JSONL by safe basename and returns deterministic texts and metadata', async () => {
        const intake = await readAnalyzeArtifactFiles([
            file('dist-42-artifact.json', '{"files":{}}', {
                type: 'application/octet-stream',
                webkitRelativePath: 'downloads/dist-42-artifact.json',
            }),
            file('events.jsonl', '{"kind":"diagnostic"}\n', {
                type: 'text/plain',
                webkitRelativePath: 'ci/nested/events.jsonl',
            }),
            file('manifest.json', '{"distributedRunId":"dist-42"}', {
                type: 'application/json',
                webkitRelativePath: 'ci/manifest.json',
            }),
        ]);

        expect(Object.keys(intake.files)).toEqual([
            'dist-42-artifact.json',
            'events.jsonl',
            'manifest.json',
        ]);
        expect(intake.files).toEqual({
            'dist-42-artifact.json': '{"files":{}}',
            'events.jsonl': '{"kind":"diagnostic"}\n',
            'manifest.json': '{"distributedRunId":"dist-42"}',
        });
        expect(intake.acceptedFiles).toEqual([
            {
                basename: 'dist-42-artifact.json',
                sourcePath: 'downloads/dist-42-artifact.json',
                sizeBytes: 12,
                type: 'application/octet-stream',
                kind: 'envelope-candidate',
            },
            {
                basename: 'events.jsonl',
                sourcePath: 'ci/nested/events.jsonl',
                sizeBytes: 22,
                type: 'text/plain',
                kind: 'authoritative',
            },
            {
                basename: 'manifest.json',
                sourcePath: 'ci/manifest.json',
                sizeBytes: 30,
                type: 'application/json',
                kind: 'authoritative',
            },
        ]);
        expect(intake.ignoredFiles).toEqual([]);
        expect(intake.totalSelectedBytes).toBe(64);
    });

    it('reads sorted transfer-safe buffers without decoding artifact text on the main thread', async () => {
        vi.stubGlobal('TextDecoder', class ForbiddenTextDecoder {
            constructor() {
                throw new Error('artifact bytes must be decoded in the worker');
            }
        });

        try {
            const intake = await readAnalyzeArtifactTransferFiles([
                transferFile('manifest.json', '{"distributedRunId":"dist-42"}', {
                    type: 'application/json',
                    webkitRelativePath: 'ci/manifest.json',
                }),
                transferFile('dist-42-artifact.json', '{"files":{}}', {
                    type: 'application/octet-stream',
                    webkitRelativePath: 'downloads/dist-42-artifact.json',
                }),
            ]);

            expect(intake.files.map(file => file.name)).toEqual([
                'dist-42-artifact.json',
                'manifest.json',
            ]);
            expect([...new Uint8Array(intake.files[0].bytes)]).toEqual([
                ...utf8.encode('{"files":{}}'),
            ]);
            expect(intake.acceptedFiles).toEqual([
                {
                    basename: 'dist-42-artifact.json',
                    sourcePath: 'downloads/dist-42-artifact.json',
                    sizeBytes: 12,
                    type: 'application/octet-stream',
                    kind: 'envelope-candidate',
                },
                {
                    basename: 'manifest.json',
                    sourcePath: 'ci/manifest.json',
                    sizeBytes: 30,
                    type: 'application/json',
                    kind: 'authoritative',
                },
            ]);
            expect(intake.ignoredFiles).toEqual([]);
            expect(intake.totalSelectedBytes).toBe(42);
            expect(intake.transferList).toEqual(intake.files.map(file => file.bytes));

            const cloned = structuredClone(intake.files, {
                transfer: [...intake.transferList],
            });
            expect(cloned.map(file => [file.name, file.bytes.byteLength])).toEqual([
                ['dist-42-artifact.json', 12],
                ['manifest.json', 30],
            ]);
            expect(intake.transferList.map(bytes => bytes.byteLength)).toEqual([0, 0]);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('rejects declared and actual byte mismatches without returning partial buffers', async () => {
        await expectIntakeError(
            readAnalyzeArtifactTransferFiles([
                transferFile('manifest.json', '{}', {
                    size: 2,
                    read: async () => bufferFromText('{}\n'),
                }),
            ]),
            'file-size-mismatch',
            'File "manifest.json" reported 2 bytes but returned 3 bytes. No files were imported.',
        );
    });

    it('enforces the per-file limit against actual transferable bytes', async () => {
        const oversized = new ArrayBuffer(ANALYZE_ARTIFACT_MAX_FILE_BYTES + 1);

        await expectIntakeError(
            readAnalyzeArtifactTransferFiles([
                transferFile('events.jsonl', '', {
                    size: 0,
                    read: async () => oversized,
                }),
            ]),
            'file-too-large',
            `File "events.jsonl" exceeds the ${ANALYZE_ARTIFACT_MAX_FILE_BYTES}-byte limit (${ANALYZE_ARTIFACT_MAX_FILE_BYTES + 1} bytes).`,
        );
    });

    it('enforces the aggregate limit against actual transferable bytes', async () => {
        const quarter = ANALYZE_ARTIFACT_MAX_TOTAL_BYTES / 4;
        const exactQuarters = Array.from({ length: 3 }, () => new ArrayBuffer(quarter));
        const oversizedQuarter = new ArrayBuffer(quarter + 1);

        await expectIntakeError(
            readAnalyzeArtifactTransferFiles([
                transferFile('artifact-a.json', '', { size: quarter, read: async () => exactQuarters[0] }),
                transferFile('artifact-b.json', '', { size: quarter, read: async () => exactQuarters[1] }),
                transferFile('artifact-c.json', '', { size: quarter, read: async () => exactQuarters[2] }),
                transferFile('artifact-d.json', '', { size: quarter, read: async () => oversizedQuarter }),
            ]),
            'total-too-large',
            `Selected files exceed the ${ANALYZE_ARTIFACT_MAX_TOTAL_BYTES}-byte total limit (${ANALYZE_ARTIFACT_MAX_TOTAL_BYTES + 1} bytes).`,
        );
    });

    it('uses the same count, declared-byte, duplicate, and hostile-name rejections for transfer intake', async () => {
        let readCount = 0;
        const read = async () => {
            readCount += 1;
            return bufferFromText('{}');
        };
        const cases = [
            {
                files: Array.from({ length: ANALYZE_ARTIFACT_MAX_FILE_COUNT + 1 }, (_, index) =>
                    transferFile(`artifact-${index}.json`, '{}', { read })),
                code: 'too-many-files' as const,
                message: 'Select at most 24 files; received 25.',
            },
            {
                files: [transferFile('manifest.json', '{}', {
                    size: ANALYZE_ARTIFACT_MAX_FILE_BYTES + 1,
                    read,
                })],
                code: 'file-too-large' as const,
                message: `File "manifest.json" exceeds the ${ANALYZE_ARTIFACT_MAX_FILE_BYTES}-byte limit (${ANALYZE_ARTIFACT_MAX_FILE_BYTES + 1} bytes).`,
            },
            {
                files: [
                    transferFile('manifest.json', '{}', {
                        webkitRelativePath: 'first/manifest.json',
                        read,
                    }),
                    transferFile('manifest.json', '{}', {
                        webkitRelativePath: 'second/manifest.json',
                        read,
                    }),
                ],
                code: 'duplicate-basename' as const,
                message: 'Duplicate artifact basename "manifest.json" was selected from "first/manifest.json" and "second/manifest.json". Remove one; files are never overwritten.',
            },
            {
                files: [transferFile('../manifest.json', '{}', { read })],
                code: 'unsafe-path' as const,
                message: 'File path "../manifest.json" is unsafe: traversal segments are not allowed.',
            },
        ];

        for (const intakeCase of cases) {
            await expectIntakeError(
                readAnalyzeArtifactTransferFiles(intakeCase.files),
                intakeCase.code,
                intakeCase.message,
            );
        }
        expect(readCount).toBe(0);
    });

    it('retains deterministic ignored-filename diagnostics and never reads ignored content', async () => {
        let ignoredRead = false;
        const intake = await readAnalyzeArtifactFiles([
            file('manifest.json', '{}'),
            file('notes.txt', 'not an artifact', {
                webkitRelativePath: 'ci/notes.txt',
                read: async () => {
                    ignoredRead = true;
                    throw new Error('ignored files must not be read');
                },
            }),
            file('screenshot.png', 'binary', { webkitRelativePath: 'ci/screenshot.png' }),
        ]);

        expect(ignoredRead).toBe(false);
        expect(intake.ignoredFiles).toEqual([
            {
                basename: 'notes.txt',
                sourcePath: 'ci/notes.txt',
                reason: 'unsupported-extension',
            },
            {
                basename: 'screenshot.png',
                sourcePath: 'ci/screenshot.png',
                reason: 'unsupported-extension',
            },
        ]);
    });

    it('preserves a sole arbitrary JSON export for shared envelope detection', async () => {
        const intake = await readAnalyzeArtifactFiles([
            file('dist-42-artifact.json', '{"artifactSchemaVersion":2,"files":{}}'),
        ]);

        expect(intake.files).toEqual({
            'dist-42-artifact.json': '{"artifactSchemaVersion":2,"files":{}}',
        });
        expect(intake.acceptedFiles).toMatchObject([
            { basename: 'dist-42-artifact.json', kind: 'envelope-candidate' },
        ]);
    });

    it('rejects a selection with no JSON or JSONL candidate and names every ignored file', async () => {
        await expectIntakeError(
            readAnalyzeArtifactFiles([
                file('notes.txt'),
                file('trace.log'),
            ]),
            'no-json-files',
            'No JSON or JSONL artifact files were selected. Ignored: notes.txt, trace.log.',
        );
    });

    it('rejects more than 24 selected files before reading any of them', async () => {
        let readCount = 0;
        const files = Array.from({ length: ANALYZE_ARTIFACT_MAX_FILE_COUNT + 1 }, (_, index) =>
            file(`artifact-${String(index).padStart(2, '0')}.json`, '{}', {
                read: async () => {
                    readCount += 1;
                    return '{}';
                },
            }));

        await expectIntakeError(
            readAnalyzeArtifactFiles(files),
            'too-many-files',
            'Select at most 24 files; received 25.',
        );
        expect(readCount).toBe(0);
    });

    it('rejects a selected file over 16 MiB before reading it', async () => {
        let readCount = 0;

        await expectIntakeError(
            readAnalyzeArtifactFiles([
                file('events.jsonl', '', {
                    size: ANALYZE_ARTIFACT_MAX_FILE_BYTES + 1,
                    read: async () => {
                        readCount += 1;
                        return '';
                    },
                }),
            ]),
            'file-too-large',
            `File "events.jsonl" exceeds the ${ANALYZE_ARTIFACT_MAX_FILE_BYTES}-byte limit (${ANALYZE_ARTIFACT_MAX_FILE_BYTES + 1} bytes).`,
        );
        expect(readCount).toBe(0);
    });

    it('rejects selections over 48 MiB in total, including ignored files', async () => {
        const quarter = ANALYZE_ARTIFACT_MAX_TOTAL_BYTES / 4;

        await expectIntakeError(
            readAnalyzeArtifactFiles([
                file('manifest.json', '', { size: quarter }),
                file('events.jsonl', '', { size: quarter }),
                file('notes.txt', '', { size: quarter }),
                file('trace.log', '', { size: quarter + 1 }),
            ]),
            'total-too-large',
            `Selected files exceed the ${ANALYZE_ARTIFACT_MAX_TOTAL_BYTES}-byte total limit (${ANALYZE_ARTIFACT_MAX_TOTAL_BYTES + 1} bytes).`,
        );
    });

    it('rejects invalid declared sizes rather than weakening byte bounds', async () => {
        await expectIntakeError(
            readAnalyzeArtifactFiles([file('manifest.json', '{}', { size: Number.NaN })]),
            'invalid-file-size',
            'File "manifest.json" reports an invalid size.',
        );
    });

    it.each([
        '../manifest.json',
        '/tmp/manifest.json',
        'ci/./manifest.json',
        'ci/%2e%2e/manifest.json',
        'C:\\temp\\manifest.json',
        'ci/manifest.json\u0000',
        'ci/ manifest.json',
    ])('rejects the unsafe or suspicious selected path %j', async sourcePath => {
        await expectIntakeError(
            readAnalyzeArtifactFiles([file(sourcePath)]),
            'unsafe-path',
            /is unsafe:/,
        );
    });

    it('rejects a suspicious webkitRelativePath even when File.name is safe', async () => {
        await expectIntakeError(
            readAnalyzeArtifactFiles([
                file('manifest.json', '{}', { webkitRelativePath: '../manifest.json' }),
            ]),
            'unsafe-path',
            /\.\.\/manifest\.json.*is unsafe:/,
        );
    });

    it('rejects duplicate JSON basenames from distinct directories without reading or overwriting', async () => {
        let readCount = 0;
        const read = async () => {
            readCount += 1;
            return '{}';
        };

        await expectIntakeError(
            readAnalyzeArtifactFiles([
                file('manifest.json', '{}', {
                    webkitRelativePath: 'first/manifest.json',
                    read,
                }),
                file('manifest.json', '{}', {
                    webkitRelativePath: 'second/manifest.json',
                    read,
                }),
            ]),
            'duplicate-basename',
            'Duplicate artifact basename "manifest.json" was selected from "first/manifest.json" and "second/manifest.json". Remove one; files are never overwritten.',
        );
        expect(readCount).toBe(0);
    });

    it('rejects case-insensitive duplicate JSON basenames to stay deterministic across filesystems', async () => {
        await expectIntakeError(
            readAnalyzeArtifactFiles([
                file('Run-Artifact.json'),
                file('run-artifact.JSON'),
            ]),
            'duplicate-basename',
            /Duplicate artifact basename "run-artifact\.json"/,
        );
    });

    it('reports a deterministic read failure without returning a partial intake', async () => {
        await expectIntakeError(
            readAnalyzeArtifactFiles([
                file('manifest.json', '{}'),
                file('events.jsonl', '', {
                    read: async () => {
                        throw new Error('disk unavailable');
                    },
                }),
            ]),
            'read-failed',
            'Could not read "events.jsonl": disk unavailable. No files were imported.',
        );
    });
});
