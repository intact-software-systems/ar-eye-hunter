import {spawn} from 'node:child_process';
import {mkdtemp, writeFile} from 'node:fs/promises';
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

async function runScenarioCli(args: string[]): Promise<{
    code: number;
    stdout: string;
    stderr: string;
}> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            'deno',
            ['run', '-A', scenarioCliPath, ...args],
            {stdio: ['ignore', 'pipe', 'pipe']},
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
