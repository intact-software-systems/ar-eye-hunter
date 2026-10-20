import { createHash } from 'node:crypto';
import {
    chmod,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';
import type { TestContext } from 'vitest';

import { isRallarBlackBoxTestMessagesSendCommand } from '../../shared-test/rallar-bb-test/alm/is-rallar-black-box-test-messages-send-command.ts';
import { replaceCommandPlaceholders } from '../../shared-test/rallar-bb-test/browser/browser-command-placeholders.ts';
import { decodeDistributedRunManifest, toDistributedRunManifestValidationText } from '../../shared-test/rallar-bb-test/distributed-run-validation.ts';
import type { RallarBlackBoxDistributedGroupRef, RallarBlackBoxDistributedRunManifest } from '../../shared-test/rallar-bb-test/distributed-run.ts';
import { toLoopChildCommand } from '../../shared-test/rallar-bb-test/loop/to-loop-child-command.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestResult
} from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA } from '../../shared-test/rallar-bb-test/schema.ts';
import { isJsonRecordValue, validateJsonSchema } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { resolveWaitMatchResultReferences } from '../../shared-test/rallar-bb-test/wait/resolve-wait-match-result-references.ts';
import { resolveLatestWaitEvent } from '../../shared-test/rallar-bb-test/wait/wait-event-match.ts';
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
    /** Absent when the operator preserves the authored RUN selection. */
    readonly rtcCaptureMode?: string;
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
        '--import',
        'tsx',
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
    if (input.rtcCaptureMode !== undefined) {
        argv.push('--rtc-capture-mode', input.rtcCaptureMode);
    }
    const output = await runOwnedTestProcess(context, {
        executable: 'node',
        args: argv,
        options: { cwd: repoRoot, env: { PATH: process.env.PATH, TMPDIR: path.dirname(input.outputPath), TSX_DISABLE_CACHE: '1' } }
    });
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

function toNestedMaterializationCommands(commands: readonly RallarBlackBoxTestCommand[]): readonly RallarBlackBoxTestCommand[] {
    return commands.flatMap((command) => {
        const children = command.kind === 'parallel'
            ? command.groups.flatMap((group) => group.commands)
            : command.kind === 'loop'
            ? command.commands
            : [];
        return [command, ...toNestedMaterializationCommands(children)];
    });
}

function createMaterializationReferenceResult(commandId: string, value: object): RallarBlackBoxTestResult {
    return {
        commandId,
        kind: 'messages.receipts',
        status: 'ok',
        ok: true,
        startedAtEpochMs: 1802088000000,
        endedAtEpochMs: 1802088000000,
        durationMs: 0,
        value
    };
}

describe('Hetzner materialization contracts and effects', () => {
    it('keeps original fifteen-agent serialized arrivals consistent with isolated outgoing traffic', async (context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-scoped-traffic-materialization-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const sourcePath = path.join(repoRoot, 'apps/rallar-black-box/manifests/hetzner/19-alm-conformance-15-agent-30s.json');
        const sourceText = await readFile(sourcePath, 'utf8');
        const expectedSourceManifestSha256 = createHash('sha256').update(sourceText).digest('hex');
        const source = await readManifest(sourcePath);
        const sourceCommands = source.recipes.flatMap((selection) => {
            if (!selection.recipe) {
                throw new Error('Original scale fixture requires inline recipes.');
            }
            return toNestedMaterializationCommands(selection.recipe.commands);
        });
        const receiptId = 'alm-scale-director-traffic:g1:workload:c1:alm-scale-director-window:g1:commands:c3:alm-scale-director-start-receipt';
        const playerSessions = Array.from({ length: 14 }, (_, index) => `independent-player-session-${index + 1}`);
        const directorSession = 'independent-director-session';
        const resultCache = {
            [receiptId]: createMaterializationReferenceResult(receiptId, { expectedRecipientPeerIds: playerSessions }),
            'alm-scale-player-ready-status': createMaterializationReferenceResult('alm-scale-player-ready-status', {
                directorStatus: { appointment: { sessionId: directorSession } }
            })
        };

        for (
            const mode of [
                { agentSource: 'external', isolationMode: 'preserved' },
                { agentSource: 'hetzner', isolationMode: 'isolated' }
            ] as const
        ) {
            const outputPath = path.join(directory, `${mode.agentSource}.json`);
            const recordPath = path.join(directory, `${mode.agentSource}-record.json`);
            const invocation = {
                ...materializerInvocationDefaults,
                sourcePath,
                outputPath,
                recordPath,
                agentSource: mode.agentSource,
                operatorPhase: 'full',
                controlRunId: 'alm-v1c-task47-15-20261011T105041Z',
                distributedRunId: 'dist-alm-v1c-task47-15-20261011T105041Z',
                workflowRunId: '38133404936',
                workflowRunAttempt: '1',
                rtcCaptureMode: 'off'
            } as const;
            await runMaterializer(context, invocation);
            const manifest = await readManifest(outputPath);
            const roomId = manifest.group.groupId;
            expect(manifest.group).toMatchObject({ applicationId: 'rallar-server', workspaceId: 'default' });
            if (mode.agentSource === 'hetzner') {
                expect(roomId).toMatch(/^hetzner-run-[a-f0-9]{64}$/);
                expect(roomId).not.toBe(source.group.groupId);
                const repeatedOutputPath = path.join(directory, 'repeated-hetzner.json');
                await runMaterializer(context, {
                    ...invocation,
                    outputPath: repeatedOutputPath,
                    recordPath: path.join(directory, 'repeated-hetzner-record.json')
                });
                expect((await readManifest(repeatedOutputPath)).group).toEqual(manifest.group);
            }
            else {
                expect(manifest.group).toEqual(source.group);
            }
            expect(manifest.groupAssertions).toEqual(source.groupAssertions);
            expect(JSON.parse(await readFile(recordPath, 'utf8'))).toMatchObject({
                isolationMode: mode.isolationMode,
                sourceGroupRef: source.group,
                effectiveGroupRef: manifest.group,
                sourceManifestSha256: expectedSourceManifestSha256
            });
            const commands = manifest.recipes.flatMap((selection) => {
                if (!selection.recipe) {
                    throw new Error('Materialized scale fixture requires inline recipes.');
                }
                return toNestedMaterializationCommands(selection.recipe.commands);
            });
            const waits = commands.filter((command) => command.kind === 'wait' && command.match.payloadPath === 'data.payload');
            expect(waits.map((command) => command.commandId)).toEqual([
                ...Array.from({ length: 14 }, (_, index) => `alm-scale-director-player-${index + 1}-arrival`),
                'alm-scale-player-started-arrival',
                'alm-scale-player-ended-arrival'
            ]);
            for (const [index, wait] of waits.entries()) {
                if (wait.kind !== 'wait') {
                    throw new Error('Traffic arrival must remain a wait command.');
                }
                const original = sourceCommands.find((command) => command.commandId === wait.commandId);
                if (original?.kind !== 'wait') {
                    throw new Error('Traffic wait must retain its source command identity.');
                }
                expect({ ...wait, match: { ...wait.match, contains: original.match.contains } }).toEqual(original);
                expect(wait.match.contains?.match(/\{[^{}]+\}/g)).toEqual(original.match.contains?.match(/\{[^{}]+\}/g));
                expect(wait.match.contains?.match(/match:hetzner-headless-room:1802088000000:60000/g)).toEqual(
                    original.match.contains?.match(/match:hetzner-headless-room:1802088000000:60000/g)
                );
                for (const sequence of index < 14 ? [1, 2, 3, 4, 5, 6] : [index === 14 ? 1 : 2]) {
                    const sendId = index < 14 ? `alm-scale-player-shot-${sequence}-send` : `alm-scale-director-${index === 14 ? 'started' : 'ended'}-send`;
                    const send = commands.find((command) => command.commandId === sendId);
                    if (!send || !isRallarBlackBoxTestMessagesSendCommand(send)) {
                        throw new Error(`Missing corresponding authored outgoing traffic: ${sendId}`);
                    }
                    const originalSend = sourceCommands.find((command) => command.commandId === sendId);
                    if (
                        !originalSend || !isRallarBlackBoxTestMessagesSendCommand(originalSend) ||
                        !isJsonRecordValue(send.payload) || !isJsonRecordValue(send.payload.payload) ||
                        !isJsonRecordValue(originalSend.payload) || !isJsonRecordValue(originalSend.payload.payload)
                    ) {
                        throw new Error('Traffic preservation requires the complete original outgoing envelopes.');
                    }
                    expect({ ...send, roomRef: originalSend.roomRef, payload: originalSend.payload }).toEqual(originalSend);
                    expect(send.roomRef).toEqual({ applicationId: 'rallar-server', workspaceId: 'default', groupId: roomId });
                    expect({
                        ...send.payload,
                        roomId: originalSend.payload.roomId,
                        payload: { ...send.payload.payload, roomId: originalSend.payload.payload.roomId }
                    }).toEqual(originalSend.payload);
                    const payload = replaceCommandPlaceholders(send.payload, {
                        session: {
                            clientId: 'independent-client',
                            accessToken: 'test-placeholder',
                            username: 'Independent player',
                            sessionId: index < 14 ? playerSessions[index] : directorSession,
                            expiresAtEpochMs: 1802088060000
                        },
                        config: undefined,
                        wsTicket: undefined
                    });
                    if (!isJsonRecordValue(payload) || !isJsonRecordValue(payload.payload)) {
                        throw new Error('Outgoing scale traffic requires its complete relay and game envelope.');
                    }
                    expect(payload.roomId).toBe(roomId);
                    expect(payload.payload.roomId).toBe(roomId);
                    const child = toLoopChildCommand({
                        template: wait,
                        context: { loopCommandId: 'arrival-test', index: sequence - 1, iteration: sequence, elapsedMs: 0, commandIndex: index }
                    });
                    if (child.kind !== 'wait') {
                        throw new Error('Runtime loop expansion must retain the wait contract.');
                    }
                    const match = resolveWaitMatchResultReferences(child.match, resultCache).fold(({ reference }) => {
                        throw new Error(`Unresolved fixture traffic reference: ${reference}`);
                    }, (resolved) => resolved);
                    const event: RallarBlackBoxTestEvent = {
                        eventId: `${wait.commandId}-${sequence}`,
                        kind: 'message',
                        topic: 'rallar.messages.received',
                        atEpochMs: 1802088060000,
                        connection: index < 14 ? 'alm-scale-director' : 'alm-scale-player',
                        payload: { data: { typeId: send.typeId, payload } }
                    };
                    for (const wrongRoomId of mode.agentSource === 'hetzner' ? ['wrong-room', 'hetzner-headless-room'] : ['wrong-room']) {
                        const wrongRoom = {
                            ...event,
                            payload: {
                                data: {
                                    typeId: send.typeId,
                                    payload: { ...payload, roomId: wrongRoomId, payload: { ...payload.payload, roomId: wrongRoomId } }
                                }
                            }
                        };
                        expect.soft(resolveLatestWaitEvent([wrongRoom], match), `${mode.isolationMode} ${wait.commandId}: exclude ${wrongRoomId}`)
                            .toBeUndefined();
                    }
                    for (
                        const altered of [
                            { ...payload, typeId: 'wrong-type' },
                            { ...payload, payload: { ...payload.payload, senderId: 'wrong-sender' } },
                            { ...payload, payload: { ...payload.payload, seq: sequence + 1 } }
                        ]
                    ) {
                        expect.soft(resolveLatestWaitEvent([{ ...event, payload: { data: { typeId: send.typeId, payload: altered } } }], match))
                            .toBeUndefined();
                    }
                    expect.soft(resolveLatestWaitEvent([event], match), `${mode.isolationMode} ${wait.commandId} sequence ${sequence}: effective room arrival`)
                        .toEqual(event);
                }
            }
            const displayNames = commands.flatMap((command) =>
                command.kind === 'http.request' && isJsonRecordValue(command.request.body) && typeof command.request.body.displayName === 'string'
                    ? [command.request.body.displayName]
                    : []
            );
            expect(displayNames).toEqual(['hetzner-headless-room']);
            if (mode.agentSource === 'external') {
                expect(manifest.recipes).toEqual(source.recipes);
            }
        }
        expect(await readFile(sourcePath, 'utf8')).toBe(sourceText);
    });

    it.for(['preserved', 'explicit'] as const)('preserves serialized fragment syntax and opaque text with $0 scope', async (mode, context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-serialized-room-fragment-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const fixture = await readCaptureManifestFixture({ groupId: 'off', captureMode: 'off' });
        const contains = String
            .raw`{"roomId" : "\u006f\u0066\u0066","matchId":"match:off:fixture","note":"{\"roomId\":\"off\"}","seq":{loop.iteration},"payload":{"roomId":"off",`;
        const source = {
            ...fixture,
            metadata: { ...fixture.metadata, contains },
            recipes: fixture.recipes.map((selection) => {
                if (!selection.recipe) {
                    throw new Error('Serialized fragment fixture requires an inline recipe.');
                }
                return {
                    ...selection,
                    recipe: {
                        ...selection.recipe,
                        commands: [...selection.recipe.commands, {
                            kind: 'wait' as const,
                            commandId: 'serialized-room-arrival',
                            match: { kind: 'message' as const, payloadPath: 'data.payload', contains }
                        }]
                    }
                };
            })
        };
        const sourcePath = path.join(directory, 'source.json');
        const outputPath = path.join(directory, 'output.json');
        const recordPath = path.join(directory, 'record.json');
        const sourceText = `${JSON.stringify(source, null, 2)}\n`;
        await writeFile(sourcePath, sourceText);
        await runMaterializer(context, {
            ...materializerInvocationDefaults,
            sourcePath,
            outputPath,
            recordPath,
            agentSource: 'external',
            roomId: mode === 'explicit' ? 'quote"slash\\room' : ''
        });
        const output = await readManifest(outputPath);
        const wait = output.recipes[0].recipe?.commands.at(-1);
        if (wait?.kind !== 'wait') {
            throw new Error('Serialized fragment must retain its wait command.');
        }
        expect(wait.match.contains).toBe(
            mode === 'explicit'
                ? String
                    .raw`{"roomId" : "quote\"slash\\room","matchId":"match:off:fixture","note":"{\"roomId\":\"off\"}","seq":{loop.iteration},"payload":{"roomId":"quote\"slash\\room",`
                : contains
        );
        expect(output.metadata?.contains).toBe(contains);
        expect(await readFile(sourcePath, 'utf8')).toBe(sourceText);
    });

    it('rejects a serialized source room mismatch before output writes', async (context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-serialized-room-mismatch-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const fixture = await readCaptureManifestFixture({ groupId: 'off', captureMode: 'off' });
        const source = {
            ...fixture,
            recipes: fixture.recipes.map((selection) => {
                if (!selection.recipe) {
                    throw new Error('Serialized mismatch fixture requires an inline recipe.');
                }
                return {
                    ...selection,
                    recipe: {
                        ...selection.recipe,
                        commands: [...selection.recipe.commands, {
                            kind: 'wait' as const,
                            commandId: 'wrong-room-arrival',
                            match: { kind: 'message' as const, contains: '{"roomId":"wrong-room","seq":{loop.iteration},' }
                        }]
                    }
                };
            })
        };
        const sourcePath = path.join(directory, 'source.json');
        const outputPath = path.join(directory, 'output.json');
        const recordPath = path.join(directory, 'record.json');
        const sourceText = `${JSON.stringify(source, null, 2)}\n`;
        await writeFile(sourcePath, sourceText);
        await expect(runMaterializer(context, { ...materializerInvocationDefaults, sourcePath, outputPath, recordPath }))
            .rejects.toMatchObject({ stderr: expect.stringContaining('contains serialized room "wrong-room"; expected "off"') });
        expect((await readdir(directory)).sort()).toEqual(['source.json']);
        expect(await readFile(sourcePath, 'utf8')).toBe(sourceText);
    });

    it('rewrites the scale sign-in read to the effective workspace and still refuses unknown state paths', async (context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-workspace-read-materialization-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const sourcePath = path.join(repoRoot, 'apps/rallar-black-box/manifests/hetzner/19-alm-conformance-15-agent-30s.json');
        const outputPath = path.join(directory, 'manifest.json');
        const invocation = {
            ...materializerInvocationDefaults,
            sourcePath,
            outputPath,
            recordPath: path.join(directory, 'record.json'),
            applicationId: 'effective app',
            workspaceId: 'effective-workspace'
        } as const;

        await runMaterializer(context, invocation);

        const manifest = await readManifest(outputPath);
        const scope = '/api/state/apps/effective%20app/workspaces/effective-workspace';
        const room = encodeURIComponent(manifest.group.groupId);
        expect(manifest.group).toMatchObject({ applicationId: 'effective app', workspaceId: 'effective-workspace' });
        expect(manifest.recipes.map((selection) => {
            const requests = (selection.recipe?.commands ?? []).flatMap((command) => command.kind === 'loop' ? command.commands : [command]).filter((command) =>
                command.kind === 'http.request'
            );
            return requests.map((command) => command.kind === 'http.request' ? command.request.path : undefined);
        })).toEqual([
            [
                `${scope}/stats/me/realtime`,
                `${scope}/groups/requests/alm-scale-director-ensure-group-{runtimeIdentity}`,
                `${scope}/groups/${room}/members/{auth.clientId}/requests/alm-scale-director-ensure-member-{runtimeIdentity}`
            ],
            [`${scope}/stats/me/realtime`]
        ]);

        const unknownPath = '/api/state/apps/rallar-server/workspaces/default/stats/summary';
        const source = JSON.parse(await readFile(sourcePath, 'utf8'));
        source.recipes[0].recipe.commands[0].request.path = unknownPath;
        const unknownSourcePath = path.join(directory, 'unknown-source.json');
        await writeFile(unknownSourcePath, `${JSON.stringify(source, null, 2)}\n`);
        await expect(runMaterializer(context, {
            ...invocation,
            sourcePath: unknownSourcePath,
            outputPath: path.join(directory, 'unknown.json'),
            recordPath: path.join(directory, 'unknown-record.json')
        })).rejects.toMatchObject({
            stderr: expect.stringContaining(
                `$.recipes[0].recipe.commands[0].request.path has an unrecognized state group path ${JSON.stringify(unknownPath)}`
            )
        });
    });

    it('rewrites the audience wait\'s room payload fields to the isolated group, so each page matches its own room', async (context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-audience-wait-materialization-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const sourcePath = path.join(repoRoot, 'apps/rallar-black-box/manifests/hetzner/19-alm-conformance-15-agent-30s.json');
        const outputPath = path.join(directory, 'manifest.json');

        await runMaterializer(context, {
            ...materializerInvocationDefaults,
            sourcePath,
            outputPath,
            recordPath: path.join(directory, 'record.json'),
            applicationId: 'effective app',
            workspaceId: 'effective-workspace'
        });

        const manifest = await readManifest(outputPath);
        expect(manifest.group.groupId).toMatch(/^hetzner-run-[a-f0-9]{64}$/);
        const audienceWaits = manifest.recipes.flatMap((selection) => selection.recipe?.commands ?? [])
            .filter((command) => command.commandId?.endsWith('-audience-ready'));
        expect(audienceWaits.map((command) => command.kind === 'wait' ? command.match.payloadFields : undefined)).toEqual([
            {
                'data.roomRef.applicationId': 'effective app',
                'data.roomRef.workspaceId': 'effective-workspace',
                'data.roomRef.groupId': manifest.group.groupId,
                'data.activeSessionCount': 15
            },
            {
                'data.roomRef.applicationId': 'effective app',
                'data.roomRef.workspaceId': 'effective-workspace',
                'data.roomRef.groupId': manifest.group.groupId,
                'data.activeSessionCount': 15
            }
        ]);
    });

    it('rejects a wait payload field scoped to another room before output writes', async (context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-payload-field-room-mismatch-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const fixture = await readCaptureManifestFixture({ groupId: 'off', captureMode: 'off' });
        const source = {
            ...fixture,
            recipes: fixture.recipes.map((selection) => {
                if (!selection.recipe) {
                    throw new Error('Payload field mismatch fixture requires an inline recipe.');
                }
                return {
                    ...selection,
                    recipe: {
                        ...selection.recipe,
                        commands: [...selection.recipe.commands, {
                            kind: 'wait' as const,
                            commandId: 'wrong-room-audience',
                            match: { kind: 'diagnostic' as const, payloadFields: { 'data.roomRef.groupId': 'wrong-room' } }
                        }]
                    }
                };
            })
        };
        const sourcePath = path.join(directory, 'source.json');
        const sourceText = `${JSON.stringify(source, null, 2)}\n`;
        await writeFile(sourcePath, sourceText);

        await expect(runMaterializer(context, {
            ...materializerInvocationDefaults,
            sourcePath,
            outputPath: path.join(directory, 'output.json'),
            recordPath: path.join(directory, 'record.json')
        })).rejects.toMatchObject({
            stderr: expect.stringContaining('.match.payloadFields.data.roomRef.groupId is "wrong-room"; expected "off"')
        });
        expect((await readdir(directory)).sort()).toEqual(['source.json']);
    });

    it('refuses null source as validation before materialization effects', async (context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-materializer-null-source-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const sourcePath = path.join(directory, 'source.json');
        await writeFile(sourcePath, 'null\n');
        await expect(runMaterializer(context, {
            ...materializerInvocationDefaults,
            sourcePath,
            outputPath: path.join(directory, 'output.json'),
            recordPath: path.join(directory, 'record.json')
        })).rejects.toMatchObject({ stderr: expect.stringContaining('manifest.group must be an object.') });
        await expect(readFile(path.join(directory, 'output.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(path.join(directory, 'record.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await readdir(directory)).sort()).toEqual(['source.json']);
        expect(await readFile(sourcePath, 'utf8')).toBe('null\n');
    });

    it('removes its atomic temporary after rename refusal while preserving the existing destination', async (context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-materializer-rename-failure-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const sourcePath = path.join(directory, 'source.json');
        const outputPath = path.join(directory, 'destination');
        const recordPath = path.join(directory, 'record.json');
        const sourceText = `${JSON.stringify(await readCaptureManifestFixture({ groupId: 'owned-room', captureMode: 'off' }))}\n`;
        await writeFile(sourcePath, sourceText);
        await mkdir(outputPath);
        await writeFile(path.join(outputPath, 'sentinel.txt'), 'owned-existing-destination\n');
        await expect(runMaterializer(context, {
            ...materializerInvocationDefaults,
            sourcePath,
            outputPath,
            recordPath,
            agentSource: 'external'
        })).rejects.toBeInstanceOf(Error);
        expect.soft(await readFile(path.join(outputPath, 'sentinel.txt'), 'utf8')).toBe('owned-existing-destination\n');
        expect.soft(await readdir(outputPath)).toEqual(['sentinel.txt']);
        expect.soft((await readdir(directory)).sort()).toEqual(['destination', 'source.json']);
        await expect.soft(readFile(recordPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(sourcePath, 'utf8')).toBe(sourceText);
    });

    it.for(['accepted', 'refused'] as const)('RUN forwarding actual controller create request is the exact manifest when %s', async (disposition, context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-controller-run-port-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const sourcePath = path.join(directory, 'source.json');
        const outputPath = path.join(directory, 'materialized.json');
        const recordPath = path.join(directory, 'record.json');
        const sourceText = `${JSON.stringify(await readCaptureManifestFixture({ groupId: 'off', captureMode: 'native' }))}\n`;
        await writeFile(sourcePath, sourceText);
        await runMaterializer(context, {
            ...materializerInvocationDefaults,
            sourcePath,
            outputPath,
            recordPath,
            agentSource: 'external',
            rtcCaptureMode: 'off'
        });
        const materialized = await readManifest(outputPath);
        const bin = path.join(directory, 'bin');
        const temporaryPosts = path.join(directory, 'post-temporaries');
        await mkdir(bin);
        await mkdir(temporaryPosts);
        const bodyPath = path.join(directory, 'actual-create-body.json');
        const tempRecord = path.join(directory, 'temp-paths.txt');
        const envPath = path.join(directory, 'control.env');
        await writeFile(envPath, '');
        const scripts = {
            id: '#!/usr/bin/env bash\n[[ "$1" == "-u" ]] || exit 91\nprintf "0\\n"\n',
            mktemp: [
                '#!/usr/bin/env bash',
                'set -euo pipefail',
                'template="$1"',
                'case "$template" in /tmp/rallar-control-post*) template="${OWNED_POST_TEMP}/${template##*/}" ;; esac',
                'created="$(/usr/bin/mktemp "$template")"',
                'printf "%s\\n" "$created" >> "$OWNED_TEMP_RECORD"',
                'printf "%s\\n" "$created"',
                ''
            ].join('\n'),
            curl: [
                '#!/usr/bin/env bash',
                'set -euo pipefail',
                'output=""; body=""; method="GET"; url=""',
                'while [[ $# -gt 0 ]]; do',
                '  case "$1" in',
                '    -o) output="$2"; shift 2 ;;',
                '    --data-binary) body="${2#@}"; shift 2 ;;',
                '    -X) method="$2"; shift 2 ;;',
                '    -H|-w) shift 2 ;;',
                '    -*) shift ;;',
                '    *) url="$1"; shift ;;',
                '  esac',
                'done',
                '[[ "$url" == http://127.0.0.1:5180/* ]] || exit 92',
                'if [[ "$method" == "POST" && "$url" == http://127.0.0.1:5180/distributed-runs ]]; then',
                '  [[ -r "$body" ]] || exit 93',
                '  cp "$body" "$OWNED_CREATE_BODY"',
                '  if [[ "$OWNED_CREATE_DISPOSITION" == "refused" ]]; then',
                '    printf \'{"error":"owned create refusal"}\' > "$output"',
                '    printf "400"',
                '    exit 0',
                '  fi',
                'fi',
                'reply=\'{"state":"passed","files":{}}\'',
                'if [[ -n "$output" ]]; then printf "%s" "$reply" > "$output"; printf "200"; else printf "%s" "$reply"; fi',
                ''
            ].join('\n')
        };
        for (const [name, contents] of Object.entries(scripts)) {
            await writeFile(path.join(bin, name), contents);
            await chmod(path.join(bin, name), 0o755);
        }
        const result = await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [path.join(repoRoot, 'scripts/hosted-rallar/controller/14-run-distributed-recipe.sh')],
            options: {
                cwd: directory,
                env: {
                    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
                    TMPDIR: directory,
                    RALLAR_CONTROL_HTTP_URL: 'http://127.0.0.1:5180',
                    RALLAR_CONTROL_ENV_FILE: envPath,
                    RALLAR_BLACK_BOX_ADMIN_TOKEN: 'owned-test-token',
                    RALLAR_DISTRIBUTED_MANIFEST_PATH: outputPath,
                    RALLAR_DISTRIBUTED_ARTIFACT_DIR: path.join(directory, 'artifacts'),
                    RALLAR_DISTRIBUTED_RUN_ID: materialized.distributedRunId,
                    RALLAR_DISTRIBUTED_CONTROL_RUN_ID: materialized.controlRunId,
                    RALLAR_BLACK_BOX_APPLICATION_ID: materialized.group.applicationId,
                    RALLAR_BLACK_BOX_WORKSPACE_ID: materialized.group.workspaceId,
                    RALLAR_BLACK_BOX_ROOM_ID: materialized.group.groupId,
                    RALLAR_DISTRIBUTED_READY_TIMEOUT_SECONDS: '1',
                    RALLAR_DISTRIBUTED_TERMINAL_TIMEOUT_SECONDS: '1',
                    RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: 'signaling',
                    OWNED_POST_TEMP: temporaryPosts,
                    OWNED_TEMP_RECORD: tempRecord,
                    OWNED_CREATE_BODY: bodyPath,
                    OWNED_CREATE_DISPOSITION: disposition
                }
            }
        }).then((output) => ({ output, error: undefined }), (error: unknown) => ({ output: undefined, error }));
        const body: unknown = JSON.parse(await readFile(bodyPath, 'utf8'));
        console.info('RUN-controller-request-evidence', JSON.stringify({ disposition, body, result, remainingPostTemporaries: await readdir(temporaryPosts) }));
        expect.soft(body).toEqual({ manifest: materialized });
        expect.soft(body).toHaveProperty('manifest.rtcCaptureMode', 'off');
        if (disposition === 'accepted') {
            expect.soft(result.error).toBeUndefined();
        }
        else {
            expect.soft(result.error).toBeInstanceOf(Error);
        }
        expect(await readdir(temporaryPosts)).toEqual([]);
        const createdTemporaries = (await readFile(tempRecord, 'utf8')).trim().split('\n');
        for (const file of createdTemporaries) {
            expect(file.startsWith(directory)).toBe(true);
            await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
        }
        expect(await readFile(sourcePath, 'utf8')).toBe(sourceText);
    });

    it.for(
        [
            { label: 'omitted', transport: undefined, expected: 'native', authored: 'native' },
            { label: 'blank', transport: '', expected: 'native', authored: 'native' },
            { label: 'whitespace', transport: ' \t ', expected: 'native', authored: 'native' },
            { label: 'off', transport: 'off', expected: 'off', authored: 'native' },
            { label: 'signaling', transport: 'signaling', expected: 'signaling', authored: 'off' },
            { label: 'native', transport: 'native', expected: 'native', authored: 'off' }
        ] as const
    )('RUN forwarding materializer $label preserves lower authored intent', async (input, context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-run-materializer-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const fixture = await readCaptureManifestFixture({ groupId: 'off', captureMode: 'native' });
        const source = {
            ...fixture,
            rtcCaptureMode: input.authored,
            recipes: fixture.recipes.map((selection) => {
                if (!selection.recipe) {
                    throw new Error('Capture fixture requires an inline recipe.');
                }
                return {
                    ...selection,
                    recipe: {
                        ...selection.recipe,
                        rtcCaptureMode: 'off' as const,
                        commands: selection.recipe.commands.map((command) =>
                            command.kind === 'configure'
                                ? { ...command, config: { ...command.config, rallar: { rtc: { captureMode: 'signaling' as const } } } }
                                : command
                        )
                    }
                };
            })
        };
        const sourcePath = path.join(directory, 'source.json');
        const outputPath = path.join(directory, 'output.json');
        const recordPath = path.join(directory, 'record.json');
        const sourceText = `${JSON.stringify(source, null, 2)}\n`;
        await writeFile(sourcePath, sourceText);
        const result = await runMaterializer(context, {
            ...materializerInvocationDefaults,
            sourcePath,
            outputPath,
            recordPath,
            agentSource: 'external',
            rtcCaptureMode: input.transport
        });
        const output = await readManifest(outputPath);
        const outputText = await readFile(outputPath, 'utf8');
        console.info(
            'RUN-materializer-evidence',
            JSON.stringify({ label: input.label, argv: result.argv, output, record: JSON.parse(await readFile(recordPath, 'utf8')) })
        );
        expect.soft(output.rtcCaptureMode).toBe(input.expected);
        expect(output.recipes).toEqual(source.recipes);
        expect(output.group).toEqual(source.group);
        expect(await readFile(sourcePath, 'utf8')).toBe(sourceText);
        expect(JSON.parse(await readFile(recordPath, 'utf8'))).toMatchObject({
            sourceManifestSha256: createHash('sha256').update(sourceText).digest('hex'),
            materializedManifestSha256: createHash('sha256').update(outputText).digest('hex')
        });
    });

    it.for([
        { mode: 'bogus', destination: 'absent' },
        { mode: 'OFF', destination: 'absent' },
        { mode: ' native ', destination: 'absent' },
        { mode: 'bogus', destination: 'existing' },
        { mode: 'OFF', destination: 'existing' },
        { mode: ' native ', destination: 'existing' }
    ])('RUN forwarding materializer refuses $mode with $destination outputs', async (input, context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-invalid-run-materializer-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const sourcePath = path.join(directory, 'source.json');
        const outputPath = path.join(directory, 'output.json');
        const recordPath = path.join(directory, 'record.json');
        const sourceText = `${JSON.stringify(await readCaptureManifestFixture({ groupId: 'native', captureMode: 'off' }))}\n`;
        await writeFile(sourcePath, sourceText);
        if (input.destination === 'existing') {
            await writeFile(outputPath, 'owned-output-sentinel\n');
            await writeFile(recordPath, 'owned-record-sentinel\n');
        }
        const result = await runMaterializer(context, {
            ...materializerInvocationDefaults,
            sourcePath,
            outputPath,
            recordPath,
            rtcCaptureMode: input.mode
        }).then((output) => ({ output, error: undefined }), (error: unknown) => ({ output: undefined, error }));
        console.info('RUN-materializer-refusal-evidence', JSON.stringify({ input, result, files: await readdir(directory) }));
        expect.soft(result.error).toBeInstanceOf(Error);
        if (input.destination === 'existing') {
            expect.soft(await readFile(outputPath, 'utf8')).toBe('owned-output-sentinel\n');
            expect.soft(await readFile(recordPath, 'utf8')).toBe('owned-record-sentinel\n');
        }
        else {
            await expect.soft(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect.soft(readFile(recordPath)).rejects.toMatchObject({ code: 'ENOENT' });
        }
        expect(await readFile(sourcePath, 'utf8')).toBe(sourceText);
        expect((await readdir(directory)).sort()).toEqual(input.destination === 'existing' ? ['output.json', 'record.json', 'source.json'] : ['source.json']);
    });

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
