import { createHash } from 'node:crypto';
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';
import type { TestContext } from 'vitest';

import { writeDistributedRunArtifactAnalysis } from '../../../apps/rallar-black-box/scripts/write-distributed-run-artifact-analysis.ts';
import operationReportSchema from '../../../scripts/hosted-rallar/actions/hetzner-operation-report.schema.json' with { type: 'json' };
import {
    decodeDistributedRunManifest,
    toDistributedRunManifestValidationText
} from '../../shared-test/rallar-bb-test/distributed-run-validation.ts';
import {
    formatJsonSchemaValidationErrors,
    isJsonRecordValue,
    validateJsonSchema
} from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { runOwnedTestProcess } from './owned-test-process.ts';

/** The canonical JSON schema validates the complete report; these mandatory fields are read by the assertions. */
interface OperationReportDiagnosticFields {
    readonly failureCategory: string;
    readonly recipeStarted: boolean;
    readonly nextAction: string;
}

interface OperationDiagnosticsInput {
    readonly logPath: string;
    readonly outputDirectory: string;
    readonly status: 'failed' | 'succeeded';
    readonly phase: 'prepare' | 'run';
    readonly exitCode: string;
    readonly controlRunId: string;
    readonly distributedRunId: string;
    readonly artifactAvailable: string;
    readonly materializationArguments: readonly string[];
}

const repoRoot = path.resolve(__dirname, '../../..');
const operationSourceGroupRef = {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId: 'hetzner-headless-room'
};

const operationEffectiveGroupRef = {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId: `hetzner-run-${'a'.repeat(64)}`
};

const healthManifestPath = 'apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json';

const distributedRunnerWorkflowPath = '.github/workflows/hetzner-distributed-recipe-runner.yml';

async function writeControlPostFailureCurl(directory: string): Promise<void> {
    const curlPath = path.join(directory, 'curl');
    await writeFile(
        curlPath,
        [
            '#!/usr/bin/env bash',
            'output=""',
            'while [[ $# -gt 0 ]]; do',
            '  case "$1" in',
            '    -o) output="$2"; shift 2 ;;',
            '    -w) shift 2 ;;',
            '    *) shift ;;',
            '  esac',
            'done',
            'printf "%s" "${RALLAR_TEST_POST_RESPONSE}" > "${output}"',
            'printf "400"',
            ''
        ].join('\n')
    );
    await chmod(curlPath, 0o755);
}

async function readOperationReport(
    directory: string
): Promise<OperationReportDiagnosticFields> {
    const report: unknown = JSON.parse(
        await readFile(path.join(directory, 'operation-report.json'), 'utf8')
    );
    const validation = validateJsonSchema(operationReportSchema, report);
    if (!validation.ok) {
        throw new Error(formatJsonSchemaValidationErrors(validation.errors));
    }
    return report as OperationReportDiagnosticFields;
}

async function writeOperationDiagnostics(
    context: TestContext,
    input: OperationDiagnosticsInput
): Promise<void> {
    await runOwnedTestProcess(context, {
        executable: 'node',
        args: [
            path.join(
                repoRoot,
                'scripts/hosted-rallar/actions/write-hetzner-operation-report.mjs'
            ),
            '--log',
            input.logPath,
            '--output-dir',
            input.outputDirectory,
            '--status',
            input.status,
            '--phase',
            input.phase,
            '--exit-code',
            input.exitCode,
            '--commit',
            'f6224149a7f613555f935c12efcdcdd0f1a67e53',
            '--manifest',
            healthManifestPath,
            ...input.materializationArguments,
            '--control-run-id',
            input.controlRunId,
            '--distributed-run-id',
            input.distributedRunId,
            '--artifact-available',
            input.artifactAvailable,
            '--started-at',
            '2026-07-28T00:00:00.000Z',
            '--finished-at',
            '2026-07-28T00:01:00.000Z'
        ],
        options: {}
    });
}

const writeOperationMaterializationFixture = async (
    directory: string
): Promise<readonly string[]> => {
    const sourcePath = path.join(repoRoot, healthManifestPath);
    const sourceText = await readFile(sourcePath, 'utf8');
    const decoded = decodeDistributedRunManifest(JSON.parse(sourceText));
    const sourceManifest = decoded.fold(
        (issues) => {
            throw new Error(toDistributedRunManifestValidationText(issues));
        },
        (manifest) => manifest
    );
    const materializedManifest = {
        ...sourceManifest,
        group: operationEffectiveGroupRef
    };
    const materializedText = `${JSON.stringify(materializedManifest, null, 2)}\n`;
    const materializedPath = path.join(directory, 'materialized-manifest.json');
    const recordPath = path.join(directory, 'manifest-materialization.json');
    await writeFile(materializedPath, materializedText);
    await writeFile(
        recordPath,
        `${
            JSON.stringify(
                {
                    schemaVersion: 1,
                    isolationMode: 'isolated',
                    sourceGroupRef: operationSourceGroupRef,
                    effectiveGroupRef: operationEffectiveGroupRef,
                    sourceManifestSha256: createHash('sha256')
                        .update(sourceText)
                        .digest('hex'),
                    materializedManifestSha256: createHash('sha256')
                        .update(materializedText)
                        .digest('hex')
                },
                null,
                2
            )
        }\n`
    );
    return [
        '--materialization-record',
        recordPath,
        '--materialized-manifest',
        materializedPath
    ];
};

describe('Hetzner artifacts contracts and effects', () => {
    it('publishes deterministic operation diagnostics when no distributed artifact exists', async (context) => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-operation-report-'));
        onTestFinished(() => rm(tmp, { recursive: true, force: true }));
        const logPath = path.join(tmp, 'operation.log');
        const outputDir = path.join(tmp, 'diagnostics');
        await writeFile(
            logPath,
            [
                'RALLAR_OPERATION_STAGE=playwright-system-dependencies',
                'Err:8 https://deb.nodesource.com/node_24.x nodistro InRelease',
                '  403  Forbidden [IP: 2606:4700:10::ac43:1b4f 443]',
                'Authorization: Bearer secret-token',
                'RALLAR_BLACK_BOX_PASSWORD=secret-password',
                'Failed to install browser dependencies',
                `Oversized diagnostic line: ${'x'.repeat(20_000)}`,
                ''
            ].join('\n')
        );
        const materializationArguments = await writeOperationMaterializationFixture(tmp);
        await writeOperationDiagnostics(context, {
            logPath: logPath,
            outputDirectory: outputDir,
            status: 'failed',
            phase: 'prepare',
            exitCode: '100',
            controlRunId: 'main-30314398600-1-prepare',
            distributedRunId: 'dist-main-30314398600-1-prepare',
            artifactAvailable: 'false',
            materializationArguments: materializationArguments
        });

        const report = await readOperationReport(outputDir);
        expect(report).toEqual({
            schemaVersion: 2,
            status: 'failed',
            phase: 'prepare',
            stage: 'playwright-system-dependencies',
            failureCategory: 'dependency-repository',
            component: 'NodeSource apt repository',
            exitCode: 100,
            commitSha: 'f6224149a7f613555f935c12efcdcdd0f1a67e53',
            manifestPath: healthManifestPath,
            materializationStatus: 'succeeded',
            groupIsolationMode: 'isolated',
            sourceGroupRef: operationSourceGroupRef,
            effectiveGroupRef: operationEffectiveGroupRef,
            sourceManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            materializedManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            materializedManifestAvailable: true,
            controlRunId: 'main-30314398600-1-prepare',
            distributedRunId: 'dist-main-30314398600-1-prepare',
            distributedArtifactAvailable: false,
            recipeStarted: false,
            startedAt: '2026-07-28T00:00:00.000Z',
            finishedAt: '2026-07-28T00:01:00.000Z',
            evidenceExcerpt: expect.stringContaining('403  Forbidden'),
            nextAction: expect.stringContaining('controller preparation')
        });

        const summary = await readFile(path.join(outputDir, 'summary.md'), 'utf8');
        const evidence = await readFile(
            path.join(outputDir, 'evidence.log'),
            'utf8'
        );
        expect(summary).toContain('The distributed recipe did not start.');
        expect(summary).toContain('NodeSource apt repository');
        expect(summary).toContain(operationEffectiveGroupRef.groupId);
        await expect(
            readFile(path.join(outputDir, 'materialized-manifest.json'), 'utf8')
        ).resolves.toContain(operationEffectiveGroupRef.groupId);
        await expect(
            readFile(path.join(outputDir, 'manifest-materialization.json'), 'utf8')
        ).resolves.toContain('materializedManifestSha256');
        expect(evidence).toContain('403  Forbidden');
        expect(evidence).not.toContain('secret-token');
        expect(evidence).not.toContain('secret-password');
        expect(evidence.length).toBeLessThanOrEqual(12_001);
    });

    it('classifies browser, deployment, service, agent, and recipe operation stages', async (context) => {
        const cases = [
            ['manifest-materialization', 'manifest-scope', false],
            ['manifest-scope-validation', 'manifest-scope', false],
            ['playwright-system-dependencies', 'browser-dependencies', false],
            ['playwright-browser-install', 'browser-installation', false],
            ['playwright-browser-smoke', 'browser-verification', false],
            ['deployment-readiness', 'deployment-readiness', false],
            ['rollout-service-health', 'service-health', false],
            ['agent-readiness', 'agent-readiness', false],
            ['recipe-execution', 'recipe-execution', true]
        ] as const;

        for (const [stage, failureCategory, recipeStarted] of cases) {
            const tmp = await mkdtemp(
                path.join(tmpdir(), `rallar-operation-${stage}-`)
            );
            onTestFinished(() => rm(tmp, { recursive: true, force: true }));
            const logPath = path.join(tmp, 'operation.log');
            const outputDir = path.join(tmp, 'diagnostics');
            await writeFile(
                logPath,
                [
                    `RALLAR_OPERATION_STAGE=${stage}`,
                    `${stage} failed with controlled evidence`,
                    ''
                ].join('\n')
            );
            const materializationArguments = await writeOperationMaterializationFixture(tmp);

            await writeOperationDiagnostics(context, {
                logPath: logPath,
                outputDirectory: outputDir,
                status: 'failed',
                phase: 'run',
                exitCode: '1',
                controlRunId: 'controlled-run',
                distributedRunId: 'dist-controlled-run',
                artifactAvailable: recipeStarted ? 'true' : 'false',
                materializationArguments: materializationArguments
            });

            const report = await readOperationReport(outputDir);
            expect(report).toHaveProperty('failureCategory', failureCategory);
            expect(report).toHaveProperty('recipeStarted', recipeStarted);
        }
    });

    it('keeps diagnostics complete when manifest materialization fails before output exists', async (context) => {
        const tmp = await mkdtemp(
            path.join(tmpdir(), 'rallar-operation-materialization-failure-')
        );
        onTestFinished(() => rm(tmp, { recursive: true, force: true }));
        const logPath = path.join(tmp, 'operation.log');
        const outputDir = path.join(tmp, 'diagnostics');
        await writeFile(
            logPath,
            'RALLAR_OPERATION_STAGE=manifest-materialization\nManifest scope is inconsistent.\n'
        );

        await writeOperationDiagnostics(context, {
            logPath: logPath,
            outputDirectory: outputDir,
            status: 'failed',
            phase: 'run',
            exitCode: '1',
            controlRunId: 'controlled-run',
            distributedRunId: 'dist-controlled-run',
            artifactAvailable: 'false',
            materializationArguments: [
                '--materialization-record',
                path.join(tmp, 'missing-record.json'),
                '--materialized-manifest',
                path.join(tmp, 'missing-manifest.json')
            ]
        });

        const report = await readOperationReport(outputDir);
        expect(report).toMatchObject({
            schemaVersion: 2,
            failureCategory: 'manifest-scope',
            materializationStatus: 'failed',
            groupIsolationMode: 'unresolved',
            sourceGroupRef: {
                applicationId: 'unavailable',
                workspaceId: 'unavailable',
                groupId: 'unavailable'
            },
            effectiveGroupRef: {
                applicationId: 'unavailable',
                workspaceId: 'unavailable',
                groupId: 'unavailable'
            },
            sourceManifestSha256: 'unavailable',
            materializedManifestSha256: 'unavailable',
            materializedManifestAvailable: false,
            recipeStarted: false
        });
        await expect(
            readFile(path.join(outputDir, 'manifest-materialization.json'), 'utf8')
        ).resolves.toContain('"status": "failed"');
    });

    it('classifies absent run artifacts without replacing the successful remote exit code', async (context) => {
        const tmp = await mkdtemp(
            path.join(tmpdir(), 'rallar-operation-missing-artifacts-')
        );
        onTestFinished(() => rm(tmp, { recursive: true, force: true }));
        const logPath = path.join(tmp, 'operation.log');
        const outputDir = path.join(tmp, 'diagnostics');
        await writeFile(
            logPath,
            [
                'RALLAR_OPERATION_STAGE=recipe-execution',
                'Distributed recipe command completed.',
                'RALLAR_OPERATION_STAGE=artifact-collection',
                'No distributed artifact directory was copied.',
                ''
            ].join('\n')
        );
        const materializationArguments = await writeOperationMaterializationFixture(tmp);

        await writeOperationDiagnostics(context, {
            logPath: logPath,
            outputDirectory: outputDir,
            status: 'succeeded',
            phase: 'run',
            exitCode: '0',
            controlRunId: 'controlled-run',
            distributedRunId: 'dist-controlled-run',
            artifactAvailable: 'false',
            materializationArguments: materializationArguments
        });

        const report = await readOperationReport(outputDir);
        expect(report).toMatchObject({
            status: 'failed',
            stage: 'artifact-collection',
            failureCategory: 'missing-artifacts',
            component: 'Distributed recipe artifacts',
            exitCode: 0,
            distributedArtifactAvailable: false,
            recipeStarted: true
        });
        expect(report).toHaveProperty(
            'nextAction',
            expect.stringContaining('artifact collection')
        );

        const workflow = await readFile(
            path.join(repoRoot, distributedRunnerWorkflowPath),
            'utf8'
        );
        expect(workflow).toContain('RALLAR_OPERATION_STAGE=artifact-collection');
        expect(workflow).toContain(
            'steps.operation_diagnostics.outputs.operation_status != \'succeeded\''
        );
    });

    it('encodes remote API path identifiers and separates safe artifact directory names', async () => {
        const script = await readFile(
            path.join(
                repoRoot,
                'scripts/hosted-rallar/controller/14-run-distributed-recipe.sh'
            ),
            'utf8'
        );

        expect(script).toContain('urlencode()');
        expect(script).toContain('safe_artifact_dir_name()');
        expect(script).toContain(
            'distributed_run_path_id="$(urlencode "${distributed_run_id}")"'
        );
        expect(script).toContain(
            'control_run_path_id="$(urlencode "${control_run_id}")"'
        );
        expect(script).toContain(
            'run_artifact_name="$(safe_artifact_dir_name "${distributed_run_id}")"'
        );
        expect(script).toContain('"/distributed-runs/${distributed_run_path_id}"');
        expect(script).toContain('"/runs/${control_run_path_id}/events.jsonl"');
        expect(script).toContain(
            'Skipping bundle preview ${file_name}; direct artifact fetch is authoritative.'
        );
        expect(script).not.toContain('"/distributed-runs/${distributed_run_id}"');
        expect(script).not.toContain('"/runs/${control_run_id}/events.jsonl"');
    });

    it('rejects unsafe bundle filenames before writing extracted artifacts', async () => {
        const script = await readFile(
            path.join(
                repoRoot,
                'scripts/hosted-rallar/controller/14-run-distributed-recipe.sh'
            ),
            'utf8'
        );

        expect(script).toContain('safe_bundle_file_name()');
        expect(script).toContain('Skipping unsafe bundle file name');
        expect(script).toContain(
            'safe_name="$(safe_bundle_file_name "${file_name}")"'
        );
        expect(script).toContain('>"${run_artifact_dir}/${safe_name}"');
    });

    it('publishes analyzer markdown into the GitHub step summary', async () => {
        const workflow = await readFile(
            path.join(repoRoot, distributedRunnerWorkflowPath),
            'utf8'
        );

        expect(workflow).toContain('name: Publish distributed analysis summary');
        expect(workflow).toContain(
            'cat "${artifact_dir}/analysis/summary.md" >> "${GITHUB_STEP_SUMMARY}"'
        );
        expect(workflow).toContain(
            'cat "${artifact_dir}/analysis/fix-proposal.md" >> "${GITHUB_STEP_SUMMARY}"'
        );
        expect(workflow).toContain(
            'cat "${artifact_dir}/analysis/performance.md" >> "${GITHUB_STEP_SUMMARY}"'
        );
        expect(workflow).toContain('if [[ ! -d "${artifact_dir}" ]]; then');
        expect(workflow).toContain('exit 0');
    });

    it('persists control-server snapshots with an atomic temp-file rename', async (context) => {
        const directory = await mkdtemp(
            path.join(tmpdir(), 'rallar-native-snapshot-')
        );
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const storageDirectory = path.join(directory, 'snapshots');
        await mkdir(storageDirectory);
        const scriptPath = path.join(storageDirectory, 'atomic-snapshot.ts');
        await writeFile(
            scriptPath,
            `import { runControlSnapshotAtomicReplacementFixture } from ${
                JSON.stringify(
                    pathToFileURL(path.join(
                        repoRoot,
                        'apps/rallar-black-box-control-server/test/support/run-control-snapshot-atomic-replacement-fixture.ts'
                    )).href
                )
            };
await runControlSnapshotAtomicReplacementFixture(Deno.args[0]);
`
        );
        const { stdout } = await runOwnedTestProcess(context, {
            executable: 'deno',
            args: [
                'run',
                '--cached-only',
                '--node-modules-dir=manual',
                '--no-lock',
                '--allow-read',
                '--allow-write',
                '--config',
                path.join(repoRoot, 'apps/rallar-black-box-control-server/deno.json'),
                scriptPath,
                storageDirectory
            ],
            options: { env: { ...process.env, DENO_DIR: path.join(directory, 'deno-cache') } }
        });
        const observed: unknown = JSON.parse(stdout);
        const expectedSnapshot = {
            runs: [
                {
                    runId: 'replacement-run',
                    createdAtEpochMs: 10,
                    updatedAtEpochMs: 20,
                    agents: [],
                    commands: [],
                    results: [],
                    events: [],
                    stats: [],
                    reports: [],
                    heartbeats: []
                }
            ],
            distributedRuns: [],
            fleetReports: []
        };
        expect(observed).toEqual({
            priorText: JSON.stringify({
                schemaVersion: 1,
                savedAtEpochMs: 1,
                snapshot: { runs: [], distributedRuns: [], fleetReports: [] }
            }),
            afterFailureText: JSON.stringify({
                schemaVersion: 1,
                savedAtEpochMs: 1,
                snapshot: { runs: [], distributedRuns: [], fleetReports: [] }
            }),
            attemptedSnapshot: expectedSnapshot,
            replacementSnapshot: expectedSnapshot,
            restoredSnapshot: expectedSnapshot,
            remainingFiles: ['atomic-snapshot.ts', 'control-snapshot.json'],
            failedWarning: expect.stringContaining(
                'controlled snapshot rename refusal'
            )
        });
    });

    it('builds a non-empty distributed-run create request body from the manifest', async (context) => {
        const scriptPath = path.join(
            repoRoot,
            'scripts/hosted-rallar/controller/14-run-distributed-recipe.sh'
        );

        const { stdout } = await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [scriptPath],
            options: {
                env: {
                    ...process.env,
                    RALLAR_DISTRIBUTED_SCRIPT_SELF_TEST: 'create-body',
                    RALLAR_DISTRIBUTED_MANIFEST_PATH: path.join(
                        repoRoot,
                        'apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json'
                    )
                }
            }
        });

        const body: unknown = JSON.parse(stdout);
        if (!isJsonRecordValue(body)) {
            throw new Error('Distributed create body requires a JSON object.');
        }
        const decoded = decodeDistributedRunManifest(body.manifest);
        const manifest = decoded.fold(
            (issues) => {
                throw new Error(toDistributedRunManifestValidationText(issues));
            },
            (manifest) => manifest
        );
        expect(manifest.distributedRunId).toBe('hetzner-health-2-agent');
        const recipe = manifest.recipes[0].recipe;
        if (!recipe) {
            throw new Error('Health manifest requires its inline recipe.');
        }
        expect(recipe.commands).toHaveLength(2);
    });

    it('validates the remote manifest against the worker and run environment', async (context) => {
        const scriptPath = path.join(
            repoRoot,
            'scripts/hosted-rallar/controller/14-run-distributed-recipe.sh'
        );
        const manifestPath = path.join(
            repoRoot,
            'apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json'
        );
        const environment = {
            ...process.env,
            RALLAR_DISTRIBUTED_SCRIPT_SELF_TEST: 'validate-manifest-scope',
            RALLAR_DISTRIBUTED_MANIFEST_PATH: manifestPath,
            RALLAR_DISTRIBUTED_RUN_ID: 'hetzner-rtc-smoke-2-agent',
            RALLAR_DISTRIBUTED_CONTROL_RUN_ID: 'hetzner-manifest-template-control-run',
            RALLAR_BLACK_BOX_APPLICATION_ID: 'rallar-server',
            RALLAR_BLACK_BOX_WORKSPACE_ID: 'default',
            RALLAR_BLACK_BOX_ROOM_ID: 'hetzner-headless-room'
        };

        await expect(
            runOwnedTestProcess(context, { executable: 'bash', args: [scriptPath], options: { env: environment } })
        ).resolves.toMatchObject({
            stdout: expect.stringContaining('manifestScope=valid')
        });
        await expect(
            runOwnedTestProcess(context, {
                executable: 'bash',
                args: [scriptPath],
                options: {
                    env: { ...environment, RALLAR_BLACK_BOX_ROOM_ID: 'wrong-room' }
                }
            })
        ).rejects.toMatchObject({
            stderr: expect.stringContaining(
                'Manifest group does not match worker scope'
            )
        });
    });

    it('preserves failed control POST response bodies for artifact evidence', async (context) => {
        const tmp = await mkdtemp(
            path.join(tmpdir(), 'rallar-control-post-failure-')
        );
        onTestFinished(() => rm(tmp, { recursive: true, force: true }));
        const outputFile = path.join(tmp, 'post-response.json');
        await writeControlPostFailureCurl(tmp);

        const scriptPath = path.join(
            repoRoot,
            'scripts/hosted-rallar/controller/14-run-distributed-recipe.sh'
        );
        const { stderr, stdout } = await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [scriptPath],
            options: {
                env: {
                    ...process.env,
                    RALLAR_TEST_POST_RESPONSE: '{"error":"bad manifest"}',
                    PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ''}`,
                    RALLAR_DISTRIBUTED_SCRIPT_SELF_TEST: 'post-failure',
                    RALLAR_DISTRIBUTED_SELF_TEST_OUTPUT_FILE: outputFile
                }
            }
        });

        expect(stderr).toContain('POST /distributed-runs failed with HTTP 400');
        expect(stderr).toContain('{"error":"bad manifest"}');
        expect(stdout).toContain('saved_body={"error":"bad manifest"}');
        await expect(readFile(outputFile, 'utf8')).resolves.toBe(
            '{"error":"bad manifest"}'
        );
    });

    it('preserves the last valid distributed-run artifact when a later control GET fails', async (context) => {
        const tmp = await mkdtemp(
            path.join(tmpdir(), 'rallar-control-get-preserve-')
        );
        onTestFinished(() => rm(tmp, { recursive: true, force: true }));
        const artifactDir = path.join(tmp, 'artifacts');
        await mkdir(artifactDir, { recursive: true });
        await writeFile(
            path.join(artifactDir, 'distributed-run.json'),
            JSON.stringify({
                distributedRunId: 'dist-preserve',
                controlRunId: 'run-preserve',
                state: 'running'
            })
        );

        const scriptPath = path.join(
            repoRoot,
            'scripts/hosted-rallar/controller/14-run-distributed-recipe.sh'
        );
        const { stderr, stdout } = await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [scriptPath],
            options: {
                env: {
                    ...process.env,
                    RALLAR_DISTRIBUTED_ARTIFACT_DIR: artifactDir,
                    RALLAR_DISTRIBUTED_SCRIPT_SELF_TEST: 'get-preserve'
                }
            }
        });

        expect(stderr).toContain(
            'Keeping existing distributed-run.json after failed GET /distributed-runs/dist-preserve'
        );
        expect(stdout).toContain('preservedState=running');
        await expect(
            readFile(path.join(artifactDir, 'distributed-run.json'), 'utf8')
        ).resolves.toContain('"state":"running"');
    });

    it('preserves failed control POST response bodies as analyzable artifacts', async (context) => {
        const tmp = await mkdtemp(
            path.join(tmpdir(), 'rallar-control-post-json-evidence-')
        );
        onTestFinished(() => rm(tmp, { recursive: true, force: true }));
        const artifactDir = path.join(tmp, 'artifacts');
        await mkdir(artifactDir, { recursive: true });
        await writeControlPostFailureCurl(tmp);

        const scriptPath = path.join(
            repoRoot,
            'scripts/hosted-rallar/controller/14-run-distributed-recipe.sh'
        );
        const { stderr, stdout } = await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [scriptPath],
            options: {
                env: {
                    ...process.env,
                    RALLAR_TEST_POST_RESPONSE: '{"error":"bad manifest","message":"target policy rejected"}',
                    PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ''}`,
                    RALLAR_DISTRIBUTED_ARTIFACT_DIR: artifactDir,
                    RALLAR_DISTRIBUTED_SCRIPT_SELF_TEST: 'post-json-evidence'
                }
            }
        });

        expect(stderr).toContain(
            'Saved failed POST /distributed-runs response body to'
        );
        expect(stdout).toContain(
            'postErrorBody={"error":"bad manifest","message":"target policy rejected"}'
        );
        expect(stdout).toContain('postErrorPhase=create');
        await expect(
            readFile(
                path.join(artifactDir, 'control-post-create-error.json'),
                'utf8'
            )
        ).resolves.toBe(
            '{"error":"bad manifest","message":"target policy rejected"}'
        );
        await expect(
            readFile(
                path.join(artifactDir, 'control-post-error-metadata.json'),
                'utf8'
            )
        ).resolves.toContain('"responseFile": "control-post-create-error.json"');
        await expect(
            readFile(path.join(artifactDir, 'distributed-run.json'), 'utf8')
        ).rejects.toMatchObject({ code: 'ENOENT' });

        const analyzed = await writeDistributedRunArtifactAnalysis({
            artifactDir,
            outDir: path.join(artifactDir, 'analysis'),
            generatedAtEpochMs: 1_700_000_000_000
        });
        expect(analyzed.right?.variant).toBe('control-request-failure');
        expect(
            analyzed.right?.variant === 'control-request-failure'
                ? analyzed.right.analysis.failure
                : undefined
        ).toMatchObject({
            category: 'control-api',
            title: 'Control API create request failed.',
            likelyCause: 'target policy rejected',
            evidenceFile: 'control-post-create-error.json'
        });
        await expect(
            readFile(path.join(artifactDir, 'analysis', 'fix-proposal.md'), 'utf8')
        ).resolves.toContain('Evidence: control-post-create-error.json');
    });

    it('writes distributed-run POST snapshots through temp files before replacing evidence', async () => {
        const script = await readFile(
            path.join(
                repoRoot,
                'scripts/hosted-rallar/controller/14-run-distributed-recipe.sh'
            ),
            'utf8'
        );

        expect(script).toContain('control_post_json_to_file()');
        expect(script).toMatch(
            /control_post_json_to_file\s+\\\s+"\/distributed-runs"/
        );
        expect(script).toMatch(
            /control_post_json_to_file\s+\\\s+"\/distributed-runs\/\$\{distributed_run_path_id\}\/stage"/
        );
        expect(script).toMatch(
            /control_post_json_to_file\s+\\\s+"\/distributed-runs\/\$\{distributed_run_path_id\}\/start"/
        );
        expect(script).toContain('control_post_error_file_name()');
        expect(script).toContain('control-post-error-metadata.json');
        expect(script).not.toContain(
            'control_post "/distributed-runs" "${create_body}" >"${run_artifact_dir}/distributed-run.json"'
        );
        expect(script).not.toContain(
            'control_post "/distributed-runs/${distributed_run_path_id}/stage" "{}" >"${run_artifact_dir}/distributed-run.json"'
        );
        expect(script).not.toContain(
            'control_post "/distributed-runs/${distributed_run_path_id}/start" "{}" >"${run_artifact_dir}/distributed-run.json"'
        );
    });
});
