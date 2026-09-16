import { describe, expect, it } from 'vitest';

import {
    analyzeDistributedRunArtifactFiles,
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

function controlRequestFailure(files: DistributedRunArtifactFiles): DistributedRunControlRequestFailureAnalysis {
    const analyzed = analyzeDistributedRunArtifactFiles({ files, generatedAtEpochMs: GENERATED_AT_EPOCH_MS });
    if (analyzed.right?.variant !== 'control-request-failure') {
        throw new Error(`Expected a control request failure analysis, got ${JSON.stringify(analyzed.left ?? analyzed.right)}`);
    }
    return analyzed.right.analysis;
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
        expect(analysis.fixProposalMarkdown).toContain('Evidence: control-post-create-error.json');
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
        const analyzed = analyzeDistributedRunArtifactFiles({
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

        expect(analyzed.right?.variant).toBe('distributed-run');
        expect(analyzed.right?.analysis.failure).toMatchObject({
            category: 'control-api',
            title: 'Control API start request failed.',
            evidenceFile: 'control-post-error-metadata.json'
        });
        expect(analyzed.right?.analysis.failure?.likelyCause).toContain('curl 7');
        expect(analyzed.right?.analysis.failure?.nextAction).toContain(
            'POST /distributed-runs/dist-post-start-failure/start'
        );
    });

    it('rejects a control request record that omits a field the runner always writes', () => {
        const analyzed = analyzeDistributedRunArtifactFiles({
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
