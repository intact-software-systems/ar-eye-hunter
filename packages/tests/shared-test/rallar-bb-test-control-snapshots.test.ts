import { describe, expect, it } from 'vitest';
import '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';

describe('rallar-bb-test control snapshot contracts', () => {
    it('models control and distributed artifact snapshots used by the SPA and control server', () => {
        const run = {
            runId: 'run-1',
            createdAtEpochMs: 1,
            updatedAtEpochMs: 2,
            agents: [],
            commands: [],
            results: [],
            events: [],
            stats: [],
            reports: [],
            heartbeats: [],
        } satisfies ControlRunSnapshot;

        const distributedRun = {
            distributedRunId: 'dist-1',
            controlRunId: 'run-1',
            manifest: {
                distributedRunId: 'dist-1',
                group: {
                    applicationId: 'rallar-server',
                    workspaceId: 'default',
                    groupId: 'room-1',
                },
                recipes: [],
                targetPolicy: {
                    mode: 'selected-agents',
                    agentIds: [],
                },
            },
            state: 'draft',
            createdAtEpochMs: 1,
            updatedAtEpochMs: 2,
            targetAgentIds: [],
            commandLinks: [],
            rollup: {
                state: 'draft',
                ok: false,
                summary: {
                    targeted: 0,
                    acknowledged: 0,
                    ready: 0,
                    running: 0,
                    passed: 0,
                    failed: 0,
                    cancelled: 0,
                    timedOut: 0,
                    disconnected: 0,
                    blockingFailures: 0,
                },
                participants: [],
                recipes: [],
                failures: [],
            },
        } satisfies ControlDistributedRunSnapshot;

        const artifact = {
            artifactSchemaVersion: 2,
            distributedRunId: 'dist-1',
            generatedAtEpochMs: 3,
            files: {
                'distributed-run.json': JSON.stringify(distributedRun),
                'manifest.json': JSON.stringify(distributedRun.manifest),
                'control-run.json': JSON.stringify(run),
                'report.json': '{}',
                'results.jsonl': '',
                'events.jsonl': '',
                'failures.json': '{}',
                'metadata.json': '{}',
            },
        } satisfies ControlDistributedRunArtifactBundle;

        expect(artifact.distributedRunId).toBe('dist-1');
    });
});
