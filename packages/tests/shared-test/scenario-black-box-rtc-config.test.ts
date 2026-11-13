import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scenarioCliPath = fileURLToPath(
    new URL('../../shared-test/black-box-runner/scenario-black-box.ts', import.meta.url)
);
const tempConfigDirectories = new Set<string>();

async function writeTempConfig(config: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'scenario-black-box-rtc-'));
    tempConfigDirectories.add(dir);

    await writeFile(
        `${dir}/config.json`,
        JSON.stringify(config, null, 2),
        'utf8'
    );

    return dir;
}

async function runScenarioCli(args: string[]): Promise<{
    code: number;
    stdout: string;
    stderr: string;
}> {
    const output = spawnSync(process.execPath, [
        'run',
        scenarioCliPath,
        ...args
    ], { encoding: 'utf8' });

    try {
        return {
            code: output.status ?? 0,
            stdout: output.stdout,
            stderr: output.stderr
        };
    }
    finally {
        await cleanupScenarioWorkingDirectory(args);
    }
}

async function cleanupScenarioWorkingDirectory(args: string[]): Promise<void> {
    const workingDirectoryFlagIndex = args.indexOf('-w');
    const workingDirectory = workingDirectoryFlagIndex >= 0
        ? args[workingDirectoryFlagIndex + 1]
        : undefined;

    if (!workingDirectory || !tempConfigDirectories.delete(workingDirectory)) {
        return;
    }

    await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
}

test('scenario-black-box CLI dry mode normalizes rtc.connect and rtc.send steps', async () => {
    const workingDirectory = await writeTempConfig({
        variables: {
            roomId: 'room-1'
        },
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-stub',
                actor: 'alice',
                roomId: '{roomId}'
            },
            bobRtc: {
                type: 'rtc',
                provider: 'rallar-stub',
                actor: 'bob',
                roomId: '{roomId}'
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            },
            {
                name: 'aliceSendsMessage',
                type: 'rtc.send',
                connection: 'aliceRtc',
                request: {
                    send: {
                        topic: 'chat.message',
                        payload: {
                            text: 'hello bob'
                        }
                    }
                },
                expect: {
                    connection: 'bobRtc',
                    message: {
                        topic: 'chat.message'
                    }
                }
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
        '-e',
        'dry'
    ]);

    expect(result.code).toEqual(0);
    expect(result.stderr).toEqual('');

    const interactions = JSON.parse(result.stdout);

    expect(Array.isArray(interactions)).toEqual(true);
    expect(interactions.length).toEqual(2);

    expect(interactions[0].RTC.request.action).toEqual('connect');
    expect(interactions[0].RTC.request.connection).toEqual('aliceRtc');
    expect(interactions[0].RTC.request.provider).toEqual('rallar-stub');
    expect(interactions[0].RTC.request.actor).toEqual('alice');
    expect(interactions[0].RTC.request.roomId).toEqual('room-1');

    expect(interactions[1].RTC.request.action).toEqual('send');
    expect(interactions[1].RTC.request.connection).toEqual('aliceRtc');
    expect(interactions[1].RTC.response.connection).toEqual('bobRtc');
    expect(interactions[1].RTC.response.message).toEqual({
        topic: 'chat.message'
    });
});

test('scenario-black-box CLI executes rtc.connect and rtc.send with stub rallar provider', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-stub',
                actor: 'alice',
                roomId: 'room-1'
            },
            bobRtc: {
                type: 'rtc',
                provider: 'rallar-stub',
                actor: 'bob',
                roomId: 'room-1'
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            },
            {
                name: 'connectBob',
                type: 'rtc.connect',
                connection: 'bobRtc'
            },
            {
                name: 'aliceSendsMessage',
                type: 'rtc.send',
                connection: 'aliceRtc',
                request: {
                    send: {
                        topic: 'chat.message',
                        payload: {
                            text: 'hello bob'
                        }
                    }
                },
                expect: {
                    connection: 'bobRtc',
                    withinMs: 1000,
                    consume: true,
                    message: {
                        topic: 'chat.message',
                        payload: {
                            text: 'hello bob'
                        }
                    }
                }
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(0);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(0);
    expect(report.summary.success).toEqual(3);
    expect(report.resultsByName.connectAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.connectBob[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.aliceSendsMessage[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.aliceSendsMessage[0].actual.stub).toEqual(true);
    expect(report.rtcProviderNames.includes('rallar-stub')).toEqual(true);
});

test('scenario-black-box CLI executes rtc.send with ordered expect.messages', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-stub',
                actor: 'alice',
                roomId: 'room-1'
            },
            bobRtc: {
                type: 'rtc',
                provider: 'rallar-stub',
                actor: 'bob',
                roomId: 'room-1'
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            },
            {
                name: 'connectBob',
                type: 'rtc.connect',
                connection: 'bobRtc'
            },
            {
                name: 'aliceEmitsJoinFlow',
                type: 'rtc.send',
                connection: 'aliceRtc',
                request: {
                    deliverMessages: [
                        {
                            topic: 'room.member.joined',
                            payload: {
                                actor: 'alice'
                            }
                        },
                        {
                            topic: 'presence.update',
                            payload: {
                                actor: 'alice',
                                online: true
                            }
                        }
                    ]
                },
                expect: {
                    connection: 'bobRtc',
                    withinMs: 1000,
                    ordered: true,
                    consume: true,
                    messages: [
                        {
                            topic: 'room.member.joined'
                        },
                        {
                            topic: 'presence.update'
                        }
                    ]
                }
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(0);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(0);
    expect(report.resultsByName.aliceEmitsJoinFlow[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.aliceEmitsJoinFlow[0].actual.ordered).toEqual(true);
    expect(report.resultsByName.aliceEmitsJoinFlow[0].actual.matchedMessages.length).toEqual(2);
});

test('scenario-black-box CLI reports failure when ordered RTC messages are in wrong order', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-stub',
                actor: 'alice',
                roomId: 'room-1'
            },
            bobRtc: {
                type: 'rtc',
                provider: 'rallar-stub',
                actor: 'bob',
                roomId: 'room-1'
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            },
            {
                name: 'connectBob',
                type: 'rtc.connect',
                connection: 'bobRtc'
            },
            {
                name: 'aliceEmitsWrongOrder',
                type: 'rtc.send',
                connection: 'aliceRtc',
                request: {
                    deliverMessages: [
                        {
                            topic: 'presence.update'
                        },
                        {
                            topic: 'room.member.joined'
                        }
                    ]
                },
                expect: {
                    connection: 'bobRtc',
                    withinMs: 100,
                    ordered: true,
                    messages: [
                        {
                            topic: 'room.member.joined'
                        },
                        {
                            topic: 'presence.update'
                        }
                    ]
                }
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(1);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(1);
    expect(report.summary.firstFailure.name).toEqual('aliceEmitsWrongOrder');
    expect(report.summary.firstFailure.result).toContain('Expected RTC messages were not received in the expected order');
});

test('scenario-black-box CLI executes rtc.close and rtc.wait expect.close', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-stub',
                actor: 'alice',
                roomId: 'room-1'
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            },
            {
                name: 'closeAlice',
                type: 'rtc.close',
                connection: 'aliceRtc'
            },
            {
                name: 'aliceClosed',
                type: 'rtc.wait',
                connection: 'aliceRtc',
                expect: {
                    withinMs: 1000,
                    close: true
                }
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(0);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(0);
    expect(report.resultsByName.aliceClosed[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.aliceClosed[0].actual.matchedCloseEvent.stub).toEqual(true);
});

test('scenario-black-box CLI auto-closes unclosed RTC stub connections', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-stub',
                actor: 'alice',
                roomId: 'room-1'
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(0);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(0);
    expect(report.rtcConnections).toEqual({});
    expect(report.rtcCloseEvents.aliceRtc[0].autoCloseRequested).toEqual(true);
    expect(report.rtcCloseEvents.aliceRtc[0].stub).toEqual(true);
});

test('scenario-black-box CLI reports clear failure for rallar-signaling provider missing signalingUrl', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-signaling',
                actor: 'alice',
                roomId: 'room-1'
            }
        },
        steps: [
            {
                name: 'connectAliceSignaling',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(1);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(1);
    expect(report.summary.firstFailure.name).toEqual('connectAliceSignaling');
    expect(report.resultsByName.connectAliceSignaling[0].status).toEqual('FAILURE');
    expect(report.resultsByName.connectAliceSignaling[0].result).toEqual('RTC connect failed');
    expect(report.resultsByName.connectAliceSignaling[0].actual.exception).toEqual('Rallar WebRTC signalingUrl is required for connection: aliceRtc');
    expect(report.rtcProviderNames.includes('rallar')).toEqual(false);
    expect(report.rtcProviderNames.includes('rallar-signaling')).toEqual(true);
    expect(report.rtcProviderNames.includes('rallar-stub')).toEqual(true);
    expect(report.rtcProviderNames.includes('rallar-memory')).toEqual(true);
});

test('scenario-black-box CLI explicit rallar-signaling provider is WebSocket signaling-only', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-signaling',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1',
                groupId: 'group-1',
                overlayId: 'overlay-1'
            }
        },
        steps: [
            {
                name: 'connectAliceSignaling',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(1);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);
    const connectResult = report.resultsByName.connectAliceSignaling[0];

    expect(report.summary.failure).toEqual(1);
    expect(connectResult.status).toEqual('FAILURE');
    expect(connectResult.result).toEqual('RTC connect failed');
    expect(connectResult.provider).toEqual('rallar-signaling');
    expect(connectResult.peerId).toEqual('alice');
    expect(connectResult.groupId).toEqual('group-1');
    expect(connectResult.overlayId).toEqual('overlay-1');
    expect(connectResult.actual.exception).toEqual('Rallar WebRTC signalingUrl is required for connection: aliceRtc');
});

test('scenario-black-box CLI explicit rallar-signaling provider waits for WebSocket open', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-signaling',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1',
                groupId: 'group-1',
                overlayId: 'overlay-1',
                signalingUrl: 'ws://localhost:65534/ws',
                openTimeoutMs: 50
            }
        },
        steps: [
            {
                name: 'connectAliceSignalingWithUrl',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(1);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);
    const connectResult = report.resultsByName.connectAliceSignalingWithUrl[0];

    expect(report.summary.failure).toEqual(1);
    expect(connectResult.status).toEqual('FAILURE');
    expect(connectResult.result).toEqual('RTC connect failed');
    expect(connectResult.provider).toEqual('rallar-signaling');
    expect(connectResult.peerId).toEqual('alice');
    expect(connectResult.groupId).toEqual('group-1');
    expect(connectResult.overlayId).toEqual('overlay-1');
    expect(String(connectResult.actual.exception).startsWith('Rallar WebRTC signaling transport failed before open.')).toEqual(true);
});

test('scenario-black-box CLI dry mode normalizes rallar WebSocket signaling-only config', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-signaling',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1',
                groupId: 'group-1',
                overlayId: 'overlay-1',
                signalingUrl: 'ws://localhost:8080/ws',
                waitForOpen: true,
                openTimeoutMs: 1000
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
        '--dry-run'
    ]);

    expect(result.code).toEqual(0);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(0);
    expect(report.summary.total).toEqual(1);
    expect(report.resultsByName.connectAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.connectAlice[0].actual.dryRun).toEqual(true);
    expect(report.resultsByName.connectAlice[0].actual.normalized.provider).toEqual('rallar-signaling');
    expect(report.resultsByName.connectAlice[0].actual.normalized.signalingUrl).toEqual('ws://localhost:8080/ws');
    expect(report.resultsByName.connectAlice[0].actual.normalized.groupId).toEqual('group-1');
    expect(report.resultsByName.connectAlice[0].actual.normalized.overlayId).toEqual('overlay-1');
    expect(report.resultsByName.connectAlice[0].actual.normalized.waitForOpen).toEqual(true);
    expect(report.resultsByName.connectAlice[0].actual.normalized.openTimeoutMs).toEqual(1000);
});

test('scenario-black-box CLI short dry-run flag normalizes rallar WebSocket signaling-only config', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-signaling',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1',
                groupId: 'group-1',
                overlayId: 'overlay-1',
                signalingUrl: 'ws://localhost:8080/ws',
                waitForOpen: true,
                openTimeoutMs: 1000
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
        '-n'
    ]);

    expect(result.code).toEqual(0);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(0);
    expect(report.summary.total).toEqual(1);
    expect(report.resultsByName.connectAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.connectAlice[0].actual.dryRun).toEqual(true);
    expect(report.resultsByName.connectAlice[0].actual.normalized.provider).toEqual('rallar-signaling');
    expect(report.resultsByName.connectAlice[0].actual.normalized.signalingUrl).toEqual('ws://localhost:8080/ws');
    expect(report.resultsByName.connectAlice[0].actual.normalized.groupId).toEqual('group-1');
    expect(report.resultsByName.connectAlice[0].actual.normalized.overlayId).toEqual('overlay-1');
    expect(report.resultsByName.connectAlice[0].actual.normalized.waitForOpen).toEqual(true);
    expect(report.resultsByName.connectAlice[0].actual.normalized.openTimeoutMs).toEqual(1000);
});

test('scenario-black-box CLI execution dry prints executable RTC interactions instead of report', async () => {
    const workingDirectory = await writeTempConfig({
        variables: {
            roomId: 'room-1'
        },
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'unknown-rtc-provider',
                actor: 'alice',
                peerId: 'alice',
                roomId: '{roomId}'
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
        '-e',
        'dry'
    ]);

    expect(result.code).toEqual(0);
    expect(result.stderr).toEqual('');

    const interactions = JSON.parse(result.stdout);

    expect(Array.isArray(interactions)).toEqual(true);
    expect(interactions.length).toEqual(1);
    expect(interactions[0].RTC.request.action).toEqual('connect');
    expect(interactions[0].RTC.request.connection).toEqual('aliceRtc');
    expect(interactions[0].RTC.request.provider).toEqual('unknown-rtc-provider');
    expect(interactions[0].RTC.request.roomId).toEqual('room-1');
    expect(interactions[0].summary).toEqual(undefined);
});

test('scenario-black-box CLI dry-run returns report instead of executable RTC interactions', async () => {
    const workingDirectory = await writeTempConfig({
        variables: {
            roomId: 'room-1'
        },
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'unknown-rtc-provider',
                actor: 'alice',
                peerId: 'alice',
                roomId: '{roomId}'
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
        '--dry-run'
    ]);

    expect(result.code).toEqual(0);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(Array.isArray(report)).toEqual(false);
    expect(report.summary.failure).toEqual(0);
    expect(report.summary.success).toEqual(1);
    expect(report.resultsByName.connectAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.connectAlice[0].actual.dryRun).toEqual(true);
    expect(report.resultsByName.connectAlice[0].actual.normalized.provider).toEqual('unknown-rtc-provider');
    expect(report.resultsByName.connectAlice[0].actual.normalized.roomId).toEqual('room-1');
});

test('scenario-black-box CLI config execution dryRun normalizes rallar WebSocket signaling-only config', async () => {
    const workingDirectory = await writeTempConfig({
        execution: {
            dryRun: true
        },
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-signaling',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1',
                groupId: 'group-1',
                overlayId: 'overlay-1',
                signalingUrl: 'ws://localhost:8080/ws',
                waitForOpen: true,
                openTimeoutMs: 1000
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(0);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(0);
    expect(report.summary.total).toEqual(1);
    expect(report.resultsByName.connectAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.connectAlice[0].actual.dryRun).toEqual(true);
    expect(report.resultsByName.connectAlice[0].actual.normalized.provider).toEqual('rallar-signaling');
    expect(report.resultsByName.connectAlice[0].actual.normalized.signalingUrl).toEqual('ws://localhost:8080/ws');
    expect(report.resultsByName.connectAlice[0].actual.normalized.groupId).toEqual('group-1');
    expect(report.resultsByName.connectAlice[0].actual.normalized.overlayId).toEqual('overlay-1');
    expect(report.resultsByName.connectAlice[0].actual.normalized.waitForOpen).toEqual(true);
    expect(report.resultsByName.connectAlice[0].actual.normalized.openTimeoutMs).toEqual(1000);
});

test('scenario-black-box CLI dry-run does not require configured RTC provider', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'unknown-rtc-provider',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1'
            }
        },
        steps: [
            {
                name: 'connectAliceWithUnknownProvider',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            },
            {
                name: 'aliceSendsWithUnknownProvider',
                type: 'rtc.send',
                connection: 'aliceRtc',
                request: {
                    send: {
                        topic: 'chat.message',
                        payload: {
                            from: 'alice',
                            text: 'dry-run should not need provider'
                        }
                    }
                }
            },
            {
                name: 'closeAliceWithUnknownProvider',
                type: 'rtc.close',
                connection: 'aliceRtc'
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
        '--dry-run'
    ]);

    expect(result.code).toEqual(0);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(0);
    expect(report.summary.total).toEqual(3);
    expect(report.rtcConnections).toEqual({});
    expect(report.rtcMessages).toEqual({});
    expect(report.rtcCloseEvents).toEqual({});
    expect(report.resultsByName.connectAliceWithUnknownProvider[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.aliceSendsWithUnknownProvider[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.closeAliceWithUnknownProvider[0].status).toEqual('SUCCESS');

    expect(report.resultsByName.connectAliceWithUnknownProvider[0].actual.dryRun).toEqual(true);
    expect(report.resultsByName.aliceSendsWithUnknownProvider[0].actual.dryRun).toEqual(true);
    expect(report.resultsByName.closeAliceWithUnknownProvider[0].actual.dryRun).toEqual(true);

    expect(report.resultsByName.connectAliceWithUnknownProvider[0].actual.normalized.provider).toEqual('unknown-rtc-provider');
    expect(report.resultsByName.aliceSendsWithUnknownProvider[0].actual.normalized.provider).toEqual('unknown-rtc-provider');
    expect(report.resultsByName.closeAliceWithUnknownProvider[0].actual.normalized.provider).toEqual('unknown-rtc-provider');

    expect(report.resultsByName.aliceSendsWithUnknownProvider[0].actual.normalized.send).toEqual({
        topic: 'chat.message',
        payload: {
            from: 'alice',
            text: 'dry-run should not need provider'
        }
    });
});

test('scenario-black-box CLI dry-run normalizes rallar signaling close wait expectation', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-signaling',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1',
                groupId: 'group-1',
                overlayId: 'overlay-1',
                signalingUrl: 'ws://localhost:8080/ws',
                waitForOpen: true
            }
        },
        steps: [
            {
                name: 'waitForSignalingClose',
                type: 'rtc.wait',
                connection: 'aliceRtc',
                expect: {
                    connection: 'aliceRtc',
                    withinMs: 1000,
                    close: {
                        phase: 'signaling-close',
                        reason: 'rallar WebRTC signaling session closed',
                        connection: 'aliceRtc',
                        peerId: 'alice',
                        roomId: 'room-1'
                    }
                }
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
        '--dry-run'
    ]);

    expect(result.code).toEqual(0);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(0);
    expect(report.summary.total).toEqual(1);
    expect(report.rtcConnections).toEqual({});
    expect(report.rtcMessages).toEqual({});
    expect(report.rtcCloseEvents).toEqual({});
    expect(report.resultsByName.waitForSignalingClose[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.waitForSignalingClose[0].actual.dryRun).toEqual(true);
    expect(report.resultsByName.waitForSignalingClose[0].actual.normalized.provider).toEqual('rallar-signaling');
    expect(report.resultsByName.waitForSignalingClose[0].actual.normalized.connection).toEqual('aliceRtc');
    expect(report.resultsByName.waitForSignalingClose[0].actual.normalized.groupId).toEqual('group-1');
    expect(report.resultsByName.waitForSignalingClose[0].actual.normalized.overlayId).toEqual('overlay-1');
    expect(report.resultsByName.waitForSignalingClose[0].actual.normalized.action).toEqual('wait');
    expect(report.resultsByName.waitForSignalingClose[0].actual.normalized.response.withinMs).toEqual(1000);
    expect(report.resultsByName.waitForSignalingClose[0].actual.normalized.response.close.phase).toEqual('signaling-close');
    expect(report.resultsByName.waitForSignalingClose[0].actual.normalized.response.close.reason).toEqual('rallar WebRTC signaling session closed');
    expect(report.resultsByName.waitForSignalingClose[0].actual.normalized.response.close.connection).toEqual('aliceRtc');
    expect(report.resultsByName.waitForSignalingClose[0].actual.normalized.response.close.peerId).toEqual('alice');
    expect(report.resultsByName.waitForSignalingClose[0].actual.normalized.response.close.roomId).toEqual('room-1');
});

test('scenario-black-box CLI dry mode normalizes rallar signaling send expectation', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-signaling',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1',
                groupId: 'group-1',
                overlayId: 'overlay-1',
                signalingUrl: 'ws://localhost:8080/ws',
                waitForOpen: true
            }
        },
        steps: [
            {
                name: 'aliceSendsSignalingOffer',
                type: 'rtc.send',
                connection: 'aliceRtc',
                request: {
                    send: {
                        topic: 'rallar.existing.signaling.offer',
                        payload: {
                            from: 'alice',
                            to: 'bob',
                            sdp: 'fake-offer-sdp'
                        }
                    }
                },
                expect: {
                    connection: 'aliceRtc',
                    withinMs: 1000,
                    message: {
                        topic: 'rallar.webrtc.signaling.message',
                        connection: 'aliceRtc',
                        peerId: 'alice',
                        roomId: 'room-1',
                        message: {
                            topic: 'rallar.existing.signaling.answer',
                            payload: {
                                from: 'bob',
                                to: 'alice',
                                sdp: 'fake-answer-sdp'
                            }
                        }
                    }
                }
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
        '--dry-run'
    ]);

    expect(result.code).toEqual(0);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(0);
    expect(report.summary.total).toEqual(1);
    expect(report.rtcConnections).toEqual({});
    expect(report.rtcMessages).toEqual({});
    expect(report.rtcCloseEvents).toEqual({});
    expect(report.resultsByName.aliceSendsSignalingOffer[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.aliceSendsSignalingOffer[0].actual.dryRun).toEqual(true);
    expect(report.resultsByName.aliceSendsSignalingOffer[0].actual.normalized.provider).toEqual('rallar-signaling');
    expect(report.resultsByName.aliceSendsSignalingOffer[0].actual.normalized.connection).toEqual('aliceRtc');
    expect(report.resultsByName.aliceSendsSignalingOffer[0].actual.normalized.send).toEqual({
        topic: 'rallar.existing.signaling.offer',
        payload: {
            from: 'alice',
            to: 'bob',
            sdp: 'fake-offer-sdp'
        }
    });
    expect(report.resultsByName.aliceSendsSignalingOffer[0].actual.normalized.response.message.topic).toEqual('rallar.webrtc.signaling.message');
});

test('scenario-black-box CLI report includes default RTC provider names', async () => {
    const workingDirectory = await writeTempConfig({
        steps: []
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(0);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(0);
    expect(report.rtcProviderNames.includes('rallar')).toEqual(false);
    expect(report.rtcProviderNames.includes('rallar-signaling')).toEqual(true);
    expect(report.rtcProviderNames.includes('rallar-stub')).toEqual(true);
    expect(report.rtcProviderNames.includes('rallar-memory')).toEqual(true);
});

test('scenario-black-box CLI can execute two-peer RTC flow with rallar-memory provider', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                remotePeerId: 'bob',
                roomId: 'room-1'
            },
            bobRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'bob',
                peerId: 'bob',
                remotePeerId: 'alice',
                roomId: 'room-1'
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            },
            {
                name: 'connectBob',
                type: 'rtc.connect',
                connection: 'bobRtc'
            },
            {
                name: 'aliceSendsToBob',
                type: 'rtc.send',
                connection: 'aliceRtc',
                request: {
                    send: {
                        topic: 'chat.message',
                        payload: {
                            from: 'alice',
                            to: 'bob',
                            text: 'hello bob'
                        }
                    }
                },
                expect: {
                    connection: 'bobRtc',
                    withinMs: 1000,
                    message: {
                        topic: 'chat.message',
                        payload: {
                            from: 'alice',
                            to: 'bob',
                            text: 'hello bob'
                        }
                    }
                }
            },
            {
                name: 'bobSendsToAlice',
                type: 'rtc.send',
                connection: 'bobRtc',
                request: {
                    send: {
                        topic: 'chat.message',
                        payload: {
                            from: 'bob',
                            to: 'alice',
                            text: 'hello alice'
                        }
                    }
                },
                expect: {
                    connection: 'aliceRtc',
                    withinMs: 1000,
                    message: {
                        topic: 'chat.message',
                        payload: {
                            from: 'bob',
                            to: 'alice',
                            text: 'hello alice'
                        }
                    }
                }
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(0);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(0);
    expect(report.resultsByName.connectAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.connectBob[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.aliceSendsToBob[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.bobSendsToAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveredBy).toEqual('rallar-in-memory-runtime');
    expect(report.resultsByName.bobSendsToAlice[0].actual.matchedMessage.data.deliveredBy).toEqual('rallar-in-memory-runtime');
    expect(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveredTo).toEqual('bob');
    expect(report.resultsByName.bobSendsToAlice[0].actual.matchedMessage.data.deliveredTo).toEqual('alice');
    expect(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliverySequence).toEqual(1);
    expect(report.resultsByName.bobSendsToAlice[0].actual.matchedMessage.data.deliverySequence).toEqual(2);
});

test('scenario-black-box CLI routes rallar-memory payload target before remotePeerId', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                remotePeerId: 'bob',
                roomId: 'room-1'
            },
            bobRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'bob',
                peerId: 'bob',
                remotePeerId: 'alice',
                roomId: 'room-1'
            },
            charlieRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'charlie',
                peerId: 'charlie',
                remotePeerId: 'alice',
                roomId: 'room-1'
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            },
            {
                name: 'connectBob',
                type: 'rtc.connect',
                connection: 'bobRtc'
            },
            {
                name: 'connectCharlie',
                type: 'rtc.connect',
                connection: 'charlieRtc'
            },
            {
                name: 'aliceSendsPayloadTargetToCharlie',
                type: 'rtc.send',
                connection: 'aliceRtc',
                request: {
                    send: {
                        topic: 'chat.message',
                        payload: {
                            from: 'alice',
                            to: 'charlie',
                            text: 'hello charlie'
                        }
                    }
                },
                expect: {
                    connection: 'charlieRtc',
                    withinMs: 1000,
                    message: {
                        topic: 'chat.message',
                        payload: {
                            from: 'alice',
                            to: 'charlie',
                            text: 'hello charlie'
                        }
                    }
                }
            },
            {
                name: 'bobDoesNotReceiveCharlieTargetedMessage',
                type: 'rtc.wait',
                connection: 'bobRtc',
                expect: {
                    connection: 'bobRtc',
                    withinMs: 100,
                    message: {
                        topic: 'chat.message',
                        payload: {
                            from: 'alice',
                            to: 'charlie',
                            text: 'hello charlie'
                        }
                    }
                }
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(1);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(1);
    expect(report.resultsByName.aliceSendsPayloadTargetToCharlie[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.aliceSendsPayloadTargetToCharlie[0].actual.matchedMessage.data.deliveredBy).toEqual('rallar-in-memory-runtime');
    expect(report.resultsByName.bobDoesNotReceiveCharlieTargetedMessage[0].status).toEqual('FAILURE');
    expect(report.resultsByName.bobDoesNotReceiveCharlieTargetedMessage[0].result).toEqual('Expected RTC message was not received');
    expect(report.resultsByName.aliceSendsPayloadTargetToCharlie[0].actual.matchedMessage.data.deliveredTo).toEqual('charlie');
});

test('scenario-black-box CLI can broadcast within room with rallar-memory provider', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1'
            },
            bobRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'bob',
                peerId: 'bob',
                roomId: 'room-1'
            },
            charlieRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'charlie',
                peerId: 'charlie',
                roomId: 'room-2'
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            },
            {
                name: 'connectBob',
                type: 'rtc.connect',
                connection: 'bobRtc'
            },
            {
                name: 'connectCharlieDifferentRoom',
                type: 'rtc.connect',
                connection: 'charlieRtc'
            },
            {
                name: 'aliceBroadcastsPresence',
                type: 'rtc.send',
                connection: 'aliceRtc',
                request: {
                    send: {
                        topic: 'presence.update',
                        payload: {
                            from: 'alice',
                            online: true
                        }
                    }
                },
                expect: {
                    connection: 'bobRtc',
                    withinMs: 1000,
                    message: {
                        topic: 'presence.update',
                        payload: {
                            from: 'alice',
                            online: true
                        }
                    }
                }
            },
            {
                name: 'charlieDoesNotReceiveOtherRoomBroadcast',
                type: 'rtc.wait',
                connection: 'charlieRtc',
                expect: {
                    connection: 'charlieRtc',
                    withinMs: 100,
                    message: {
                        topic: 'presence.update',
                        payload: {
                            from: 'alice',
                            online: true
                        }
                    }
                }
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(1);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(1);
    expect(report.resultsByName.aliceBroadcastsPresence[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.aliceBroadcastsPresence[0].actual.matchedMessage.data.deliveredBy).toEqual('rallar-in-memory-runtime');
    expect(report.resultsByName.charlieDoesNotReceiveOtherRoomBroadcast[0].status).toEqual('FAILURE');
    expect(report.resultsByName.charlieDoesNotReceiveOtherRoomBroadcast[0].result).toEqual('Expected RTC message was not received');
});

test('scenario-black-box CLI can explicitly broadcast with rallar-memory provider even when remotePeerId is configured', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                remotePeerId: 'bob',
                roomId: 'room-1'
            },
            bobRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'bob',
                peerId: 'bob',
                remotePeerId: 'alice',
                roomId: 'room-1'
            },
            charlieRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'charlie',
                peerId: 'charlie',
                roomId: 'room-1'
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            },
            {
                name: 'connectBob',
                type: 'rtc.connect',
                connection: 'bobRtc'
            },
            {
                name: 'connectCharlie',
                type: 'rtc.connect',
                connection: 'charlieRtc'
            },
            {
                name: 'aliceExplicitlyBroadcastsPresence',
                type: 'rtc.send',
                connection: 'aliceRtc',
                request: {
                    send: {
                        topic: 'presence.update',
                        broadcast: true,
                        payload: {
                            from: 'alice',
                            online: true
                        }
                    }
                },
                expect: {
                    connection: 'bobRtc',
                    withinMs: 1000,
                    message: {
                        topic: 'presence.update',
                        broadcast: true,
                        payload: {
                            from: 'alice',
                            online: true
                        }
                    }
                }
            },
            {
                name: 'charlieReceivesExplicitBroadcast',
                type: 'rtc.wait',
                connection: 'charlieRtc',
                expect: {
                    connection: 'charlieRtc',
                    withinMs: 1000,
                    message: {
                        topic: 'presence.update',
                        broadcast: true,
                        payload: {
                            from: 'alice',
                            online: true
                        }
                    }
                }
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(0);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(0);
    expect(report.resultsByName.aliceExplicitlyBroadcastsPresence[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.charlieReceivesExplicitBroadcast[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.aliceExplicitlyBroadcastsPresence[0].actual.matchedMessage.data.deliveredBy).toEqual('rallar-in-memory-runtime');
    expect(report.resultsByName.charlieReceivesExplicitBroadcast[0].actual.matchedMessage.data.deliveredBy).toEqual('rallar-in-memory-runtime');
    expect(report.resultsByName.aliceExplicitlyBroadcastsPresence[0].actual.matchedMessage.data.deliveredTo).toEqual('bob');
    expect(report.resultsByName.charlieReceivesExplicitBroadcast[0].actual.matchedMessage.data.deliveredTo).toEqual('charlie');

    expect(report.resultsByName.aliceExplicitlyBroadcastsPresence[0].actual.matchedMessage.data.deliverySequence).toEqual(1);
    expect(report.resultsByName.charlieReceivesExplicitBroadcast[0].actual.matchedMessage.data.deliverySequence).toEqual(2);
});

test('scenario-black-box CLI can explicitly broadcast with payload broadcast flag and rallar-memory provider', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                remotePeerId: 'bob',
                roomId: 'room-1'
            },
            bobRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'bob',
                peerId: 'bob',
                remotePeerId: 'alice',
                roomId: 'room-1'
            },
            charlieRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'charlie',
                peerId: 'charlie',
                roomId: 'room-1'
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            },
            {
                name: 'connectBob',
                type: 'rtc.connect',
                connection: 'bobRtc'
            },
            {
                name: 'connectCharlie',
                type: 'rtc.connect',
                connection: 'charlieRtc'
            },
            {
                name: 'alicePayloadBroadcastsPresence',
                type: 'rtc.send',
                connection: 'aliceRtc',
                request: {
                    send: {
                        topic: 'presence.update',
                        payload: {
                            broadcast: true,
                            from: 'alice',
                            online: true
                        }
                    }
                },
                expect: {
                    connection: 'bobRtc',
                    withinMs: 1000,
                    message: {
                        topic: 'presence.update',
                        payload: {
                            broadcast: true,
                            from: 'alice',
                            online: true
                        }
                    }
                }
            },
            {
                name: 'charlieReceivesPayloadBroadcast',
                type: 'rtc.wait',
                connection: 'charlieRtc',
                expect: {
                    connection: 'charlieRtc',
                    withinMs: 1000,
                    message: {
                        topic: 'presence.update',
                        payload: {
                            broadcast: true,
                            from: 'alice',
                            online: true
                        }
                    }
                }
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(0);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(0);
    expect(report.resultsByName.alicePayloadBroadcastsPresence[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.charlieReceivesPayloadBroadcast[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.alicePayloadBroadcastsPresence[0].actual.matchedMessage.data.deliveredBy).toEqual('rallar-in-memory-runtime');
    expect(report.resultsByName.charlieReceivesPayloadBroadcast[0].actual.matchedMessage.data.deliveredBy).toEqual('rallar-in-memory-runtime');
    expect(report.resultsByName.alicePayloadBroadcastsPresence[0].actual.matchedMessage.data.deliveredTo).toEqual('bob');
    expect(report.resultsByName.charlieReceivesPayloadBroadcast[0].actual.matchedMessage.data.deliveredTo).toEqual('charlie');
});

test('scenario-black-box CLI reports failure when rallar-memory broadcast has no targets', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1'
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            },
            {
                name: 'aliceBroadcastsToEmptyRoom',
                type: 'rtc.send',
                connection: 'aliceRtc',
                request: {
                    send: {
                        topic: 'presence.update',
                        payload: {
                            from: 'alice',
                            online: true
                        }
                    }
                }
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(1);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(1);
    expect(report.summary.firstFailure.name).toEqual('aliceBroadcastsToEmptyRoom');
    expect(report.resultsByName.connectAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.aliceBroadcastsToEmptyRoom[0].status).toEqual('FAILURE');
    expect(report.resultsByName.aliceBroadcastsToEmptyRoom[0].result).toEqual('RTC send failed');
    expect(report.resultsByName.aliceBroadcastsToEmptyRoom[0].actual.exception).toEqual(
        'Rallar in-memory RTC broadcast has no connected targets for peer: alice'
    );
});

test('scenario-black-box CLI reports failure when rallar-memory direct target is missing', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                remotePeerId: 'missing-bob',
                roomId: 'room-1'
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            },
            {
                name: 'aliceSendsToMissingBob',
                type: 'rtc.send',
                connection: 'aliceRtc',
                request: {
                    send: {
                        topic: 'chat.message',
                        payload: {
                            from: 'alice',
                            to: 'missing-bob',
                            text: 'hello missing bob'
                        }
                    }
                }
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(1);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(1);
    expect(report.summary.firstFailure.name).toEqual('aliceSendsToMissingBob');
    expect(report.resultsByName.connectAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.aliceSendsToMissingBob[0].status).toEqual('FAILURE');
    expect(report.resultsByName.aliceSendsToMissingBob[0].result).toEqual('RTC send failed');
    expect(report.resultsByName.aliceSendsToMissingBob[0].actual.exception).toEqual('Rallar in-memory RTC target is not connected: missing-bob');
});

test('scenario-black-box CLI can close and wait for close with rallar-memory provider', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1'
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            },
            {
                name: 'closeAlice',
                type: 'rtc.close',
                connection: 'aliceRtc'
            },
            {
                name: 'waitForAliceClose',
                type: 'rtc.wait',
                connection: 'aliceRtc',
                expect: {
                    connection: 'aliceRtc',
                    withinMs: 1000,
                    close: {
                        phase: 'close',
                        reason: 'closed by rallar in-memory runtime',
                        peerId: 'alice'
                    }
                }
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(0);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(0);
    expect(report.resultsByName.connectAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.closeAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.waitForAliceClose[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.phase).toEqual('close');
    expect(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.reason).toEqual('closed by rallar in-memory runtime');
    expect(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.peerId).toEqual('alice');
});

test('scenario-black-box CLI reports failure when rallar-memory sends to peer after close', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                remotePeerId: 'bob',
                roomId: 'room-1'
            },
            bobRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'bob',
                peerId: 'bob',
                remotePeerId: 'alice',
                roomId: 'room-1'
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            },
            {
                name: 'connectBob',
                type: 'rtc.connect',
                connection: 'bobRtc'
            },
            {
                name: 'closeBob',
                type: 'rtc.close',
                connection: 'bobRtc'
            },
            {
                name: 'aliceSendsToClosedBob',
                type: 'rtc.send',
                connection: 'aliceRtc',
                request: {
                    send: {
                        topic: 'chat.message',
                        payload: {
                            from: 'alice',
                            to: 'bob',
                            text: 'are you still there?'
                        }
                    }
                }
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(1);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(1);
    expect(report.summary.firstFailure.name).toEqual('aliceSendsToClosedBob');
    expect(report.resultsByName.connectAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.connectBob[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.closeBob[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.aliceSendsToClosedBob[0].status).toEqual('FAILURE');
    expect(report.resultsByName.aliceSendsToClosedBob[0].result).toEqual('RTC send failed');
    expect(report.resultsByName.aliceSendsToClosedBob[0].actual.exception).toEqual('Rallar in-memory RTC target is not connected: bob');
});

test('scenario-black-box CLI auto-closes unclosed rallar-memory connections', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                remotePeerId: 'bob',
                roomId: 'room-1'
            },
            bobRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'bob',
                peerId: 'bob',
                remotePeerId: 'alice',
                roomId: 'room-1'
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            },
            {
                name: 'connectBob',
                type: 'rtc.connect',
                connection: 'bobRtc'
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(0);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(0);
    expect(report.resultsByName.connectAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.connectBob[0].status).toEqual('SUCCESS');
    expect(report.rtcConnections).toEqual({});

    const aliceAutoCloseEvent = report.rtcCloseEvents.aliceRtc
        .find((event: any) => event.autoCloseRequested === true);
    const bobAutoCloseEvent = report.rtcCloseEvents.bobRtc
        .find((event: any) => event.autoCloseRequested === true);

    expect(aliceAutoCloseEvent?.autoCloseRequested).toEqual(true);
    expect(aliceAutoCloseEvent?.autoCloseSucceeded).toEqual(true);
    expect(bobAutoCloseEvent?.autoCloseRequested).toEqual(true);
    expect(bobAutoCloseEvent?.autoCloseSucceeded).toEqual(true);

    const aliceRuntimeCloseEvent = report.rtcCloseEvents.aliceRtc
        .find((event: any) => event.reason === 'closed by rallar in-memory runtime');
    const bobRuntimeCloseEvent = report.rtcCloseEvents.bobRtc
        .find((event: any) => event.reason === 'closed by rallar in-memory runtime');

    expect(aliceRuntimeCloseEvent?.phase).toEqual('close');
    expect(aliceRuntimeCloseEvent?.closedBy).toEqual('rallar-in-memory-runtime');
    expect(aliceRuntimeCloseEvent?.connection).toEqual('aliceRtc');
    expect(aliceRuntimeCloseEvent?.actor).toEqual('alice');
    expect(aliceRuntimeCloseEvent?.peerId).toEqual('alice');
    expect(aliceRuntimeCloseEvent?.roomId).toEqual('room-1');

    expect(bobRuntimeCloseEvent?.phase).toEqual('close');
    expect(bobRuntimeCloseEvent?.closedBy).toEqual('rallar-in-memory-runtime');
    expect(bobRuntimeCloseEvent?.connection).toEqual('bobRtc');
    expect(bobRuntimeCloseEvent?.actor).toEqual('bob');
    expect(bobRuntimeCloseEvent?.peerId).toEqual('bob');
    expect(bobRuntimeCloseEvent?.roomId).toEqual('room-1');
});

test('scenario-black-box CLI reports failure when rallar-memory peer connects twice', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtcOne: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1'
            },
            aliceRtcTwo: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1'
            }
        },
        steps: [
            {
                name: 'connectAliceFirst',
                type: 'rtc.connect',
                connection: 'aliceRtcOne'
            },
            {
                name: 'connectAliceSecond',
                type: 'rtc.connect',
                connection: 'aliceRtcTwo'
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(1);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(1);
    expect(report.summary.firstFailure.name).toEqual('connectAliceSecond');
    expect(report.resultsByName.connectAliceFirst[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.connectAliceSecond[0].status).toEqual('FAILURE');
    expect(report.resultsByName.connectAliceSecond[0].result).toEqual('RTC connect failed');
    expect(report.resultsByName.connectAliceSecond[0].actual.exception).toEqual('Rallar in-memory RTC peer is already connected: alice');
});

test('scenario-black-box CLI allows rallar-memory peer to reconnect after close', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtcOne: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1'
            },
            aliceRtcTwo: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1'
            }
        },
        steps: [
            {
                name: 'connectAliceFirst',
                type: 'rtc.connect',
                connection: 'aliceRtcOne'
            },
            {
                name: 'closeAliceFirst',
                type: 'rtc.close',
                connection: 'aliceRtcOne'
            },
            {
                name: 'connectAliceSecond',
                type: 'rtc.connect',
                connection: 'aliceRtcTwo'
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(0);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(0);
    expect(report.resultsByName.connectAliceFirst[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.closeAliceFirst[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.connectAliceSecond[0].status).toEqual('SUCCESS');

    const aliceRuntimeCloseEvent = report.rtcCloseEvents.aliceRtcOne
        .find((event: any) => event.reason === 'closed by rallar in-memory runtime');

    expect(aliceRuntimeCloseEvent?.phase).toEqual('close');
    expect(aliceRuntimeCloseEvent?.closedBy).toEqual('rallar-in-memory-runtime');
    expect(aliceRuntimeCloseEvent?.connection).toEqual('aliceRtcOne');
    expect(aliceRuntimeCloseEvent?.actor).toEqual('alice');
    expect(aliceRuntimeCloseEvent?.peerId).toEqual('alice');
    expect(aliceRuntimeCloseEvent?.roomId).toEqual('room-1');
});

test('scenario-black-box CLI rallar-memory close event includes diagnostics', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1',
                groupId: 'group-1',
                overlayId: 'overlay-1'
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            },
            {
                name: 'closeAlice',
                type: 'rtc.close',
                connection: 'aliceRtc'
            },
            {
                name: 'waitForAliceClose',
                type: 'rtc.wait',
                connection: 'aliceRtc',
                expect: {
                    connection: 'aliceRtc',
                    withinMs: 1000,
                    close: {
                        phase: 'close',
                        reason: 'closed by rallar in-memory runtime',
                        closedBy: 'rallar-in-memory-runtime',
                        connection: 'aliceRtc',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        groupId: 'group-1',
                        overlayId: 'overlay-1'
                    }
                }
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(0);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);

    expect(report.summary.failure).toEqual(0);
    expect(report.resultsByName.connectAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.closeAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.waitForAliceClose[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.closedBy).toEqual('rallar-in-memory-runtime');
    expect(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.connection).toEqual('aliceRtc');
    expect(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.actor).toEqual('alice');
    expect(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.peerId).toEqual('alice');
    expect(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.roomId).toEqual('room-1');
    expect(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.groupId).toEqual('group-1');
    expect(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.overlayId).toEqual('overlay-1');
});

test('scenario-black-box CLI RTC success report includes generic routing diagnostics', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1',
                groupId: 'group-1',
                overlayId: 'overlay-1',
                remotePeerId: 'bob'
            }
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(0);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);
    const connectResult = report.resultsByName.connectAlice[0];

    expect(report.summary.failure).toEqual(0);
    expect(connectResult.status).toEqual('SUCCESS');
    expect(connectResult.provider).toEqual('rallar-memory');
    expect(connectResult.actor).toEqual('alice');
    expect(connectResult.peerId).toEqual('alice');
    expect(connectResult.roomId).toEqual('room-1');
    expect(connectResult.groupId).toEqual('group-1');
    expect(connectResult.overlayId).toEqual('overlay-1');
    expect(connectResult.remotePeerId).toEqual('bob');
    expect(connectResult.action).toEqual('connect');
    expect(connectResult.connection).toEqual('aliceRtc');
    expect(connectResult.actual.provider).toEqual('rallar-memory');
    expect(connectResult.actual.actor).toEqual('alice');
    expect(connectResult.actual.peerId).toEqual('alice');
    expect(connectResult.actual.roomId).toEqual('room-1');
    expect(connectResult.actual.groupId).toEqual('group-1');
    expect(connectResult.actual.overlayId).toEqual('overlay-1');
    expect(connectResult.actual.remotePeerId).toEqual('bob');
    expect(connectResult.actual.action).toEqual('connect');
    expect(connectResult.actual.connection).toEqual('aliceRtc');
});

test('scenario-black-box CLI RTC failure report includes generic routing diagnostics', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'missing-provider',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1',
                groupId: 'group-1',
                overlayId: 'overlay-1',
                remotePeerId: 'bob'
            }
        },
        steps: [
            {
                name: 'connectAliceMissingProvider',
                type: 'rtc.connect',
                connection: 'aliceRtc'
            }
        ]
    });

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json'
    ]);

    expect(result.code).toEqual(1);
    expect(result.stderr).toEqual('');

    const report = JSON.parse(result.stdout);
    const connectResult = report.resultsByName.connectAliceMissingProvider[0];

    expect(report.summary.failure).toEqual(1);
    expect(connectResult.status).toEqual('FAILURE');
    expect(connectResult.result).toEqual('RTC provider is not configured: missing-provider');
    expect(connectResult.provider).toEqual('missing-provider');
    expect(connectResult.actor).toEqual('alice');
    expect(connectResult.peerId).toEqual('alice');
    expect(connectResult.roomId).toEqual('room-1');
    expect(connectResult.groupId).toEqual('group-1');
    expect(connectResult.overlayId).toEqual('overlay-1');
    expect(connectResult.remotePeerId).toEqual('bob');
    expect(connectResult.action).toEqual('connect');
    expect(connectResult.connection).toEqual('aliceRtc');
    expect(connectResult.actual.provider).toEqual('missing-provider');
    expect(connectResult.actual.actor).toEqual('alice');
    expect(connectResult.actual.peerId).toEqual('alice');
    expect(connectResult.actual.roomId).toEqual('room-1');
    expect(connectResult.actual.groupId).toEqual('group-1');
    expect(connectResult.actual.overlayId).toEqual('overlay-1');
    expect(connectResult.actual.remotePeerId).toEqual('bob');
    expect(connectResult.actual.action).toEqual('connect');
    expect(connectResult.actual.connection).toEqual('aliceRtc');
});
