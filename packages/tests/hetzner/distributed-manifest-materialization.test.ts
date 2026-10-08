import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { TestContext } from 'vitest';
import { decodeDistributedRunManifest, toDistributedRunManifestValidationText } from '../../shared-test/rallar-bb-test/distributed-run-validation.ts';
import type { RallarBlackBoxDistributedGroupRef, RallarBlackBoxDistributedRunManifest } from '../../shared-test/rallar-bb-test/distributed-run.ts';
import { RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA } from '../../shared-test/rallar-bb-test/schema.ts';
import { isJsonRecordValue, validateJsonSchema } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import type { RtcSignalingDiagnostics } from '../../shared/webrtc/rtc-signaling-diagnostics.ts';
import { runOwnedTestProcess, type OwnedTestProcessOutcome } from './owned-test-process.ts';

interface MaterializerInvocationInput {
    readonly sourcePath: string;
    readonly outputPath: string;
    readonly recordPath: string;
    readonly agentSource: 'hetzner' | 'external' | 'mixed';
    readonly operatorPhase: 'full' | 'prepare' | 'run';
    readonly controlRunId: string;
    readonly distributedRunId: string;
    readonly repository: string;
    readonly workflowRunId: string;
    readonly workflowRunAttempt: string;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly roomId: string;
}

interface MaterializerProcessResult extends OwnedTestProcessOutcome {
    readonly argv: readonly string[];
}

interface MaterializationModeInput {
    readonly label: string;
    readonly agentSource: MaterializerInvocationInput['agentSource'];
    readonly runAttempt: string;
    readonly roomId: string;
    readonly applicationId: string;
    readonly workspaceId: string;
}

interface MaterializationModeOutcome {
    readonly manifest: RallarBlackBoxDistributedRunManifest;
    readonly recordText: string;
}

interface CaptureManifestFixtureInput {
    readonly groupId: string;
    /** Omission exercises inherited capture without introducing an authored default. */
    readonly captureMode?: RtcSignalingDiagnostics.CaptureMode;
}

interface CaptureManifestMaterializationInput {
    readonly directory: string;
    readonly sourceText: string;
}

interface CaptureManifestMaterializationEvidence {
    readonly argv: readonly string[];
    readonly sourceText: string;
    readonly sourceAfterText: string;
    readonly outputText: string;
    readonly recordText: string;
    readonly stdout: string;
    readonly stderr: string;
}

const repoRoot = path.resolve(__dirname, '../../..');
const supportedMainlineManifestPaths = [
    'apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json',
    'apps/rallar-black-box/manifests/hetzner/02-composite-evidence-2-agent.json',
    'apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json',
    'apps/rallar-black-box/manifests/hetzner/04-provider-parity-2-agent.json',
    'apps/rallar-black-box/manifests/hetzner/05a-rtc-realtime-stability-2-agent-5s.json'
];

const materializerInvocationDefaults = {
    agentSource: 'hetzner',
    operatorPhase: 'run',
    controlRunId: 'main-30327139535-2-05a-rtc-realtime-stability-2-agent-5s',
    distributedRunId: 'dist-main-30327139535-2-05a-rtc-realtime-stability-2-agent-5s',
    repository: 'intact-software-systems/ar-eye-hunter',
    workflowRunId: '30327139535',
    workflowRunAttempt: '2',
    applicationId: '',
    workspaceId: '',
    roomId: ''
} as const;

function expectCaptureManifestIsolation(evidence: CaptureManifestMaterializationEvidence, groupId: string): RallarBlackBoxDistributedGroupRef {
    const output: unknown = JSON.parse(evidence.outputText);
    if (!isJsonRecordValue(output) || !isJsonRecordValue(output.group) || typeof output.group.groupId !== 'string') {
        throw new Error('Materializer must emit the complete effective GroupRef.');
    }
    const effectiveGroup = { applicationId: 'rallar-server', workspaceId: 'default', groupId: output.group.groupId };
    expect(effectiveGroup.groupId).toMatch(/^hetzner-run-[a-f0-9]{64}$/);
    expect(effectiveGroup.groupId).not.toBe(groupId);
    expect(output).toMatchObject({
        controlRunId: 'capture-control',
        distributedRunId: 'capture-distributed',
        group: effectiveGroup,
        recipes: [{
            recipe: {
                metadata: { group: effectiveGroup },
                commands: [
                    { kind: 'configure', config: { roomId: effectiveGroup.groupId } },
                    {
                        kind: 'http.request',
                        metadata: { group: effectiveGroup },
                        request: {
                            path: '/api/state/apps/rallar-server/workspaces/default/groups/requests/rtc-smoke-ensure-group-{runtimeIdentity}',
                            body: { groupId: effectiveGroup.groupId }
                        }
                    },
                    {
                        kind: 'http.request',
                        metadata: { group: effectiveGroup },
                        request: {
                            path:
                                `/api/state/apps/rallar-server/workspaces/default/groups/${effectiveGroup.groupId}/members/{auth.clientId}/requests/rtc-smoke-ensure-member-{runtimeIdentity}`
                        }
                    },
                    { kind: 'rtc.connect', roomId: effectiveGroup.groupId, applicationId: 'rallar-server', workspaceId: 'default', roomRef: effectiveGroup },
                    {
                        kind: 'rtc.send',
                        applicationId: 'rallar-server',
                        workspaceId: 'default',
                        roomRef: effectiveGroup,
                        send: { roomId: effectiveGroup.groupId, roomRef: effectiveGroup }
                    },
                    { kind: 'stats' }
                ]
            }
        }]
    });
    return effectiveGroup;
}

async function readManifest(filePath: string): Promise<RallarBlackBoxDistributedRunManifest> {
    const decoded = decodeDistributedRunManifest(JSON.parse(await readFile(filePath, 'utf8')));
    return decoded.fold((issues) => {
        throw new Error(toDistributedRunManifestValidationText(issues));
    }, (manifest) => manifest);
}

async function runMaterializer(context: TestContext, input: MaterializerInvocationInput): Promise<MaterializerProcessResult> {
    const argv = [
        path.join(repoRoot, 'scripts/hosted-rallar/actions/materialize-hetzner-run-manifest.mjs'),
        '--source',
        input.sourcePath,
        '--output',
        input.outputPath,
        '--record-output',
        input.recordPath,
        '--agent-source',
        input.agentSource,
        '--operator-phase',
        input.operatorPhase,
        '--control-run-id',
        input.controlRunId,
        '--distributed-run-id',
        input.distributedRunId,
        '--repository',
        input.repository,
        '--workflow-run-id',
        input.workflowRunId,
        '--workflow-run-attempt',
        input.workflowRunAttempt,
        '--application-id',
        input.applicationId,
        '--workspace-id',
        input.workspaceId,
        '--room-id',
        input.roomId
    ];
    const output = await runOwnedTestProcess(context, { executable: 'node', args: argv, options: { cwd: repoRoot } });
    return { argv, ...output };
}

async function readCaptureManifestFixture(input: CaptureManifestFixtureInput): Promise<RallarBlackBoxDistributedRunManifest> {
    const fixtureText = await readFile(path.join(repoRoot, supportedMainlineManifestPaths[2]), 'utf8');
    const decoded = decodeDistributedRunManifest(JSON.parse(fixtureText.replaceAll('hetzner-headless-room', input.groupId)));
    const fixture = decoded.fold((issues) => {
        throw new Error(toDistributedRunManifestValidationText(issues));
    }, (manifest) => manifest);
    return {
        ...fixture,
        ...(input.captureMode === undefined ? {} : { rtcCaptureMode: input.captureMode }),
        recipes: fixture.recipes.map((selection) => {
            if (!selection.recipe) {
                throw new Error('RTC smoke fixture must include its complete authored recipe.');
            }
            return {
                ...selection,
                recipe: {
                    ...selection.recipe,
                    ...(input.captureMode === undefined ? {} : { rtcCaptureMode: input.captureMode }),
                    commands: [
                        {
                            kind: 'configure',
                            config: {
                                roomId: input.groupId,
                                rallar: { rtc: input.captureMode === undefined ? {} : { captureMode: input.captureMode } }
                            }
                        },
                        ...selection.recipe.commands.map((command) =>
                            command.kind === 'rtc.connect'
                                ? { ...command, ...(input.captureMode === undefined ? {} : { rallar: { rtcCaptureMode: input.captureMode } }) }
                                : command
                        )
                    ]
                }
            };
        })
    };
}

async function materializeCaptureManifest(context: TestContext, input: CaptureManifestMaterializationInput): Promise<CaptureManifestMaterializationEvidence> {
    const sourcePath = path.join(input.directory, 'source-manifest.json');
    const outputPath = path.join(input.directory, 'materialized-manifest.json');
    const recordPath = path.join(input.directory, 'materialization.json');
    await writeFile(sourcePath, input.sourceText);
    const { argv, stdout, stderr } = await runMaterializer(context, {
        ...materializerInvocationDefaults,
        sourcePath,
        outputPath,
        recordPath,
        controlRunId: 'capture-control',
        distributedRunId: 'capture-distributed',
        workflowRunId: 'capture-workflow',
        workflowRunAttempt: '1'
    });
    return {
        argv,
        sourceText: input.sourceText,
        stdout,
        stderr,
        sourceAfterText: await readFile(sourcePath, 'utf8'),
        outputText: await readFile(outputPath, 'utf8'),
        recordText: await readFile(recordPath, 'utf8')
    };
}

describe('Hetzner materialization contracts and effects', () => {
    it.for(
        [
            { captureMode: 'off', groupId: 'off' },
            { captureMode: 'signaling', groupId: 'signaling' },
            { captureMode: 'native', groupId: 'native' },
            { captureMode: 'off', groupId: 'of' },
            { captureMode: 'signaling', groupId: 'gnal' },
            { captureMode: 'native', groupId: 'ativ' },
            { captureMode: undefined, groupId: 'capture-inherited-room' }
        ] as const
    )('preserves $captureMode capture in a valid manifest with room $groupId', async (input, context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-capture-collision-'));
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const source = await readCaptureManifestFixture(input);
        expect(validateJsonSchema(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA, source)).toEqual({ ok: true, errors: [] });
        const evidence = await materializeCaptureManifest(context, { directory, sourceText: `${JSON.stringify(source, null, 2)}\n` });
        console.info('capture-materialization-evidence', JSON.stringify(evidence));
        const effectiveGroup = expectCaptureManifestIsolation(evidence, input.groupId);
        expect(evidence.sourceAfterText).toBe(evidence.sourceText);
        expect(JSON.parse(evidence.recordText)).toMatchObject({
            isolationMode: 'isolated',
            sourceGroupRef: { applicationId: 'rallar-server', workspaceId: 'default', groupId: input.groupId },
            effectiveGroupRef: effectiveGroup,
            sourceManifestSha256: createHash('sha256').update(evidence.sourceText).digest('hex'),
            materializedManifestSha256: createHash('sha256').update(evidence.outputText).digest('hex')
        });
        const output: unknown = JSON.parse(evidence.outputText);
        for (
            const capturePath of [
                'rtcCaptureMode',
                'recipes.0.recipe.rtcCaptureMode',
                'recipes.0.recipe.commands.3.rallar.rtcCaptureMode',
                'recipes.0.recipe.commands.0.config.rallar.rtc.captureMode'
            ]
        ) {
            if (input.captureMode === undefined) {
                expect.soft(output).not.toHaveProperty(capturePath);
            }
            else {
                expect.soft(output).toHaveProperty(capturePath, input.captureMode);
            }
        }
        expect.soft(validateJsonSchema(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA, output)).toEqual({ ok: true, errors: [] });
    });

    it('preserves unrelated labels and opaque strings while translating recognized scoped requests', async (context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-unrelated-manifest-data-'));
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const fixture = await readCaptureManifestFixture({ groupId: 'off', captureMode: 'off' });
        const source = {
            ...fixture,
            metadata: {
                ...fixture.metadata,
                label: 'off',
                path: '/apps/rallar-server/workspaces/default/groups/off',
                requestId: 'opaque:rallar-server:default:off:label',
                'idempotency-key': 'opaque:rallar-server:default:off:label'
            },
            recipes: fixture.recipes.map((selection) => {
                if (!selection.recipe) {
                    throw new Error('RTC smoke fixture requires an inline recipe.');
                }
                return {
                    ...selection,
                    recipe: {
                        ...selection.recipe,
                        commands: selection.recipe.commands.map((command) => {
                            if (command.kind !== 'http.request' || command.commandId !== 'rtc-smoke-ensure-group') {
                                return command;
                            }
                            if (!isJsonRecordValue(command.request.body)) {
                                throw new Error('Ensure-group fixture requires its JSON body.');
                            }
                            return {
                                ...command,
                                request: {
                                    ...command.request,
                                    body: { ...command.request.body, requestId: 'probe:ensure-group:rallar-server:default:off:{auth.sessionId}' }
                                }
                            };
                        })
                    }
                };
            })
        };
        expect(validateJsonSchema(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA, source)).toEqual({ ok: true, errors: [] });
        const evidence = await materializeCaptureManifest(context, { directory, sourceText: `${JSON.stringify(source, null, 2)}\n` });
        console.info('unrelated-materialization-evidence', JSON.stringify(evidence));
        const group = expectCaptureManifestIsolation(evidence, 'off');
        const output: unknown = JSON.parse(evidence.outputText);
        expect.soft(output).toMatchObject({
            metadata: {
                label: 'off',
                path: '/apps/rallar-server/workspaces/default/groups/off',
                requestId: 'opaque:rallar-server:default:off:label',
                'idempotency-key': 'opaque:rallar-server:default:off:label'
            }
        });
        expect.soft(output).toHaveProperty('recipes.0.recipe.commands.1.request.body.displayName', 'off');
        expect(output).toHaveProperty(
            'recipes.0.recipe.commands.1.request.body.requestId',
            `probe:ensure-group:rallar-server:default:${group.groupId}:{auth.sessionId}`
        );
    });

    it.for([
        { key: 'requestId', marker: 'ensure-group' },
        { key: 'requestId', marker: 'ensure-member' },
        { key: 'Idempotency-Key', marker: 'ensure-group' },
        { key: 'Idempotency-Key', marker: 'ensure-member' }
    ])('translates a suffixless $key scoped $marker identity', async (input, context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-suffixless-scope-'));
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const fixture = await readCaptureManifestFixture({ groupId: 'off', captureMode: 'off' });
        const source = { ...fixture, metadata: { ...fixture.metadata, [input.key]: `probe:${input.marker}:rallar-server:default:off` } };
        expect(validateJsonSchema(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA, source)).toEqual({ ok: true, errors: [] });
        console.info('suffixless-source-evidence', JSON.stringify(source));
        const evidence = await materializeCaptureManifest(context, { directory, sourceText: `${JSON.stringify(source, null, 2)}\n` });
        const group = expectCaptureManifestIsolation(evidence, 'off');
        expect(JSON.parse(evidence.outputText)).toHaveProperty(`metadata.${input.key}`, `probe:${input.marker}:rallar-server:default:${group.groupId}`);
    });

    it('materializes every supported manifest without treating parallel labels as room scope', async (context) => {
        const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'rallar-supported-manifests-'));
        onTestFinished(() => rm(temporaryDirectory, { recursive: true, force: true }));

        for (const [index, manifestPath] of supportedMainlineManifestPaths.entries()) {
            const outputPath = path.join(temporaryDirectory, `${index}-manifest.json`);
            const recordPath = path.join(temporaryDirectory, `${index}-materialization.json`);
            await runMaterializer(context, {
                ...materializerInvocationDefaults,
                sourcePath: path.join(repoRoot, manifestPath),
                outputPath: outputPath,
                recordPath: recordPath,
                controlRunId: `control-supported-${index}`,
                distributedRunId: `dist-supported-${index}`,
                workflowRunId: '30341252322',
                workflowRunAttempt: '1'
            });

            const manifest = await readManifest(outputPath);
            expect(manifest.group.groupId).toMatch(/^hetzner-run-[a-f0-9]{64}$/);
            if (manifestPath.endsWith('/02-composite-evidence-2-agent.json')) {
                expect(manifest).toHaveProperty('recipes.0.recipe.commands.1.groups', [{
                    groupId: 'left-health',
                    commands: [{ kind: 'health', commandId: 'parallel-left-health' }]
                }, { groupId: 'right-stats', commands: [{ kind: 'stats', commandId: 'parallel-right-stats' }] }]);
            }
        }
    });

    it('preserves a parallel label that happens to equal the source room', async (context) => {
        const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'rallar-parallel-label-'));
        onTestFinished(() => rm(temporaryDirectory, { recursive: true, force: true }));
        const sourcePath = path.join(temporaryDirectory, 'source.json');
        const outputPath = path.join(temporaryDirectory, 'manifest.json');
        const recordPath = path.join(temporaryDirectory, 'materialization.json');
        const fixture = await readManifest(path.join(repoRoot, 'apps/rallar-black-box/manifests/hetzner/02-composite-evidence-2-agent.json'));
        const source = {
            ...fixture,
            recipes: fixture.recipes.map((selection) => {
                if (!selection.recipe) {
                    throw new Error('Composite fixture requires its inline recipe.');
                }
                return {
                    ...selection,
                    recipe: {
                        ...selection.recipe,
                        commands: selection.recipe.commands.map((command) =>
                            command.kind === 'parallel'
                                ? {
                                    ...command,
                                    groups: command.groups.map((group, index) => index === 0 ? { ...group, groupId: 'hetzner-headless-room' } : group)
                                }
                                : command
                        )
                    }
                };
            })
        };
        await writeFile(sourcePath, `${JSON.stringify(source, null, 2)}\n`);

        await runMaterializer(context, {
            ...materializerInvocationDefaults,
            sourcePath: sourcePath,
            outputPath: outputPath,
            recordPath: recordPath,
            controlRunId: 'control-parallel-label',
            distributedRunId: 'dist-parallel-label',
            workflowRunId: '30341252322',
            workflowRunAttempt: '1'
        });

        const manifest = await readManifest(outputPath);
        expect(manifest.group.groupId).toMatch(/^hetzner-run-[a-f0-9]{64}$/);
        expect(manifest).toMatchObject({
            recipes: [{ recipe: { commands: [{}, { groups: [{ groupId: 'hetzner-headless-room' }, { groupId: 'right-stats' }] }, {}, {}, {}] } }]
        });
    });

    it('materializes a deterministic isolated group throughout executable manifest data', async (context) => {
        const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'rallar-manifest-isolation-'));
        onTestFinished(() => rm(temporaryDirectory, { recursive: true, force: true }));
        const sourcePath = path.join(
            repoRoot,
            'apps/rallar-black-box/manifests/hetzner/05a-rtc-realtime-stability-2-agent-5s.json'
        );
        const outputPath = path.join(temporaryDirectory, 'manifest.json');
        const recordPath = path.join(temporaryDirectory, 'materialization.json');
        const sourceBefore = await readFile(sourcePath, 'utf8');

        await runMaterializer(context, { ...materializerInvocationDefaults, sourcePath: sourcePath, outputPath: outputPath, recordPath: recordPath });

        const manifest = await readManifest(outputPath);
        const record: unknown = JSON.parse(await readFile(recordPath, 'utf8'));
        const effectiveGroupId = manifest.group.groupId;
        const repeatedOutputPath = path.join(temporaryDirectory, 'repeated-manifest.json');
        const repeatedRecordPath = path.join(temporaryDirectory, 'repeated-materialization.json');
        await runMaterializer(context, {
            ...materializerInvocationDefaults,
            sourcePath: sourcePath,
            outputPath: repeatedOutputPath,
            recordPath: repeatedRecordPath
        });

        expect(effectiveGroupId).toMatch(/^hetzner-run-[a-f0-9]{64}$/);
        expect(record).toMatchObject({
            schemaVersion: 1,
            isolationMode: 'isolated',
            sourceGroupRef: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'hetzner-headless-room'
            },
            effectiveGroupRef: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: effectiveGroupId
            },
            sourceManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            materializedManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        });
        expect(manifest.distributedRunId).toBe(
            'dist-main-30327139535-2-05a-rtc-realtime-stability-2-agent-5s'
        );
        expect(manifest.controlRunId).toBe('main-30327139535-2-05a-rtc-realtime-stability-2-agent-5s');
        const effectiveGroupRef = { applicationId: 'rallar-server', workspaceId: 'default', groupId: effectiveGroupId };
        expect(manifest).toMatchObject({
            group: effectiveGroupRef,
            recipes: [{
                recipe: {
                    metadata: { group: effectiveGroupRef },
                    commands: [
                        { request: { body: { groupId: effectiveGroupId, displayName: 'hetzner-headless-room' } } },
                        {
                            request: {
                                path:
                                    `/api/state/apps/rallar-server/workspaces/default/groups/${effectiveGroupId}/members/{auth.clientId}/requests/rtc-realtime-ensure-member-{runtimeIdentity}`
                            }
                        },
                        { kind: 'rtc.connect', roomId: effectiveGroupId, applicationId: 'rallar-server', workspaceId: 'default', roomRef: effectiveGroupRef },
                        {
                            kind: 'rtc.stream',
                            roomId: effectiveGroupId,
                            applicationId: 'rallar-server',
                            workspaceId: 'default',
                            roomRef: effectiveGroupRef,
                            send: { roomId: effectiveGroupId, roomRef: effectiveGroupRef }
                        },
                        { kind: 'stats' }
                    ]
                }
            }]
        });
        expect(JSON.stringify(manifest)).toContain(`/groups/${effectiveGroupId}/members/`);
        expect(await readFile(repeatedOutputPath, 'utf8')).toBe(await readFile(outputPath, 'utf8'));
        expect(await readFile(repeatedRecordPath, 'utf8')).toBe(await readFile(recordPath, 'utf8'));
        expect(await readFile(sourcePath, 'utf8')).toBe(sourceBefore);
    });

    it('changes isolated groups across attempts and preserves explicit or external groups', async (context) => {
        const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'rallar-manifest-modes-'));
        onTestFinished(() => rm(temporaryDirectory, { recursive: true, force: true }));
        const sourcePath = path.join(
            repoRoot,
            'apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json'
        );

        const materialize = async (input: MaterializationModeInput): Promise<MaterializationModeOutcome> => {
            const { label, agentSource, runAttempt, roomId, applicationId, workspaceId } = input;
            const outputPath = path.join(temporaryDirectory, `${label}.json`);
            const recordPath = path.join(temporaryDirectory, `${label}-record.json`);
            await runMaterializer(context, {
                ...materializerInvocationDefaults,
                sourcePath: sourcePath,
                outputPath: outputPath,
                recordPath: recordPath,
                agentSource: agentSource,
                controlRunId: `control-${label}`,
                distributedRunId: `dist-${label}`,
                workflowRunAttempt: runAttempt,
                applicationId: applicationId,
                workspaceId: workspaceId,
                roomId: roomId
            });
            return { manifest: await readManifest(outputPath), recordText: await readFile(recordPath, 'utf8') };
        };

        const common = { applicationId: '', workspaceId: '' };
        const first = await materialize({ ...common, label: 'first', agentSource: 'hetzner', runAttempt: '1', roomId: '' });
        const second = await materialize({ ...common, label: 'second', agentSource: 'hetzner', runAttempt: '2', roomId: '' });
        const explicit = await materialize({ ...common, label: 'explicit', agentSource: 'hetzner', runAttempt: '2', roomId: 'operator-room' });
        const external = await materialize({
            label: 'external',
            agentSource: 'external',
            runAttempt: '2',
            roomId: '',
            applicationId: 'workflow-default-application',
            workspaceId: 'workflow-default-workspace'
        });

        expect(first.manifest.group.groupId).not.toBe(second.manifest.group.groupId);
        expect(JSON.parse(explicit.recordText)).toMatchObject({
            isolationMode: 'explicit',
            effectiveGroupRef: { groupId: 'operator-room' }
        });
        expect(JSON.parse(external.recordText)).toMatchObject({
            isolationMode: 'preserved',
            effectiveGroupRef: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'hetzner-headless-room'
            }
        });
    });

    it('rejects an executable command scoped outside the source manifest group', async (context) => {
        const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'rallar-manifest-mismatch-'));
        onTestFinished(() => rm(temporaryDirectory, { recursive: true, force: true }));
        const sourcePath = path.join(temporaryDirectory, 'source.json');
        const outputPath = path.join(temporaryDirectory, 'manifest.json');
        const recordPath = path.join(temporaryDirectory, 'materialization.json');
        const fixture = await readManifest(path.join(repoRoot, 'apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json'));
        const source = {
            ...fixture,
            recipes: fixture.recipes.map((selection) => {
                if (!selection.recipe) {
                    throw new Error('RTC smoke fixture requires its inline recipe.');
                }
                return {
                    ...selection,
                    recipe: {
                        ...selection.recipe,
                        commands: selection.recipe.commands.map((command) => {
                            if (command.kind === 'rtc.connect') {
                                return { ...command, roomId: 'wrong-room' };
                            }
                            if (command.kind !== 'http.request') {
                                return command;
                            }
                            if (command.commandId === 'rtc-smoke-ensure-member') {
                                return {
                                    ...command,
                                    request: {
                                        ...command.request,
                                        path: '/api/state/apps/rallar-server/workspaces/default/groups/wrong-path-room/members/{auth.clientId}'
                                    }
                                };
                            }
                            if (!isJsonRecordValue(command.request.body)) {
                                throw new Error('Ensure-group fixture requires a JSON body.');
                            }
                            return {
                                ...command,
                                request: {
                                    ...command.request,
                                    body: {
                                        ...command.request.body,
                                        requestId: 'rtc-smoke:ensure-group:rallar-server:default:wrong-request-room:{auth.sessionId}'
                                    }
                                }
                            };
                        })
                    }
                };
            })
        };
        await writeFile(sourcePath, `${JSON.stringify(source, null, 2)}\n`);

        const rejection = runMaterializer(context, {
            ...materializerInvocationDefaults,
            sourcePath,
            outputPath,
            recordPath,
            controlRunId: 'control-mismatch',
            distributedRunId: 'dist-mismatch',
            workflowRunAttempt: '1'
        });
        await expect(rejection).rejects.toMatchObject({ stderr: expect.stringContaining('wrong-room') });
        await expect(rejection).rejects.toMatchObject({ stderr: expect.stringContaining('wrong-request-room') });
        await expect(rejection).rejects.toMatchObject({ stderr: expect.stringContaining('wrong-path-room') });
    });
});
