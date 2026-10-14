import {
    describe,
    expect,
    it
} from 'vitest';

import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot,
    ControlRunArtifactBundle,
    ControlRunSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    decodeControlDistributedRunArtifactBundle,
    decodeControlRunArtifactBundle
} from '@shared-test/rallar-bb-test/schema/control-artifact-envelope.ts';

const ordinaryArtifact = {
    artifactSchemaVersion: 1,
    runId: 'ordinary-run',
    generatedAtEpochMs: 3,
    files: {
        'report.json': '{}',
        'results.jsonl': '',
        'events.jsonl': '',
        'failures.json': '{}',
        'metadata.json': '{}'
    }
} satisfies ControlRunArtifactBundle;

const distributedArtifact = {
    artifactSchemaVersion: 2,
    distributedRunId: 'distributed-run',
    generatedAtEpochMs: 3,
    files: {
        'distributed-run.json': '',
        'manifest.json': '',
        'control-run.json': ''
    }
} satisfies ControlDistributedRunArtifactBundle;

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
            heartbeats: []
        } satisfies ControlRunSnapshot;

        const distributedRun = {
            distributedRunId: 'dist-1',
            controlRunId: 'run-1',
            manifest: {
                distributedRunId: 'dist-1',
                group: {
                    applicationId: 'rallar-server',
                    workspaceId: 'default',
                    groupId: 'room-1'
                },
                recipes: [],
                targetPolicy: {
                    mode: 'selected-agents',
                    agentIds: []
                },
                schemaVersion: 1,
                controlRunId: 'dist-1',
                variables: {},
                roleAssignments: [],
                ackTimeoutMs: 30_000,
                barrier: { enabled: false },
                startMode: 'manual',
                groupAssertions: [],
                metadata: {}
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
                    participants: 0,
                    readyParticipants: 0,
                    passedParticipants: 0,
                    failedParticipants: 0,
                    recipes: 0,
                    passedRecipes: 0,
                    failedRecipes: 0,
                    groupAssertions: 0,
                    passedGroupAssertions: 0,
                    failedGroupAssertions: 0,
                    blockingFailures: 0
                },
                groupAssertions: [],
                failures: []
            }
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
                'metadata.json': '{}'
            }
        } satisfies ControlDistributedRunArtifactBundle;

        expect(artifact.distributedRunId).toBe('dist-1');
    });
});

describe('ordinary control artifact boundary', () => {
    it('accepts all mandatory files, including empty JSONL, without imposing a schema-version policy', () => {
        for (const artifactSchemaVersion of [1, 9]) {
            const value = { ...ordinaryArtifact, artifactSchemaVersion };
            expect(decodeControlRunArtifactBundle(value).right).toEqual(value);
        }
    });

    it.each([
        { field: 'artifact', value: null },
        { field: 'artifact', value: [] },
        { field: 'artifactSchemaVersion', value: { ...ordinaryArtifact, artifactSchemaVersion: '1' } },
        { field: 'artifactSchemaVersion', value: { ...ordinaryArtifact, artifactSchemaVersion: Infinity } },
        { field: 'runId', value: { ...ordinaryArtifact, runId: '' } },
        { field: 'runId', value: { ...ordinaryArtifact, runId: 1 } },
        { field: 'generatedAtEpochMs', value: { ...ordinaryArtifact, generatedAtEpochMs: undefined } },
        { field: 'generatedAtEpochMs', value: { ...ordinaryArtifact, generatedAtEpochMs: NaN } },
        { field: 'files', value: { ...ordinaryArtifact, files: [] } },
        { field: 'files', value: { ...ordinaryArtifact, files: null } }
    ])('rejects invalid mandatory $field input', ({ field, value }) => {
        const decoded = decodeControlRunArtifactBundle(value);
        expect(decoded.right).toBeUndefined();
        expect(decoded.left).toContain(field);
    });

    for (const file of ['report.json', 'results.jsonl', 'events.jsonl', 'failures.json', 'metadata.json']) {
        it(`rejects missing or non-string ${file}`, () => {
            const files = { ...ordinaryArtifact.files };
            Reflect.deleteProperty(files, file);
            for (
                const value of [
                    { ...ordinaryArtifact, files },
                    { ...ordinaryArtifact, files: { ...ordinaryArtifact.files, [file]: 1 } }
                ]
            ) {
                const decoded = decodeControlRunArtifactBundle(value);
                expect(decoded.right).toBeUndefined();
                expect(decoded.left).toContain(file);
            }
        });
    }
});

describe(
    'distributed control artifact envelope boundary',
    () => {
        it('accepts the three mandatory files without parsing contents or adding a version policy', () => {
            for (const artifactSchemaVersion of [0, 1, 2, 9.5]) {
                const value = { ...distributedArtifact, artifactSchemaVersion };
                expect(decodeControlDistributedRunArtifactBundle(value).right).toEqual(value);
            }
        });

        it.each([
            { field: 'artifact', value: null },
            { field: 'artifact', value: [] },
            { field: 'artifactSchemaVersion', value: { ...distributedArtifact, artifactSchemaVersion: '2' } },
            { field: 'artifactSchemaVersion', value: { ...distributedArtifact, artifactSchemaVersion: Infinity } },
            { field: 'distributedRunId', value: { ...distributedArtifact, distributedRunId: '' } },
            { field: 'distributedRunId', value: { ...distributedArtifact, distributedRunId: 1 } },
            { field: 'generatedAtEpochMs', value: { ...distributedArtifact, generatedAtEpochMs: undefined } },
            { field: 'generatedAtEpochMs', value: { ...distributedArtifact, generatedAtEpochMs: NaN } },
            { field: 'files', value: { ...distributedArtifact, files: null } },
            { field: 'files', value: { ...distributedArtifact, files: [] } }
        ])('refuses invalid mandatory $field input', ({ field, value }) => {
            const decoded = decodeControlDistributedRunArtifactBundle(value);
            expect(decoded.right).toBeUndefined();
            expect(decoded.left).toContain(field);
        });

        for (const file of ['distributed-run.json', 'manifest.json', 'control-run.json']) {
            it(`refuses missing or non-string mandatory ${file}`, () => {
                const files = { ...distributedArtifact.files };
                Reflect.deleteProperty(files, file);
                for (
                    const value of [
                        { ...distributedArtifact, files },
                        { ...distributedArtifact, files: { ...distributedArtifact.files, [file]: 1 } }
                    ]
                ) {
                    const decoded = decodeControlDistributedRunArtifactBundle(value);
                    expect(decoded.right).toBeUndefined();
                    expect(decoded.left).toContain(file);
                }
            });
        }

        for (const file of ['target-resolution.json', 'report.json', 'results.jsonl', 'events.jsonl', 'failures.json', 'metadata.json']) {
            it(`accepts absent or string optional ${file} and refuses malformed supplied values`, () => {
                const supplied = { ...distributedArtifact, files: { ...distributedArtifact.files, [file]: '' } };
                expect(decodeControlDistributedRunArtifactBundle(supplied).right).toEqual(supplied);
                for (const value of [null, 1, false, {}, [], undefined]) {
                    const decoded = decodeControlDistributedRunArtifactBundle({
                        ...distributedArtifact,
                        files: { ...distributedArtifact.files, [file]: value }
                    });
                    expect(decoded.right).toBeUndefined();
                    expect(decoded.left).toContain(file);
                }
            });
        }
    }
);

it('RUN closure canonical envelope refuses unknown non-string file content', () => {
    const value = { ...distributedArtifact, files: { ...distributedArtifact.files, 'unknown.txt': 7 } };
    const decoded = decodeControlDistributedRunArtifactBundle(value);
    expect.soft(decoded.right).toBeUndefined();
    expect.soft(decoded.left).toContain('unknown.txt');
});

it('RUN closure canonical envelope preserves unknown string files without a filename policy', () => {
    const value = { ...distributedArtifact, files: { ...distributedArtifact.files, 'unknown.txt': 'literal extra', '../escaped.txt': 'unsafe-name-control' } };
    expect(decodeControlDistributedRunArtifactBundle(value).right).toEqual(value);
});
