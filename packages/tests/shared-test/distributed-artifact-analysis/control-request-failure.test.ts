import { describe, expect, it } from 'vitest';

import {
    computeDistributedRunArtifactAnalysis,
    type DistributedRunArtifactFiles,
    type DistributedRunControlRequestFailureAnalysis
} from '../../../shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import {
    createControlRunSnapshot,
    createDistributedRunManifest,
    createDistributedRunSnapshot,
    toDistributedRunArtifactFiles
} from './distributed-artifact-files-fixture.ts';

const GENERATED_AT_EPOCH_MS = 123;

const BAD_GATEWAY_BODY = '<html><head><title>502 Bad Gateway</title></head><body>upstream unavailable</body></html>';

function controlRequestFailure(files: DistributedRunArtifactFiles): DistributedRunControlRequestFailureAnalysis {
    const analyzed = computeDistributedRunArtifactAnalysis({ files, generatedAtEpochMs: GENERATED_AT_EPOCH_MS });
    if (analyzed.right?.variant !== 'control-request-failure') {
        throw new Error(`Expected a control request failure analysis, got ${JSON.stringify(analyzed.left ?? analyzed.right)}`);
    }
    return analyzed.right.analysis;
}

function failedCreateRecord(httpStatus: string | null, responseFile: string | null): string {
    return JSON.stringify({
        phase: 'create',
        method: 'POST',
        path: '/distributed-runs',
        httpStatus,
        curlStatus: 0,
        exitStatus: 22,
        responseFile,
        atEpochSeconds: 1_700_000_000
    });
}

function failedCreateFiles(files: DistributedRunArtifactFiles): DistributedRunArtifactFiles {
    return {
        'manifest.json': JSON.stringify(createDistributedRunManifest({
            distributedRunId: 'dist-post-failure',
            controlRunId: 'run-post-failure',
            agentIds: ['controller-01']
        })),
        'runner-summary.json': JSON.stringify({
            distributedRunId: 'dist-post-failure',
            controlRunId: 'run-post-failure',
            state: 'failed',
            ok: false,
            artifactDir: '/artifacts/dist-post-failure'
        }),
        ...files
    };
}

describe('distributed run artifact control request failures', () => {
    it('analyzes a failed create request with its response body as a control request failure', () => {
        const analysis = controlRequestFailure(failedCreateFiles({
            'control-post-create-error.json': JSON.stringify({
                error: 'bad manifest',
                message: 'target policy rejected'
            }),
            'control-post-error-metadata.json': JSON.stringify({
                phase: 'create',
                method: 'POST',
                path: '/distributed-runs',
                httpStatus: '400',
                curlStatus: 0,
                exitStatus: 22,
                responseFile: 'control-post-create-error.json',
                atEpochSeconds: 1_700_000_000
            })
        }));

        expect(analysis).toMatchObject({
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
            runnerSummary: {
                distributedRunId: 'dist-post-failure',
                controlRunId: 'run-post-failure',
                state: 'failed'
            },
            ok: false,
            request: {
                phase: 'create',
                method: 'POST',
                path: '/distributed-runs',
                httpStatus: '400',
                exitStatus: 22,
                responseFile: 'control-post-create-error.json'
            },
            responseBody: '{"error":"bad manifest","message":"target policy rejected"}',
            parseWarnings: [],
            failure: {
                category: 'control-api',
                title: 'Control API create request failed.',
                likelyCause: 'target policy rejected',
                evidenceFile: 'control-post-create-error.json'
            }
        });
        expect(analysis.failure.nextAction).toContain('POST /distributed-runs returned HTTP 400');
        expect(Object.keys(analysis)).not.toEqual(expect.arrayContaining(['performance']));
        expect(Object.keys(analysis)).not.toEqual(expect.arrayContaining(['spa']));
        expect(analysis.summaryMarkdown).toContain('# Control Request Failure: dist-post-failure');
        expect(analysis.summaryMarkdown).toContain('Request: POST /distributed-runs (create)');
        expect(analysis.summaryMarkdown).toContain('Error: target policy rejected');
        expect(analysis.summaryMarkdown).toContain(
            'Response body excerpt:\n\n```text\n{"error":"bad manifest","message":"target policy rejected"}\n```'
        );
        expect(analysis.fixProposalMarkdown).toContain('Evidence: control-post-create-error.json');
    });

    it('tells a response body that is not JSON apart from a missing one and shows its excerpt', () => {
        const analysis = controlRequestFailure(failedCreateFiles({
            'control-post-create-error.json': BAD_GATEWAY_BODY,
            'control-post-error-metadata.json': failedCreateRecord('502', 'control-post-create-error.json')
        }));

        expect(analysis.responseBody).toBe(BAD_GATEWAY_BODY);
        expect(analysis.parseWarnings).toEqual([]);
        expect(analysis.failure.likelyCause).toBe(
            'Control API request failed with a response body that is not JSON (HTTP 502, curl 0, exit 22).'
        );
        for (const markdown of [analysis.summaryMarkdown, analysis.fixProposalMarkdown]) {
            expect(markdown).not.toContain('without a response body');
            expect(markdown).toContain(`Response body excerpt:\n\n\`\`\`text\n${BAD_GATEWAY_BODY}\n\`\`\``);
        }
        expect(analysis.summaryMarkdown).toContain('Response body: control-post-create-error.json');
    });

    it('bounds the response body excerpt and keeps a fence the body cannot close', () => {
        const body = `\`\`\`\n${'x'.repeat(4_996)}`;
        const analysis = controlRequestFailure(failedCreateFiles({
            'control-post-create-error.json': body,
            'control-post-error-metadata.json': failedCreateRecord('500', 'control-post-create-error.json')
        }));

        expect(analysis.summaryMarkdown).toContain(
            `Response body excerpt (first 500 of 5000 characters):\n\n\`\`\`\`text\n${body.slice(0, 500)}\n\`\`\`\``
        );
        expect(analysis.summaryMarkdown).not.toContain(body.slice(0, 501));
        expect(analysis.fixProposalMarkdown).toContain('Response body excerpt (first 500 of 5000 characters):');
    });

    it('does not invent an error message for a JSON response body that names none', () => {
        const analysis = controlRequestFailure(failedCreateFiles({
            'control-post-create-error.json': JSON.stringify({ status: 'rejected' }),
            'control-post-error-metadata.json': failedCreateRecord('400', 'control-post-create-error.json')
        }));

        expect(analysis.failure.likelyCause).toBe(
            'Control API request failed; its JSON response body names no error message (HTTP 400, curl 0, exit 22).'
        );
        expect(analysis.summaryMarkdown).toContain('Response body excerpt:\n\n```text\n{"status":"rejected"}\n```');
    });

    it('reports a recorded response body whose file the artifacts do not hold', () => {
        const analysis = controlRequestFailure(failedCreateFiles({
            'control-post-error-metadata.json': failedCreateRecord('400', 'control-post-create-error.json')
        }));

        expect(analysis.parseWarnings).toEqual([{
            fileName: 'control-post-create-error.json',
            message: 'control-post-create-error.json is named by control-post-error-metadata.json but is not among the artifact files.'
        }]);
        expect(analysis.failure.likelyCause).toBe(
            'Control API request failed; its response body control-post-create-error.json is not among the artifact files (HTTP 400, curl 0, exit 22).'
        );
        expect(analysis.summaryMarkdown).toContain(
            'Response body: control-post-create-error.json (not among the artifact files)'
        );
    });

    it('names the run from manifest.json when the runner stopped before writing its summary', () => {
        const { 'runner-summary.json': _runnerSummary, ...filesWithoutRunnerSummary } = failedCreateFiles({
            'control-post-error-metadata.json': failedCreateRecord(null, null)
        });
        const analysis = controlRequestFailure(filesWithoutRunnerSummary);

        expect(analysis.runnerSummary).toBeUndefined();
        expect(analysis.distributedRunId).toBe('dist-post-failure');
        expect(analysis.summaryMarkdown).toContain('# Control Request Failure: dist-post-failure');
        expect(analysis.fixProposalMarkdown).toContain('# Fix Proposal: dist-post-failure');
    });

    it('uses the request record as evidence when the failed create returned no response body', () => {
        const analysis = controlRequestFailure(failedCreateFiles({
            'control-post-error-metadata.json': JSON.stringify({
                phase: 'create',
                method: 'POST',
                path: '/distributed-runs',
                httpStatus: null,
                curlStatus: 7,
                exitStatus: 7,
                responseFile: null,
                atEpochSeconds: 1_700_000_000
            })
        }));

        expect(analysis.failure).toMatchObject({
            category: 'control-api',
            title: 'Control API create request failed.',
            likelyCause: 'Control API request failed without a response body (curl 7, exit 7).',
            evidenceFile: 'control-post-error-metadata.json'
        });
        expect(analysis.failure.nextAction).toContain('POST /distributed-runs returned a failure');
        expect(analysis.fixProposalMarkdown).toContain('Evidence: control-post-error-metadata.json');
    });

    it('keeps a failed start request as the failure focus of a distributed run analysis', () => {
        const analyzed = computeDistributedRunArtifactAnalysis({
            files: toDistributedRunArtifactFiles({
                distributedRun: createDistributedRunSnapshot({
                    distributedRunId: 'dist-post-start-failure',
                    controlRunId: 'run-post-start-failure',
                    state: 'failed',
                    agentIds: ['controller-01']
                }),
                controlRun: createControlRunSnapshot({ runId: 'run-post-start-failure' }),
                files: {
                    'control-post-error-metadata.json': JSON.stringify({
                        phase: 'start',
                        method: 'POST',
                        path: '/distributed-runs/dist-post-start-failure/start',
                        httpStatus: null,
                        curlStatus: 7,
                        exitStatus: 7,
                        responseFile: null,
                        atEpochSeconds: 1_700_000_000
                    })
                }
            }),
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS
        });

        const analysis = analyzed.right?.analysis;
        if (analyzed.right?.variant !== 'distributed-run' || analysis?.ok !== false) {
            throw new Error(`Expected a failed distributed run analysis, got ${JSON.stringify(analyzed.left ?? analyzed.right)}`);
        }
        expect(analysis.failure).toMatchObject({
            category: 'control-api',
            title: 'Control API start request failed.',
            evidenceFile: 'control-post-error-metadata.json'
        });
        expect(analysis.failure.likelyCause).toContain('curl 7');
        expect(analysis.failure.nextAction).toContain('POST /distributed-runs/dist-post-start-failure/start');
    });

    it('rejects a control request record that omits a field the runner always writes', () => {
        const analyzed = computeDistributedRunArtifactAnalysis({
            files: failedCreateFiles({
                'control-post-error-metadata.json': JSON.stringify({
                    phase: 'create',
                    method: 'POST',
                    path: '/distributed-runs',
                    httpStatus: '400',
                    curlStatus: 0,
                    exitStatus: 22,
                    responseFile: null
                })
            }),
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS
        });

        expect(analyzed.left).toEqual({
            fileName: 'control-post-error-metadata.json',
            message: 'control-post-error-metadata.json is not a control request record: atEpochSeconds must be a finite number.'
        });
    });
});
