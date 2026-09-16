import { describe, expect, it } from 'vitest';
import {
    analyzeDistributedRunArtifactFiles,
    distributedArtifactBundleFromFiles,
    type DistributedRunArtifactFiles
} from '../../../shared-test/rallar-bb-test/distributed-artifact-analysis.ts';

describe('distributed run artifact control request failures', () => {
    it('uses failed control POST artifacts as failure evidence', () => {
        const files: DistributedRunArtifactFiles = {
            'distributed-run.json': '',
            'runner-summary.json': JSON.stringify({
                distributedRunId: 'dist-post-failure',
                controlRunId: 'run-post-failure',
                state: 'failed',
                ok: false
            }),
            'manifest.json': JSON.stringify({
                schemaVersion: 1,
                distributedRunId: 'dist-post-failure',
                controlRunId: 'run-post-failure',
                group: {
                    applicationId: 'rallar-server',
                    workspaceId: 'default',
                    groupId: 'hetzner-headless-room'
                },
                recipes: []
            }),
            'control-run.json': JSON.stringify({
                runId: 'run-post-failure',
                agents: [],
                commands: [],
                results: [],
                events: [],
                stats: [],
                reports: [],
                heartbeats: []
            }),
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
                responseFile: 'control-post-create-error.json'
            })
        };

        const analysis = analyzeDistributedRunArtifactFiles({ files });
        const bundle = distributedArtifactBundleFromFiles(files, 123);

        expect(analysis.failure).toMatchObject({
            category: 'control-api',
            title: 'Control API create request failed.',
            likelyCause: 'target policy rejected',
            evidenceFile: 'control-post-create-error.json'
        });
        expect(analysis.failure?.nextAction).toContain('POST /distributed-runs returned HTTP 400');
        expect(analysis.fixProposalMarkdown).toContain('Evidence: control-post-create-error.json');
        expect(bundle?.files).toMatchObject({
            'control-post-create-error.json': JSON.stringify({
                error: 'bad manifest',
                message: 'target policy rejected'
            }),
            'control-post-error-metadata.json': expect.any(String)
        });
    });

    it('uses control POST metadata as failure evidence when no response body was saved', () => {
        const files: DistributedRunArtifactFiles = {
            'distributed-run.json': '',
            'runner-summary.json': JSON.stringify({
                distributedRunId: 'dist-post-network-failure',
                controlRunId: 'run-post-network-failure',
                state: 'failed',
                ok: false
            }),
            'manifest.json': JSON.stringify({
                schemaVersion: 1,
                distributedRunId: 'dist-post-network-failure',
                controlRunId: 'run-post-network-failure',
                group: {
                    applicationId: 'rallar-server',
                    workspaceId: 'default',
                    groupId: 'hetzner-headless-room'
                },
                recipes: []
            }),
            'control-run.json': JSON.stringify({
                runId: 'run-post-network-failure',
                agents: [],
                commands: [],
                results: [],
                events: [],
                stats: [],
                reports: [],
                heartbeats: []
            }),
            'control-post-error-metadata.json': JSON.stringify({
                phase: 'start',
                method: 'POST',
                path: '/distributed-runs/dist-post-network-failure/start',
                httpStatus: null,
                curlStatus: 7,
                exitStatus: 7,
                responseFile: null
            })
        };

        const analysis = analyzeDistributedRunArtifactFiles({ files });

        expect(analysis.failure).toMatchObject({
            category: 'control-api',
            title: 'Control API start request failed.',
            evidenceFile: 'control-post-error-metadata.json'
        });
        expect(analysis.failure?.likelyCause).toContain('curl 7');
        expect(analysis.failure?.likelyCause).toContain('exit 7');
        expect(analysis.failure?.nextAction).toContain('POST /distributed-runs/dist-post-network-failure/start');
        expect(analysis.fixProposalMarkdown).toContain('Evidence: control-post-error-metadata.json');
    });
});
