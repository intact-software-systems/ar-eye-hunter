import {spawn} from 'node:child_process';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const scenarioCliPath = fileURLToPath(
    new URL('../../shared-test/black-box-runner/scenario-black-box.ts', import.meta.url),
);

async function writeTempConfig(config: unknown): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'scenario-black-box-'));

    await writeFile(
        path.join(dir, 'config.json'),
        JSON.stringify(config, null, 2),
    );

    return dir;
}

async function runScenarioCli(args: string[], env: Record<string, string | undefined> = {}): Promise<{
    code: number;
    stdout: string;
    stderr: string;
}> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            'deno',
            ['run', '-A', scenarioCliPath, ...args],
            {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    ...env,
                },
            },
        );

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', chunk => {
            stdout += chunk.toString();
        });

        child.stderr.on('data', chunk => {
            stderr += chunk.toString();
        });

        child.on('error', reject);

        child.on('close', code => {
            resolve({
                code: code ?? 0,
                stdout,
                stderr,
            });
        });
    });
}

describe('scenario-black-box CLI', () => {
    it('explains a valid recipe without executing network calls', async () => {
        const workingDirectory = await writeTempConfig({
            variables: {
                apiBaseUrl: 'http://localhost:8080',
            },
            connections: {
                api: {
                    type: 'http',
                    baseUrl: '{apiBaseUrl}',
                },
            },
            steps: [
                {
                    name: 'health',
                    type: 'http',
                    connection: 'api',
                    request: {
                        method: 'GET',
                        path: '/health',
                    },
                    expect: {
                        status: 200,
                    },
                },
            ],
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--explain',
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const preflight = JSON.parse(result.stdout);

        expect(preflight.ok).toBe(true);
        expect(preflight.profile).toBe('compat');
        expect(preflight.summary.generatedOperationCount).toBe(1);
        expect(preflight.providerModes).toContain('http');
        expect(preflight.connections).toMatchObject({
            defined: ['api'],
            referenced: ['api'],
            missing: [],
        });
        expect(preflight.operations[0]).toMatchObject({
            name: 'health',
            transport: 'HTTP',
            connection: 'api',
            path: 'http://localhost:8080/health',
        });
    });

    it('validates missing env vars and missing connections before execution', async () => {
        const workingDirectory = await writeTempConfig({
            variables: {
                apiToken: {
                    env: 'RALLAR_BB_REQUIRED_PREFLIGHT_TOKEN',
                    required: true,
                    secret: true,
                },
            },
            steps: [
                {
                    name: 'sendWs',
                    type: 'ws.send',
                    connection: 'missingWs',
                    request: {
                        send: {
                            token: '{apiToken}',
                        },
                    },
                },
            ],
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--validate',
        ], {
            RALLAR_BB_REQUIRED_PREFLIGHT_TOKEN: undefined,
        });

        expect(result.code).toBe(1);
        expect(result.stderr).toBe('');

        const preflight = JSON.parse(result.stdout);

        expect(preflight.ok).toBe(false);
        expect(preflight.env.missing).toEqual([expect.objectContaining({
            envName: 'RALLAR_BB_REQUIRED_PREFLIGHT_TOKEN',
            variableName: 'apiToken',
        })]);
        expect(preflight.connections.missing).toEqual(['missingWs']);
        expect(preflight.issues.map((issue: { code: string }) => issue.code)).toEqual(expect.arrayContaining([
            'MISSING_ENV',
            'MISSING_CONNECTION',
        ]));
        expect(result.stdout).not.toContain('<missing:RALLAR_BB_REQUIRED_PREFLIGHT_TOKEN>');
    });

    it('explains missing traffic-plan step references even when expansion fails', async () => {
        const workingDirectory = await writeTempConfig({
            execution: {
                trafficPlan: {
                    seed: 17,
                    count: 2,
                    setupSteps: ['connectMissing'],
                    operations: [
                        {
                            name: 'set-ok',
                            steps: ['setOk'],
                        },
                    ],
                },
            },
            steps: [
                {
                    name: 'setOk',
                    type: 'set',
                    output: 'ok',
                    value: true,
                },
            ],
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--explain',
        ]);

        expect(result.code).toBe(1);
        expect(result.stderr).toBe('');

        const preflight = JSON.parse(result.stdout);

        expect(preflight.ok).toBe(false);
        expect(preflight.stepReferences.missing).toEqual([expect.objectContaining({
            name: 'connectMissing',
            path: 'execution.trafficPlan.setupSteps[0]',
        })]);
        expect(preflight.issues.map((issue: { code: string }) => issue.code)).toEqual(expect.arrayContaining([
            'MISSING_STEP_REFERENCE',
            'PLAN_EXPANSION_FAILED',
        ]));
    });

    it('explains seeded traffic-plan expansion without executing the generated steps', async () => {
        const workingDirectory = await writeTempConfig({
            execution: {
                trafficPlan: {
                    seed: 20260601,
                    count: 3,
                    setupSteps: ['setup'],
                    cleanupSteps: ['cleanup'],
                    operations: [
                        {
                            name: 'left',
                            weight: 1,
                            steps: ['sendLeft'],
                        },
                    ],
                },
            },
            steps: [
                {
                    name: 'setup',
                    type: 'set',
                    output: 'setup',
                    value: true,
                },
                {
                    name: 'sendLeft',
                    type: 'set',
                    output: 'sent{traffic.sequence}',
                    value: {
                        sequence: '{traffic.sequence}',
                        operation: '{traffic.operation}',
                    },
                },
                {
                    name: 'cleanup',
                    type: 'set',
                    output: 'cleanup',
                    value: true,
                },
            ],
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--explain',
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const preflight = JSON.parse(result.stdout);

        expect(preflight.ok).toBe(true);
        expect(preflight.trafficPlan).toMatchObject({
            enabled: true,
            replay: false,
            seed: 20260601,
            decisionCount: 3,
            stepCount: 5,
        });
        expect(preflight.summary.generatedOperationCount).toBe(5);
        expect(preflight.operations.map((operation: { name: string }) => operation.name)).toEqual([
            'setup',
            'sendLeft',
            'sendLeft',
            'sendLeft',
            'cleanup',
        ]);
    });

    it('supports strict profile validation for known step types', async () => {
        const workingDirectory = await writeTempConfig({
            steps: [
                {
                    name: 'badSet',
                    type: 'set',
                    value: 'missing output',
                },
            ],
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--explain',
            '--strict',
        ]);

        expect(result.code).toBe(1);
        expect(result.stderr).toBe('');

        const preflight = JSON.parse(result.stdout);

        expect(preflight.profile).toBe('strict');
        expect(preflight.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'STRICT_SET_OUTPUT',
                severity: 'error',
            }),
        ]));
    });

    it('runs config file with SET and ASSERT steps', async () => {
        const workingDirectory = await writeTempConfig({
            variables: {
                tokenType: 'Bearer',
                token: 'abc-123',
            },
            execution: {
                failFast: true,
            },
            steps: [
                {
                    name: 'deriveAuth',
                    type: 'set',
                    output: 'auth',
                    value: {
                        body: {
                            token_type: '{tokenType}',
                            access_token: '{token}',
                        },
                    },
                },
                {
                    name: 'deriveAuthHeader',
                    type: 'set',
                    output: 'authHeader',
                    value: '{auth.body.token_type} {auth.body.access_token}',
                },
                {
                    name: 'assertAuthHeader',
                    type: 'assert',
                    actual: '{authHeader}',
                    expect: {
                        body: 'Bearer abc-123',
                    },
                },
            ],
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);

        expect(report.summary.failure).toBe(0);
        expect(report.summary.success).toBe(3);
        expect(report.outputs.authHeader).toBe('Bearer abc-123');
        expect(report.resultsByName.assertAuthHeader[0].status).toBe('SUCCESS');
    });

    it('exits with code 1 when config assertion fails', async () => {
        const workingDirectory = await writeTempConfig({
            execution: {
                failFast: true,
            },
            steps: [
                {
                    name: 'assertFails',
                    type: 'assert',
                    actual: {
                        id: 'not-an-integer',
                    },
                    expect: {
                        body: {
                            id: 'integer',
                        },
                    },
                },
            ],
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
        ]);

        expect(result.code).toBe(1);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);

        expect(report.summary.failure).toBe(1);
        expect(report.summary.firstFailure.name).toBe('assertFails');
        expect(report.resultsByName.assertFails[0].status).toBe('FAILURE');
    });

    it('supports failFast false from config file', async () => {
        const workingDirectory = await writeTempConfig({
            execution: {
                failFast: false,
            },
            steps: [
                {
                    name: 'firstAssertFails',
                    type: 'assert',
                    actual: {
                        id: 'not-an-integer',
                    },
                    expect: {
                        body: {
                            id: 'integer',
                        },
                    },
                },
                {
                    name: 'setAfterFailure',
                    type: 'set',
                    output: 'afterFailure',
                    value: 'still-runs',
                },
            ],
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
        ]);

        expect(result.code).toBe(1);

        const report = JSON.parse(result.stdout);

        expect(report.summary.failure).toBe(1);
        expect(report.summary.success).toBe(1);
        expect(report.outputs.afterFailure).toBe('still-runs');
    });

    it('dry mode prints executable interactions from config file', async () => {
        const workingDirectory = await writeTempConfig({
            variables: {
                roomId: 'room-1',
            },
            connections: {
                aliceWs: {
                    type: 'ws',
                    url: 'ws://localhost:8080/ws',
                },
            },
            steps: [
                {
                    name: 'connectAlice',
                    type: 'ws.connect',
                    connection: 'aliceWs',
                },
                {
                    name: 'aliceSendsJoin',
                    type: 'ws.send',
                    connection: 'aliceWs',
                    request: {
                        send: {
                            type: 'room.join',
                            roomId: '{roomId}',
                        },
                    },
                },
            ],
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '-e',
            'dry',
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const interactions = JSON.parse(result.stdout);

        expect(Array.isArray(interactions)).toBe(true);
        expect(interactions.length).toBe(2);

        expect(interactions[0].WS.request.action).toBe('connect');
        expect(interactions[0].WS.request.connection).toBe('aliceWs');
        expect(interactions[0].WS.request.path).toBe('ws://localhost:8080/ws');

        expect(interactions[1].WS.request.action).toBe('send');
        expect(interactions[1].WS.request.send).toEqual({
            type: 'room.join',
            roomId: 'room-1',
        });
    });

    it('dry-run option returns report instead of executable interactions', async () => {
        const workingDirectory = await writeTempConfig({
            variables: {
                roomId: 'room-1',
            },
            connections: {
                aliceRtc: {
                    type: 'rtc',
                    provider: 'unknown-rtc-provider',
                    actor: 'alice',
                    peerId: 'alice',
                    roomId: '{roomId}',
                },
            },
            steps: [
                {
                    name: 'connectAlice',
                    type: 'rtc.connect',
                    connection: 'aliceRtc',
                },
            ],
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--dry-run',
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);

        expect(Array.isArray(report)).toBe(false);
        expect(report.summary.failure).toBe(0);
        expect(report.summary.success).toBe(1);
        expect(report.resultsByName.connectAlice[0].status).toBe('SUCCESS');
        expect(report.resultsByName.connectAlice[0].actual.dryRun).toBe(true);
        expect(report.resultsByName.connectAlice[0].actual.normalized.provider).toBe('unknown-rtc-provider');
        expect(report.resultsByName.connectAlice[0].actual.normalized.roomId).toBe('room-1');
    });

    it('dry-run RTC send exposes synthetic output fields for downstream asserts', async () => {
        const workingDirectory = await writeTempConfig({
            connections: {
                aliceRtc: {
                    type: 'rtc',
                    provider: 'unknown-rtc-provider',
                    actor: 'alice',
                    peerId: 'alice',
                    roomId: 'room-1',
                },
                bobRtc: {
                    type: 'rtc',
                    provider: 'unknown-rtc-provider',
                    actor: 'bob',
                    peerId: 'bob',
                    roomId: 'room-1',
                },
            },
            steps: [
                {
                    name: 'aliceSendsToBob',
                    type: 'rtc.send',
                    connection: 'aliceRtc',
                    request: {
                        send: {
                            topic: 'chat.message',
                            payload: {
                                text: 'hello bob',
                            },
                        },
                        outputs: {
                            sendStatus: 'sendResult.status',
                            deliveredPayload: 'matchedMessage.data.payload',
                        },
                    },
                    expect: {
                        connection: 'bobRtc',
                        message: {
                            topic: 'chat.message',
                            payload: {
                                text: 'hello bob',
                            },
                        },
                    },
                },
                {
                    name: 'assertDryRunOutputs',
                    type: 'assert',
                    actual: {
                        sendStatus: '{sendStatus}',
                        deliveredPayload: '{deliveredPayload}',
                    },
                    expect: {
                        body: {
                            sendStatus: 'sent',
                            deliveredPayload: {
                                text: 'hello bob',
                            },
                        },
                    },
                },
            ],
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--dry-run',
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);

        expect(report.summary.failure).toBe(0);
        expect(report.outputs.sendStatus).toBe('sent');
        expect(report.outputs.deliveredPayload).toEqual({
            text: 'hello bob',
        });
        expect(report.resultsByName.aliceSendsToBob[0].actual.dryRun).toBe(true);
        expect(report.resultsByName.aliceSendsToBob[0].actual.sendResult).toEqual({
            status: 'sent',
            dryRun: true,
        });
    });

    it('short dry-run option returns report instead of executable interactions', async () => {
        const workingDirectory = await writeTempConfig({
            connections: {
                aliceRtc: {
                    type: 'rtc',
                    provider: 'unknown-rtc-provider',
                    actor: 'alice',
                    peerId: 'alice',
                    roomId: 'room-1',
                },
            },
            steps: [
                {
                    name: 'connectAlice',
                    type: 'rtc.connect',
                    connection: 'aliceRtc',
                },
            ],
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '-n',
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);

        expect(Array.isArray(report)).toBe(false);
        expect(report.summary.failure).toBe(0);
        expect(report.summary.success).toBe(1);
        expect(report.resultsByName.connectAlice[0].status).toBe('SUCCESS');
        expect(report.resultsByName.connectAlice[0].actual.dryRun).toBe(true);
    });

    it('applies command-line replacements over config variables', async () => {
        const workingDirectory = await writeTempConfig({
            variables: {
                token: 'from-config',
            },
            steps: [
                {
                    name: 'setToken',
                    type: 'set',
                    output: 'tokenValue',
                    value: '{token}',
                },
                {
                    name: 'assertToken',
                    type: 'assert',
                    actual: '{tokenValue}',
                    expect: {
                        body: 'from-cli',
                    },
                },
            ],
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '-r',
            'token:=from-cli',
        ]);

        expect(result.code).toBe(0);

        const report = JSON.parse(result.stdout);

        expect(report.summary.failure).toBe(0);
        expect(report.outputs.tokenValue).toBe('from-cli');
    });

    it('resolves environment variables and redacts secret values in reports', async () => {
        const workingDirectory = await writeTempConfig({
            variables: {
                apiToken: {
                    env: 'BLACK_BOX_TEST_API_TOKEN',
                    required: true,
                    secret: true,
                },
            },
            steps: [
                {
                    name: 'deriveAuthHeader',
                    type: 'set',
                    output: 'authHeader',
                    value: 'Bearer {apiToken}',
                },
                {
                    name: 'assertRedactedHeader',
                    type: 'assert',
                    actual: '{authHeader}',
                    expect: {
                        body: 'Bearer secret-token-123',
                    },
                },
            ],
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
        ], {
            BLACK_BOX_TEST_API_TOKEN: 'secret-token-123',
        });

        expect(result.code).toBe(0);
        expect(result.stdout).not.toContain('secret-token-123');

        const report = JSON.parse(result.stdout);

        expect(report.summary.failure).toBe(0);
        expect(report.outputs.authHeader).toBe('Bearer <redacted:apiToken>');
        expect(report.resultsByName.assertRedactedHeader[0].actual).toBe('Bearer <redacted:apiToken>');
    });

    it('writes redacted report, event stream, and failure artifacts', async () => {
        const workingDirectory = await writeTempConfig({
            variables: {
                apiToken: {
                    env: 'BLACK_BOX_TEST_API_TOKEN',
                    required: true,
                    secret: true,
                },
            },
            execution: {
                failFast: false,
            },
            steps: [
                {
                    name: 'deriveAuthHeader',
                    type: 'set',
                    output: 'authHeader',
                    value: 'Bearer {apiToken}',
                },
                {
                    name: 'assertSecretHeaderFails',
                    type: 'assert',
                    actual: '{authHeader}',
                    expect: {
                        body: 'Bearer expected-token',
                    },
                },
            ],
        });
        const artifactDir = path.join(workingDirectory, 'artifacts');

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--artifact-dir',
            artifactDir,
        ], {
            BLACK_BOX_TEST_API_TOKEN: 'secret-token-123',
        });

        expect(result.code).toBe(1);

        const reportText = await readFile(path.join(artifactDir, 'report.json'), 'utf8');
        const eventsText = await readFile(path.join(artifactDir, 'events.jsonl'), 'utf8');
        const failuresText = await readFile(path.join(artifactDir, 'failures.json'), 'utf8');
        const metadataText = await readFile(path.join(artifactDir, 'metadata.json'), 'utf8');
        const artifactText = [
            reportText,
            eventsText,
            failuresText,
            metadataText,
        ].join('\n');

        expect(artifactText).not.toContain('secret-token-123');

        const report = JSON.parse(reportText);
        const failures = JSON.parse(failuresText);
        const metadata = JSON.parse(metadataText);
        const events = eventsText
            .trim()
            .split('\n')
            .map(line => JSON.parse(line));

        expect(report.summary.failure).toBe(1);
        expect(failures.summary.failure).toBe(1);
        expect(failures.failures[0].name).toBe('assertSecretHeaderFails');
        expect(failures.failures[0].actual).toBe('Bearer <redacted:apiToken>');
        expect(events.some(event => event.kind === 'step-result' && event.name === 'assertSecretHeaderFails'))
            .toBe(true);
        expect(metadata.summary.failure).toBe(1);
        expect(metadata.command.join(' ')).toContain('--artifact-dir');
    });

    it('runs scale iterations and writes aggregate artifacts', async () => {
        const workingDirectory = await writeTempConfig({
            steps: [
                {
                    name: 'setValue',
                    type: 'set',
                    output: 'value',
                    value: 'ok',
                },
                {
                    name: 'assertValue',
                    type: 'assert',
                    actual: '{value}',
                    expect: {
                        body: 'ok',
                    },
                },
            ],
        });
        const artifactDir = path.join(workingDirectory, 'scale-artifacts');

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--iterations',
            '2',
            '--artifact-dir',
            artifactDir,
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);

        expect(report.summary.runs).toBe(2);
        expect(report.summary.passedRuns).toBe(2);
        expect(report.summary.failedRuns).toBe(0);
        expect(report.summary.total).toBe(4);
        expect(report.resultsByName.setValue).toHaveLength(2);
        expect(report.resultsByName.assertValue).toHaveLength(2);
        expect(report.resultsByName.setValue[0].runIndex).toBe(1);
        expect(report.resultsByName.setValue[1].runIndex).toBe(2);
        expect(report.outputsByRun['1'].value).toBe('ok');
        expect(report.outputsByRun['2'].value).toBe('ok');
        expect(report.metrics.byTransport.SET).toBe(2);
        expect(report.metrics.byTransport.ASSERT).toBe(2);
        expect(report.metrics.latencyMs.runDuration.count).toBe(2);

        const reportText = await readFile(path.join(artifactDir, 'report.json'), 'utf8');
        const eventsText = await readFile(path.join(artifactDir, 'events.jsonl'), 'utf8');
        const metadataText = await readFile(path.join(artifactDir, 'metadata.json'), 'utf8');
        const artifactReport = JSON.parse(reportText);
        const metadata = JSON.parse(metadataText);
        const events = eventsText
            .trim()
            .split('\n')
            .map(line => JSON.parse(line));

        expect(artifactReport.summary.runs).toBe(2);
        expect(metadata.summary.runs).toBe(2);
        expect(events.filter(event => event.kind === 'step-result')).toHaveLength(4);
        expect(events.every(event => event.kind !== 'step-result' || event.runIndex === 1 || event.runIndex === 2))
            .toBe(true);
    });

    it('runs same-connection soak loops and writes bounded artifacts', async () => {
        const workingDirectory = await writeTempConfig({
            variables: {
                roomId: 'soak-room',
            },
            execution: {
                failFast: true,
                soak: {
                    iterations: 3,
                    delayMs: 1,
                    maxArtifactEvents: 5,
                    setupSteps: [
                        'connectAlice',
                        'connectBob',
                    ],
                    loopSteps: [
                        'aliceSendsToBob',
                        'bobSendsToAlice',
                    ],
                    cleanupSteps: [
                        'closeAlice',
                        'closeBob',
                    ],
                },
            },
            connections: {
                aliceRtc: {
                    type: 'rtc',
                    provider: 'rallar-memory',
                    actor: 'alice',
                    peerId: 'alice',
                    roomId: '{roomId}',
                    remotePeerId: 'bob',
                },
                bobRtc: {
                    type: 'rtc',
                    provider: 'rallar-memory',
                    actor: 'bob',
                    peerId: 'bob',
                    roomId: '{roomId}',
                    remotePeerId: 'alice',
                },
            },
            steps: [
                {
                    name: 'connectAlice',
                    type: 'rtc.connect',
                    connection: 'aliceRtc',
                },
                {
                    name: 'connectBob',
                    type: 'rtc.connect',
                    connection: 'bobRtc',
                },
                {
                    name: 'aliceSendsToBob',
                    type: 'rtc.send',
                    connection: 'aliceRtc',
                    request: {
                        send: {
                            topic: 'soak.alice',
                            toPeerId: 'bob',
                            payload: {
                                text: 'ping bob',
                            },
                        },
                    },
                    expect: {
                        connection: 'bobRtc',
                        withinMs: 1000,
                        consume: true,
                        message: {
                            topic: 'soak.alice',
                            toPeerId: 'bob',
                            payload: {
                                text: 'ping bob',
                            },
                        },
                    },
                },
                {
                    name: 'bobSendsToAlice',
                    type: 'rtc.send',
                    connection: 'bobRtc',
                    request: {
                        send: {
                            topic: 'soak.bob',
                            toPeerId: 'alice',
                            payload: {
                                text: 'ping alice',
                            },
                        },
                    },
                    expect: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        consume: true,
                        message: {
                            topic: 'soak.bob',
                            toPeerId: 'alice',
                            payload: {
                                text: 'ping alice',
                            },
                        },
                    },
                },
                {
                    name: 'closeAlice',
                    type: 'rtc.close',
                    connection: 'aliceRtc',
                },
                {
                    name: 'closeBob',
                    type: 'rtc.close',
                    connection: 'bobRtc',
                },
            ],
        });
        const artifactDir = path.join(workingDirectory, 'soak-artifacts');

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--artifact-dir',
            artifactDir,
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);

        expect(report.summary.failure).toBe(0);
        expect(report.summary.soak).toMatchObject({
            sameConnection: true,
            iterations: 3,
            setupStepCount: 2,
            loopStepCount: 2,
            cleanupStepCount: 2,
            maxArtifactEvents: 5,
        });
        expect(report.resultsByName.connectAlice).toHaveLength(1);
        expect(report.resultsByName.connectBob).toHaveLength(1);
        expect(report.resultsByName.aliceSendsToBob).toHaveLength(3);
        expect(report.resultsByName.bobSendsToAlice).toHaveLength(3);
        expect(report.resultsByName.closeAlice).toHaveLength(1);
        expect(report.resultsByName.closeBob).toHaveLength(1);
        expect(report.metrics.soak.sameConnection).toBe(true);
        expect(report.metrics.soak.iterationsObserved).toBe(3);
        expect(report.metrics.soak.sends.attempted).toBe(6);
        expect(report.metrics.soak.cleanup.closeSuccess).toBe(2);
        expect(report.metrics.soak.reconnects).toBe(0);

        const eventsText = await readFile(path.join(artifactDir, 'events.jsonl'), 'utf8');
        const events = eventsText
            .trim()
            .split('\n')
            .map(line => JSON.parse(line));

        expect(events).toHaveLength(6);
        expect(events.at(-1)).toMatchObject({
            kind: 'artifact-truncated',
            emittedEvents: 5,
        });
    });

    it('caps soak loop execution with messageCount', async () => {
        const workingDirectory = await writeTempConfig({
            execution: {
                soak: {
                    messageCount: 5,
                    loopSteps: [
                        'loopA',
                        'loopB',
                    ],
                },
            },
            steps: [
                {
                    name: 'loopA',
                    type: 'set',
                    output: 'loopAValue',
                    value: 'a',
                },
                {
                    name: 'loopB',
                    type: 'set',
                    output: 'loopBValue',
                    value: 'b',
                },
            ],
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);

        expect(report.summary.total).toBe(5);
        expect(report.summary.soak).toMatchObject({
            iterations: 3,
            requestedMessageCount: 5,
            loopStepCount: 2,
        });
        expect(report.resultsByName.loopA).toHaveLength(3);
        expect(report.resultsByName.loopB).toHaveLength(2);
        expect(report.resultsByName.loopA.map((result: { repeatIndex: number }) => result.repeatIndex))
            .toEqual([1, 2, 3]);
        expect(report.resultsByName.loopB.map((result: { repeatIndex: number }) => result.repeatIndex))
            .toEqual([1, 2]);
    });

    it('expands inline loop steps with deterministic pacing metadata', async () => {
        const workingDirectory = await writeTempConfig({
            steps: [
                {
                    name: 'positionLoop',
                    type: 'loop',
                    count: 3,
                    intervalMs: 1,
                    steps: [
                        {
                            name: 'frame{loop.index}',
                            type: 'set',
                            output: 'frame{loop.index}',
                            value: {
                                index: '{loop.index}',
                                iteration: '{loop.iteration}',
                                stepIndex: '{loop.stepIndex}',
                                count: '{loop.count}',
                                elapsedMs: '{loop.elapsedMs}',
                            },
                        },
                    ],
                },
            ],
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);

        expect(report.summary).toMatchObject({
            total: 5,
            success: 5,
            failure: 0,
        });
        expect(report.outputs.frame1).toEqual({
            index: 1,
            iteration: 1,
            stepIndex: 1,
            count: 3,
            elapsedMs: 0,
        });
        expect(report.outputs.frame2.iteration).toBe(2);
        expect(report.outputs.frame3.elapsedMs).toBe(2);
        expect(report.resultsByName.positionLoopDelay).toHaveLength(2);
        expect(report.resultsByName.positionLoopDelay.map((entry: { delayMs: number }) => entry.delayMs))
            .toEqual([1, 1]);
        expect(report.resultsList.map((entry: { name: string }) => entry.name))
            .toEqual(['frame1', 'positionLoopDelay', 'frame2', 'positionLoopDelay', 'frame3']);
    });

    it('expands seeded traffic plans and replays the recorded plan', async () => {
        const workingDirectory = await writeTempConfig({
            execution: {
                trafficPlan: {
                    seed: 20260528,
                    count: 5,
                    operations: [
                        {
                            name: 'alpha',
                            weight: 2,
                            steps: [
                                {
                                    name: 'trafficAlpha{traffic.sequence}',
                                    type: 'set',
                                    output: 'traffic{traffic.sequence}',
                                    value: {
                                        operation: '{traffic.operation}',
                                        sequence: '{traffic.sequence}',
                                        randomInt: '{traffic.randomInt}',
                                    },
                                },
                            ],
                        },
                        {
                            name: 'beta',
                            weight: 1,
                            steps: [
                                {
                                    name: 'trafficBeta{traffic.sequence}',
                                    type: 'set',
                                    output: 'traffic{traffic.sequence}',
                                    value: {
                                        operation: '{traffic.operation}',
                                        sequence: '{traffic.sequence}',
                                        randomInt: '{traffic.randomInt}',
                                    },
                                },
                            ],
                        },
                    ],
                },
            },
            steps: [],
        });
        const artifactDir = path.join(workingDirectory, 'traffic-artifacts');

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--artifact-dir',
            artifactDir,
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);
        const expandedPlan = JSON.parse(await readFile(path.join(artifactDir, 'expanded-plan.json'), 'utf8'));

        expect(report.summary.trafficPlan).toMatchObject({
            seed: 20260528,
            replay: false,
            decisionCount: 5,
            stepCount: 5,
        });
        expect(expandedPlan.decisions).toHaveLength(5);
        expect(expandedPlan.steps).toHaveLength(5);
        expect(expandedPlan.steps[0].name).toMatch(/^traffic/);
        expect(report.outputs.traffic1.sequence).toBe(1);

        await writeFile(
            path.join(workingDirectory, 'replay.json'),
            JSON.stringify({
                execution: {
                    trafficPlan: {
                        replayFrom: 'traffic-artifacts/expanded-plan.json',
                    },
                },
                steps: [],
            }, null, 2),
        );

        const replay = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'replay.json',
        ]);
        const replayReport = JSON.parse(replay.stdout);

        expect(replay.code).toBe(0);
        expect(replayReport.summary.trafficPlan).toMatchObject({
            seed: 20260528,
            replay: true,
            decisionCount: 5,
            stepCount: 5,
        });
        expect(replayReport.resultsList.map((entry: { name: string }) => entry.name))
            .toEqual(report.resultsList.map((entry: { name: string }) => entry.name));
        expect(replayReport.outputs).toEqual(report.outputs);
    });

    it('records traffic plan rate, burst, and max-in-flight pacing in expanded plans', async () => {
        const workingDirectory = await writeTempConfig({
            execution: {
                trafficPlan: {
                    seed: 20260601,
                    count: 5,
                    rateHz: 20,
                    jitterMs: 0,
                    burstSize: 2,
                    maxInFlight: 2,
                    operations: [
                        {
                            name: 'position',
                            weight: 1,
                            steps: [
                                {
                                    name: 'position{traffic.sequence}',
                                    type: 'set',
                                    output: 'position{traffic.sequence}',
                                    value: {
                                        sequence: '{traffic.sequence}',
                                        operation: '{traffic.operation}',
                                    },
                                },
                            ],
                        },
                    ],
                },
            },
            steps: [],
        });
        const artifactDir = path.join(workingDirectory, 'traffic-pacing-artifacts');

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--artifact-dir',
            artifactDir,
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);
        const expandedPlan = JSON.parse(await readFile(path.join(artifactDir, 'expanded-plan.json'), 'utf8'));

        expect(report.summary.trafficPlan).toMatchObject({
            seed: 20260601,
            replay: false,
            decisionCount: 5,
            stepCount: 7,
        });
        expect(expandedPlan.generator.pacing).toMatchObject({
            rateHz: 20,
            intervalMs: 50,
            jitterMs: 0,
            burstSize: 2,
            maxInFlight: 2,
        });
        expect(expandedPlan.decisions.map((decision: { delayMs: number }) => decision.delayMs))
            .toEqual([0, 50, 0, 50, 0]);
        expect(expandedPlan.steps.map((step: { name: string }) => step.name))
            .toEqual([
                'position1',
                'position2',
                'trafficDelay',
                'position3',
                'position4',
                'trafficDelay',
                'position5',
            ]);
        expect(report.resultsByName.trafficDelay.map((entry: { delayMs: number }) => entry.delayMs))
            .toEqual([50, 50]);

        await writeFile(
            path.join(workingDirectory, 'replay-pacing.json'),
            JSON.stringify({
                execution: {
                    trafficPlan: {
                        replayFrom: 'traffic-pacing-artifacts/expanded-plan.json',
                    },
                },
                steps: [],
            }, null, 2),
        );

        const replay = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'replay-pacing.json',
        ]);
        const replayReport = JSON.parse(replay.stdout);

        expect(replay.code).toBe(0);
        expect(replayReport.summary.trafficPlan).toMatchObject({
            seed: 20260601,
            replay: true,
            decisionCount: 5,
            stepCount: 7,
        });
        expect(replayReport.resultsList.map((entry: { name: string }) => entry.name))
            .toEqual(report.resultsList.map((entry: { name: string }) => entry.name));
        expect(replayReport.outputs).toEqual(report.outputs);
    });

    it('runs bounded parallel step groups with deterministic report ordering', async () => {
        const workingDirectory = await writeTempConfig({
            steps: [
                {
                    name: 'parallelSets',
                    type: 'parallel',
                    maxConcurrency: 2,
                    groups: [
                        {
                            name: 'left',
                            steps: [
                                {
                                    name: 'setLeft',
                                    type: 'set',
                                    output: 'left',
                                    value: 'left-value',
                                },
                            ],
                        },
                        {
                            name: 'right',
                            steps: [
                                {
                                    name: 'setRight',
                                    type: 'set',
                                    output: 'right',
                                    value: 'right-value',
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);

        expect(report.summary).toMatchObject({
            total: 3,
            success: 3,
            failure: 0,
        });
        expect(report.resultsByName.parallelSets[0].actual).toMatchObject({
            groupCount: 2,
            maxConcurrency: 2,
            success: 2,
            failure: 0,
        });
        expect(report.outputs).toMatchObject({
            left: 'left-value',
            right: 'right-value',
        });
        expect(report.resultsList.map((entry: { name: string }) => entry.name))
            .toEqual(['parallelSets', 'setLeft', 'setRight']);
    });

    it('returns useful error when config file is missing', async () => {
        const workingDirectory = await mkdtemp(
            path.join(tmpdir(), 'scenario-black-box-missing-config-'),
        );

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'does-not-exist.json',
        ]);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('does-not-exist.json');
    });
});
