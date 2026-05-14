import {
    assertEquals,
    assertStringIncludes,
} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {fromFileUrl} from 'https://deno.land/std@0.224.0/path/mod.ts'

const scenarioCliPath = fromFileUrl(
    new URL('../../shared-test/black-box-runner/scenario-black-box.ts', import.meta.url),
)

async function writeTempConfig(config: unknown): Promise<string> {
    const dir = await Deno.makeTempDir({
        prefix: 'scenario-black-box-rtc-',
    })

    await Deno.writeTextFile(
        `${dir}/config.json`,
        JSON.stringify(config, null, 2),
    )

    return dir
}

async function runScenarioCli(args: string[]): Promise<{
    code: number
    stdout: string
    stderr: string
}> {
    const command = new Deno.Command(Deno.execPath(), {
        args: [
            'run',
            '-A',
            scenarioCliPath,
            ...args,
        ],
        stdout: 'piped',
        stderr: 'piped',
    })

    const output = await command.output()

    return {
        code: output.code,
        stdout: new TextDecoder().decode(output.stdout),
        stderr: new TextDecoder().decode(output.stderr),
    }
}

Deno.test('scenario-black-box CLI dry mode normalizes rtc.connect and rtc.send steps', async () => {
    const workingDirectory = await writeTempConfig({
        variables: {
            roomId: 'room-1',
        },
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-stub',
                actor: 'alice',
                roomId: '{roomId}',
            },
            bobRtc: {
                type: 'rtc',
                provider: 'rallar-stub',
                actor: 'bob',
                roomId: '{roomId}',
            },
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc',
            },
            {
                name: 'aliceSendsMessage',
                type: 'rtc.send',
                connection: 'aliceRtc',
                request: {
                    send: {
                        topic: 'chat.message',
                        payload: {
                            text: 'hello bob',
                        },
                    },
                },
                expect: {
                    connection: 'bobRtc',
                    message: {
                        topic: 'chat.message',
                    },
                },
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
        '-e',
        'dry',
    ])

    assertEquals(result.code, 0)
    assertEquals(result.stderr, '')

    const interactions = JSON.parse(result.stdout)

    assertEquals(Array.isArray(interactions), true)
    assertEquals(interactions.length, 2)

    assertEquals(interactions[0].RTC.request.action, 'connect')
    assertEquals(interactions[0].RTC.request.connection, 'aliceRtc')
    assertEquals(interactions[0].RTC.request.provider, 'rallar-stub')
    assertEquals(interactions[0].RTC.request.actor, 'alice')
    assertEquals(interactions[0].RTC.request.roomId, 'room-1')

    assertEquals(interactions[1].RTC.request.action, 'send')
    assertEquals(interactions[1].RTC.request.connection, 'aliceRtc')
    assertEquals(interactions[1].RTC.response.connection, 'bobRtc')
    assertEquals(interactions[1].RTC.response.message, {
        topic: 'chat.message',
    })
})

Deno.test('scenario-black-box CLI executes rtc.connect and rtc.send with stub rallar provider', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-stub',
                actor: 'alice',
                roomId: 'room-1',
            },
            bobRtc: {
                type: 'rtc',
                provider: 'rallar-stub',
                actor: 'bob',
                roomId: 'room-1',
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
                name: 'aliceSendsMessage',
                type: 'rtc.send',
                connection: 'aliceRtc',
                request: {
                    send: {
                        topic: 'chat.message',
                        payload: {
                            text: 'hello bob',
                        },
                    },
                },
                expect: {
                    connection: 'bobRtc',
                    withinMs: 1000,
                    consume: true,
                    message: {
                        topic: 'chat.message',
                        payload: {
                            text: 'hello bob',
                        },
                    },
                },
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 0)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 0)
    assertEquals(report.summary.success, 3)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.connectBob[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsMessage[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsMessage[0].actual.stub, true)
    assertEquals(report.rtcProviderNames.includes('rallar-stub'), true)
})

Deno.test('scenario-black-box CLI executes rtc.send with ordered expect.messages', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-stub',
                actor: 'alice',
                roomId: 'room-1',
            },
            bobRtc: {
                type: 'rtc',
                provider: 'rallar-stub',
                actor: 'bob',
                roomId: 'room-1',
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
                name: 'aliceEmitsJoinFlow',
                type: 'rtc.send',
                connection: 'aliceRtc',
                request: {
                    deliverMessages: [
                        {
                            topic: 'room.member.joined',
                            payload: {
                                actor: 'alice',
                            },
                        },
                        {
                            topic: 'presence.update',
                            payload: {
                                actor: 'alice',
                                online: true,
                            },
                        },
                    ],
                },
                expect: {
                    connection: 'bobRtc',
                    withinMs: 1000,
                    ordered: true,
                    consume: true,
                    messages: [
                        {
                            topic: 'room.member.joined',
                        },
                        {
                            topic: 'presence.update',
                        },
                    ],
                },
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 0)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.aliceEmitsJoinFlow[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceEmitsJoinFlow[0].actual.ordered, true)
    assertEquals(report.resultsByName.aliceEmitsJoinFlow[0].actual.matchedMessages.length, 2)
})

Deno.test('scenario-black-box CLI reports failure when ordered RTC messages are in wrong order', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-stub',
                actor: 'alice',
                roomId: 'room-1',
            },
            bobRtc: {
                type: 'rtc',
                provider: 'rallar-stub',
                actor: 'bob',
                roomId: 'room-1',
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
                name: 'aliceEmitsWrongOrder',
                type: 'rtc.send',
                connection: 'aliceRtc',
                request: {
                    deliverMessages: [
                        {
                            topic: 'presence.update',
                        },
                        {
                            topic: 'room.member.joined',
                        },
                    ],
                },
                expect: {
                    connection: 'bobRtc',
                    withinMs: 100,
                    ordered: true,
                    messages: [
                        {
                            topic: 'room.member.joined',
                        },
                        {
                            topic: 'presence.update',
                        },
                    ],
                },
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 1)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 1)
    assertEquals(report.summary.firstFailure.name, 'aliceEmitsWrongOrder')
    assertStringIncludes(
        report.summary.firstFailure.result,
        'Expected RTC messages were not received in the expected order',
    )
})

Deno.test('scenario-black-box CLI executes rtc.close and rtc.wait expect.close', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-stub',
                actor: 'alice',
                roomId: 'room-1',
            },
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc',
            },
            {
                name: 'closeAlice',
                type: 'rtc.close',
                connection: 'aliceRtc',
            },
            {
                name: 'aliceClosed',
                type: 'rtc.wait',
                connection: 'aliceRtc',
                expect: {
                    withinMs: 1000,
                    close: true,
                },
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 0)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.aliceClosed[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceClosed[0].actual.matchedCloseEvent.stub, true)
})

Deno.test('scenario-black-box CLI auto-closes unclosed RTC stub connections', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-stub',
                actor: 'alice',
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
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 0)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 0)
    assertEquals(report.rtcConnections, {})
    assertEquals(report.rtcCloseEvents.aliceRtc[0].autoCloseRequested, true)
    assertEquals(report.rtcCloseEvents.aliceRtc[0].stub, true)
})

Deno.test('scenario-black-box CLI reports clear failure for rallar provider missing signalingUrl', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar',
                actor: 'alice',
                roomId: 'room-1',
            },
        },
        steps: [
            {
                name: 'connectAliceRealRallar',
                type: 'rtc.connect',
                connection: 'aliceRtc',
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 1)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 1)
    assertEquals(report.summary.firstFailure.name, 'connectAliceRealRallar')
    assertEquals(report.resultsByName.connectAliceRealRallar[0].status, 'FAILURE')
    assertEquals(report.resultsByName.connectAliceRealRallar[0].result, 'RTC connect failed')
    assertEquals(
        report.resultsByName.connectAliceRealRallar[0].actual.exception,
        'Rallar WebRTC signalingUrl is required for connection: aliceRtc',
    )
    assertEquals(report.rtcProviderNames.includes('rallar'), true)
    assertEquals(report.rtcProviderNames.includes('rallar-stub'), true)
    assertEquals(report.rtcProviderNames.includes('rallar-memory'), true)
})

Deno.test('scenario-black-box CLI default rallar provider is WebSocket signaling-only', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1',
                groupId: 'group-1',
                overlayId: 'overlay-1',
            },
        },
        steps: [
            {
                name: 'connectAliceDefaultRallar',
                type: 'rtc.connect',
                connection: 'aliceRtc',
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 1)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)
    const connectResult = report.resultsByName.connectAliceDefaultRallar[0]

    assertEquals(report.summary.failure, 1)
    assertEquals(connectResult.status, 'FAILURE')
    assertEquals(connectResult.result, 'RTC connect failed')
    assertEquals(connectResult.provider, 'rallar')
    assertEquals(connectResult.peerId, 'alice')
    assertEquals(connectResult.groupId, 'group-1')
    assertEquals(connectResult.overlayId, 'overlay-1')
    assertEquals(
        connectResult.actual.exception,
        'Rallar WebRTC signalingUrl is required for connection: aliceRtc',
    )
})

Deno.test('scenario-black-box CLI default rallar provider waits for WebSocket open', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1',
                groupId: 'group-1',
                overlayId: 'overlay-1',
                signalingUrl: 'ws://localhost:65534/ws',
                openTimeoutMs: 50,
            },
        },
        steps: [
            {
                name: 'connectAliceDefaultRallarWithUrl',
                type: 'rtc.connect',
                connection: 'aliceRtc',
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 1)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)
    const connectResult = report.resultsByName.connectAliceDefaultRallarWithUrl[0]

    assertEquals(report.summary.failure, 1)
    assertEquals(connectResult.status, 'FAILURE')
    assertEquals(connectResult.result, 'RTC connect failed')
    assertEquals(connectResult.provider, 'rallar')
    assertEquals(connectResult.peerId, 'alice')
    assertEquals(connectResult.groupId, 'group-1')
    assertEquals(connectResult.overlayId, 'overlay-1')
    assertEquals(
        String(connectResult.actual.exception).startsWith('Rallar WebRTC signaling transport failed before open.'),
        true,
    )
})

Deno.test('scenario-black-box CLI dry mode normalizes rallar WebSocket signaling-only config', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1',
                groupId: 'group-1',
                overlayId: 'overlay-1',
                signalingUrl: 'ws://localhost:8080/ws',
                waitForOpen: true,
                openTimeoutMs: 1000,
            },
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc',
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
        '--dry-run',
    ])

    assertEquals(result.code, 0)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 0)
    assertEquals(report.summary.total, 1)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.connectAlice[0].actual.dryRun, true)
    assertEquals(report.resultsByName.connectAlice[0].actual.normalized.provider, 'rallar')
    assertEquals(report.resultsByName.connectAlice[0].actual.normalized.signalingUrl, 'ws://localhost:8080/ws')
    assertEquals(report.resultsByName.connectAlice[0].actual.normalized.groupId, 'group-1')
    assertEquals(report.resultsByName.connectAlice[0].actual.normalized.overlayId, 'overlay-1')
    assertEquals(report.resultsByName.connectAlice[0].actual.normalized.waitForOpen, true)
    assertEquals(report.resultsByName.connectAlice[0].actual.normalized.openTimeoutMs, 1000)
})

Deno.test('scenario-black-box CLI short dry-run flag normalizes rallar WebSocket signaling-only config', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1',
                groupId: 'group-1',
                overlayId: 'overlay-1',
                signalingUrl: 'ws://localhost:8080/ws',
                waitForOpen: true,
                openTimeoutMs: 1000,
            },
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc',
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
        '-n',
    ])

    assertEquals(result.code, 0)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 0)
    assertEquals(report.summary.total, 1)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.connectAlice[0].actual.dryRun, true)
    assertEquals(report.resultsByName.connectAlice[0].actual.normalized.provider, 'rallar')
    assertEquals(report.resultsByName.connectAlice[0].actual.normalized.signalingUrl, 'ws://localhost:8080/ws')
    assertEquals(report.resultsByName.connectAlice[0].actual.normalized.groupId, 'group-1')
    assertEquals(report.resultsByName.connectAlice[0].actual.normalized.overlayId, 'overlay-1')
    assertEquals(report.resultsByName.connectAlice[0].actual.normalized.waitForOpen, true)
    assertEquals(report.resultsByName.connectAlice[0].actual.normalized.openTimeoutMs, 1000)
})

Deno.test('scenario-black-box CLI execution dry prints executable RTC interactions instead of report', async () => {
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
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
        '-e',
        'dry',
    ])

    assertEquals(result.code, 0)
    assertEquals(result.stderr, '')

    const interactions = JSON.parse(result.stdout)

    assertEquals(Array.isArray(interactions), true)
    assertEquals(interactions.length, 1)
    assertEquals(interactions[0].RTC.request.action, 'connect')
    assertEquals(interactions[0].RTC.request.connection, 'aliceRtc')
    assertEquals(interactions[0].RTC.request.provider, 'unknown-rtc-provider')
    assertEquals(interactions[0].RTC.request.roomId, 'room-1')
    assertEquals(interactions[0].summary, undefined)
})

Deno.test('scenario-black-box CLI dry-run returns report instead of executable RTC interactions', async () => {
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
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
        '--dry-run',
    ])

    assertEquals(result.code, 0)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(Array.isArray(report), false)
    assertEquals(report.summary.failure, 0)
    assertEquals(report.summary.success, 1)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.connectAlice[0].actual.dryRun, true)
    assertEquals(report.resultsByName.connectAlice[0].actual.normalized.provider, 'unknown-rtc-provider')
    assertEquals(report.resultsByName.connectAlice[0].actual.normalized.roomId, 'room-1')
})

Deno.test('scenario-black-box CLI config execution dryRun normalizes rallar WebSocket signaling-only config', async () => {
    const workingDirectory = await writeTempConfig({
        execution: {
            dryRun: true,
        },
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1',
                groupId: 'group-1',
                overlayId: 'overlay-1',
                signalingUrl: 'ws://localhost:8080/ws',
                waitForOpen: true,
                openTimeoutMs: 1000,
            },
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc',
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 0)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 0)
    assertEquals(report.summary.total, 1)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.connectAlice[0].actual.dryRun, true)
    assertEquals(report.resultsByName.connectAlice[0].actual.normalized.provider, 'rallar')
    assertEquals(report.resultsByName.connectAlice[0].actual.normalized.signalingUrl, 'ws://localhost:8080/ws')
    assertEquals(report.resultsByName.connectAlice[0].actual.normalized.groupId, 'group-1')
    assertEquals(report.resultsByName.connectAlice[0].actual.normalized.overlayId, 'overlay-1')
    assertEquals(report.resultsByName.connectAlice[0].actual.normalized.waitForOpen, true)
    assertEquals(report.resultsByName.connectAlice[0].actual.normalized.openTimeoutMs, 1000)
})

Deno.test('scenario-black-box CLI dry-run does not require configured RTC provider', async () => {
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
                name: 'connectAliceWithUnknownProvider',
                type: 'rtc.connect',
                connection: 'aliceRtc',
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
                            text: 'dry-run should not need provider',
                        },
                    },
                },
            },
            {
                name: 'closeAliceWithUnknownProvider',
                type: 'rtc.close',
                connection: 'aliceRtc',
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
        '--dry-run',
    ])

    assertEquals(result.code, 0)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 0)
    assertEquals(report.summary.total, 3)
    assertEquals(report.rtcConnections, {})
    assertEquals(report.rtcMessages, {})
    assertEquals(report.rtcCloseEvents, {})
    assertEquals(report.resultsByName.connectAliceWithUnknownProvider[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsWithUnknownProvider[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.closeAliceWithUnknownProvider[0].status, 'SUCCESS')

    assertEquals(report.resultsByName.connectAliceWithUnknownProvider[0].actual.dryRun, true)
    assertEquals(report.resultsByName.aliceSendsWithUnknownProvider[0].actual.dryRun, true)
    assertEquals(report.resultsByName.closeAliceWithUnknownProvider[0].actual.dryRun, true)

    assertEquals(report.resultsByName.connectAliceWithUnknownProvider[0].actual.normalized.provider, 'unknown-rtc-provider')
    assertEquals(report.resultsByName.aliceSendsWithUnknownProvider[0].actual.normalized.provider, 'unknown-rtc-provider')
    assertEquals(report.resultsByName.closeAliceWithUnknownProvider[0].actual.normalized.provider, 'unknown-rtc-provider')

    assertEquals(
        report.resultsByName.aliceSendsWithUnknownProvider[0].actual.normalized.send,
        {
            topic: 'chat.message',
            payload: {
                from: 'alice',
                text: 'dry-run should not need provider',
            },
        },
    )
})

Deno.test('scenario-black-box CLI dry-run normalizes rallar signaling close wait expectation', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1',
                groupId: 'group-1',
                overlayId: 'overlay-1',
                signalingUrl: 'ws://localhost:8080/ws',
                waitForOpen: true,
            },
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
                        roomId: 'room-1',
                    },
                },
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
        '--dry-run',
    ])

    assertEquals(result.code, 0)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 0)
    assertEquals(report.summary.total, 1)
    assertEquals(report.rtcConnections, {})
    assertEquals(report.rtcMessages, {})
    assertEquals(report.rtcCloseEvents, {})
    assertEquals(report.resultsByName.waitForSignalingClose[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.waitForSignalingClose[0].actual.dryRun, true)
    assertEquals(report.resultsByName.waitForSignalingClose[0].actual.normalized.provider, 'rallar')
    assertEquals(report.resultsByName.waitForSignalingClose[0].actual.normalized.connection, 'aliceRtc')
    assertEquals(report.resultsByName.waitForSignalingClose[0].actual.normalized.groupId, 'group-1')
    assertEquals(report.resultsByName.waitForSignalingClose[0].actual.normalized.overlayId, 'overlay-1')
    assertEquals(report.resultsByName.waitForSignalingClose[0].actual.normalized.action, 'wait')
    assertEquals(report.resultsByName.waitForSignalingClose[0].actual.normalized.response.withinMs, 1000)
    assertEquals(report.resultsByName.waitForSignalingClose[0].actual.normalized.response.close.phase, 'signaling-close')
    assertEquals(report.resultsByName.waitForSignalingClose[0].actual.normalized.response.close.reason, 'rallar WebRTC signaling session closed')
    assertEquals(report.resultsByName.waitForSignalingClose[0].actual.normalized.response.close.connection, 'aliceRtc')
    assertEquals(report.resultsByName.waitForSignalingClose[0].actual.normalized.response.close.peerId, 'alice')
    assertEquals(report.resultsByName.waitForSignalingClose[0].actual.normalized.response.close.roomId, 'room-1')
})

Deno.test('scenario-black-box CLI dry mode normalizes rallar signaling send expectation', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1',
                groupId: 'group-1',
                overlayId: 'overlay-1',
                signalingUrl: 'ws://localhost:8080/ws',
                waitForOpen: true,
            },
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
                            sdp: 'fake-offer-sdp',
                        },
                    },
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
                                sdp: 'fake-answer-sdp',
                            },
                        },
                    },
                },
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
        '--dry-run',
    ])

    assertEquals(result.code, 0)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 0)
    assertEquals(report.summary.total, 1)
    assertEquals(report.rtcConnections, {})
    assertEquals(report.rtcMessages, {})
    assertEquals(report.rtcCloseEvents, {})
    assertEquals(report.resultsByName.aliceSendsSignalingOffer[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsSignalingOffer[0].actual.dryRun, true)
    assertEquals(report.resultsByName.aliceSendsSignalingOffer[0].actual.normalized.provider, 'rallar')
    assertEquals(report.resultsByName.aliceSendsSignalingOffer[0].actual.normalized.connection, 'aliceRtc')
    assertEquals(
        report.resultsByName.aliceSendsSignalingOffer[0].actual.normalized.send,
        {
            topic: 'rallar.existing.signaling.offer',
            payload: {
                from: 'alice',
                to: 'bob',
                sdp: 'fake-offer-sdp',
            },
        },
    )
    assertEquals(
        report.resultsByName.aliceSendsSignalingOffer[0].actual.normalized.response.message.topic,
        'rallar.webrtc.signaling.message',
    )
})

Deno.test('scenario-black-box CLI report includes default RTC provider names', async () => {
    const workingDirectory = await writeTempConfig({
        steps: [],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 0)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 0)
    assertEquals(report.rtcProviderNames.includes('rallar'), true)
    assertEquals(report.rtcProviderNames.includes('rallar-stub'), true)
    assertEquals(report.rtcProviderNames.includes('rallar-memory'), true)
})

Deno.test('scenario-black-box CLI can execute two-peer RTC flow with rallar-memory provider', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                remotePeerId: 'bob',
                roomId: 'room-1',
            },
            bobRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'bob',
                peerId: 'bob',
                remotePeerId: 'alice',
                roomId: 'room-1',
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
                        topic: 'chat.message',
                        payload: {
                            from: 'alice',
                            to: 'bob',
                            text: 'hello bob',
                        },
                    },
                },
                expect: {
                    connection: 'bobRtc',
                    withinMs: 1000,
                    message: {
                        topic: 'chat.message',
                        payload: {
                            from: 'alice',
                            to: 'bob',
                            text: 'hello bob',
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
                        topic: 'chat.message',
                        payload: {
                            from: 'bob',
                            to: 'alice',
                            text: 'hello alice',
                        },
                    },
                },
                expect: {
                    connection: 'aliceRtc',
                    withinMs: 1000,
                    message: {
                        topic: 'chat.message',
                        payload: {
                            from: 'bob',
                            to: 'alice',
                            text: 'hello alice',
                        },
                    },
                },
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 0)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.connectBob[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsToBob[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.bobSendsToAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveredBy, 'rallar-in-memory-runtime')
    assertEquals(report.resultsByName.bobSendsToAlice[0].actual.matchedMessage.data.deliveredBy, 'rallar-in-memory-runtime')
    assertEquals(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveredTo, 'bob')
    assertEquals(report.resultsByName.bobSendsToAlice[0].actual.matchedMessage.data.deliveredTo, 'alice')
    assertEquals(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliverySequence, 1)
    assertEquals(report.resultsByName.bobSendsToAlice[0].actual.matchedMessage.data.deliverySequence, 2)
})

Deno.test('scenario-black-box CLI routes rallar-memory payload target before remotePeerId', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                remotePeerId: 'bob',
                roomId: 'room-1',
            },
            bobRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'bob',
                peerId: 'bob',
                remotePeerId: 'alice',
                roomId: 'room-1',
            },
            charlieRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'charlie',
                peerId: 'charlie',
                remotePeerId: 'alice',
                roomId: 'room-1',
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
                name: 'connectCharlie',
                type: 'rtc.connect',
                connection: 'charlieRtc',
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
                            text: 'hello charlie',
                        },
                    },
                },
                expect: {
                    connection: 'charlieRtc',
                    withinMs: 1000,
                    message: {
                        topic: 'chat.message',
                        payload: {
                            from: 'alice',
                            to: 'charlie',
                            text: 'hello charlie',
                        },
                    },
                },
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
                            text: 'hello charlie',
                        },
                    },
                },
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 1)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.aliceSendsPayloadTargetToCharlie[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsPayloadTargetToCharlie[0].actual.matchedMessage.data.deliveredBy, 'rallar-in-memory-runtime')
    assertEquals(report.resultsByName.bobDoesNotReceiveCharlieTargetedMessage[0].status, 'FAILURE')
    assertEquals(report.resultsByName.bobDoesNotReceiveCharlieTargetedMessage[0].result, 'Expected RTC message was not received')
    assertEquals(report.resultsByName.aliceSendsPayloadTargetToCharlie[0].actual.matchedMessage.data.deliveredTo, 'charlie')
})

Deno.test('scenario-black-box CLI can broadcast within room with rallar-memory provider', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1',
            },
            bobRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'bob',
                peerId: 'bob',
                roomId: 'room-1',
            },
            charlieRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'charlie',
                peerId: 'charlie',
                roomId: 'room-2',
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
                name: 'connectCharlieDifferentRoom',
                type: 'rtc.connect',
                connection: 'charlieRtc',
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
                            online: true,
                        },
                    },
                },
                expect: {
                    connection: 'bobRtc',
                    withinMs: 1000,
                    message: {
                        topic: 'presence.update',
                        payload: {
                            from: 'alice',
                            online: true,
                        },
                    },
                },
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
                            online: true,
                        },
                    },
                },
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 1)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.aliceBroadcastsPresence[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceBroadcastsPresence[0].actual.matchedMessage.data.deliveredBy, 'rallar-in-memory-runtime')
    assertEquals(report.resultsByName.charlieDoesNotReceiveOtherRoomBroadcast[0].status, 'FAILURE')
    assertEquals(report.resultsByName.charlieDoesNotReceiveOtherRoomBroadcast[0].result, 'Expected RTC message was not received')
})

Deno.test('scenario-black-box CLI can explicitly broadcast with rallar-memory provider even when remotePeerId is configured', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                remotePeerId: 'bob',
                roomId: 'room-1',
            },
            bobRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'bob',
                peerId: 'bob',
                remotePeerId: 'alice',
                roomId: 'room-1',
            },
            charlieRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'charlie',
                peerId: 'charlie',
                roomId: 'room-1',
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
                name: 'connectCharlie',
                type: 'rtc.connect',
                connection: 'charlieRtc',
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
                            online: true,
                        },
                    },
                },
                expect: {
                    connection: 'bobRtc',
                    withinMs: 1000,
                    message: {
                        topic: 'presence.update',
                        broadcast: true,
                        payload: {
                            from: 'alice',
                            online: true,
                        },
                    },
                },
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
                            online: true,
                        },
                    },
                },
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 0)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.aliceExplicitlyBroadcastsPresence[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.charlieReceivesExplicitBroadcast[0].status, 'SUCCESS')
    assertEquals(
        report.resultsByName.aliceExplicitlyBroadcastsPresence[0].actual.matchedMessage.data.deliveredBy,
        'rallar-in-memory-runtime',
    )
    assertEquals(
        report.resultsByName.charlieReceivesExplicitBroadcast[0].actual.matchedMessage.data.deliveredBy,
        'rallar-in-memory-runtime',
    )
    assertEquals(
        report.resultsByName.aliceExplicitlyBroadcastsPresence[0].actual.matchedMessage.data.deliveredTo,
        'bob',
    )
    assertEquals(
        report.resultsByName.charlieReceivesExplicitBroadcast[0].actual.matchedMessage.data.deliveredTo,
        'charlie',
    )

    assertEquals(report.resultsByName.aliceExplicitlyBroadcastsPresence[0].actual.matchedMessage.data.deliverySequence, 1)
    assertEquals(report.resultsByName.charlieReceivesExplicitBroadcast[0].actual.matchedMessage.data.deliverySequence, 2)
})

Deno.test('scenario-black-box CLI can explicitly broadcast with payload broadcast flag and rallar-memory provider', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                remotePeerId: 'bob',
                roomId: 'room-1',
            },
            bobRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'bob',
                peerId: 'bob',
                remotePeerId: 'alice',
                roomId: 'room-1',
            },
            charlieRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'charlie',
                peerId: 'charlie',
                roomId: 'room-1',
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
                name: 'connectCharlie',
                type: 'rtc.connect',
                connection: 'charlieRtc',
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
                            online: true,
                        },
                    },
                },
                expect: {
                    connection: 'bobRtc',
                    withinMs: 1000,
                    message: {
                        topic: 'presence.update',
                        payload: {
                            broadcast: true,
                            from: 'alice',
                            online: true,
                        },
                    },
                },
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
                            online: true,
                        },
                    },
                },
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 0)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.alicePayloadBroadcastsPresence[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.charlieReceivesPayloadBroadcast[0].status, 'SUCCESS')
    assertEquals(
        report.resultsByName.alicePayloadBroadcastsPresence[0].actual.matchedMessage.data.deliveredBy,
        'rallar-in-memory-runtime',
    )
    assertEquals(
        report.resultsByName.charlieReceivesPayloadBroadcast[0].actual.matchedMessage.data.deliveredBy,
        'rallar-in-memory-runtime',
    )
    assertEquals(
        report.resultsByName.alicePayloadBroadcastsPresence[0].actual.matchedMessage.data.deliveredTo,
        'bob',
    )
    assertEquals(
        report.resultsByName.charlieReceivesPayloadBroadcast[0].actual.matchedMessage.data.deliveredTo,
        'charlie',
    )
})

Deno.test('scenario-black-box CLI reports failure when rallar-memory broadcast has no targets', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
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
            {
                name: 'aliceBroadcastsToEmptyRoom',
                type: 'rtc.send',
                connection: 'aliceRtc',
                request: {
                    send: {
                        topic: 'presence.update',
                        payload: {
                            from: 'alice',
                            online: true,
                        },
                    },
                },
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 1)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 1)
    assertEquals(report.summary.firstFailure.name, 'aliceBroadcastsToEmptyRoom')
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceBroadcastsToEmptyRoom[0].status, 'FAILURE')
    assertEquals(report.resultsByName.aliceBroadcastsToEmptyRoom[0].result, 'RTC send failed')
    assertEquals(
        report.resultsByName.aliceBroadcastsToEmptyRoom[0].actual.exception,
        'Rallar in-memory RTC broadcast has no connected targets for peer: alice',
    )
})

Deno.test('scenario-black-box CLI reports failure when rallar-memory direct target is missing', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                remotePeerId: 'missing-bob',
                roomId: 'room-1',
            },
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc',
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
                            text: 'hello missing bob',
                        },
                    },
                },
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 1)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 1)
    assertEquals(report.summary.firstFailure.name, 'aliceSendsToMissingBob')
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsToMissingBob[0].status, 'FAILURE')
    assertEquals(report.resultsByName.aliceSendsToMissingBob[0].result, 'RTC send failed')
    assertEquals(
        report.resultsByName.aliceSendsToMissingBob[0].actual.exception,
        'Rallar in-memory RTC target is not connected: missing-bob',
    )
})

Deno.test('scenario-black-box CLI can close and wait for close with rallar-memory provider', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
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
            {
                name: 'closeAlice',
                type: 'rtc.close',
                connection: 'aliceRtc',
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
                        peerId: 'alice',
                    },
                },
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 0)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.waitForAliceClose[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.phase, 'close')
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.reason, 'closed by rallar in-memory runtime')
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.peerId, 'alice')
})

Deno.test('scenario-black-box CLI reports failure when rallar-memory sends to peer after close', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                remotePeerId: 'bob',
                roomId: 'room-1',
            },
            bobRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'bob',
                peerId: 'bob',
                remotePeerId: 'alice',
                roomId: 'room-1',
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
                name: 'closeBob',
                type: 'rtc.close',
                connection: 'bobRtc',
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
                            text: 'are you still there?',
                        },
                    },
                },
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 1)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 1)
    assertEquals(report.summary.firstFailure.name, 'aliceSendsToClosedBob')
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.connectBob[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.closeBob[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsToClosedBob[0].status, 'FAILURE')
    assertEquals(report.resultsByName.aliceSendsToClosedBob[0].result, 'RTC send failed')
    assertEquals(
        report.resultsByName.aliceSendsToClosedBob[0].actual.exception,
        'Rallar in-memory RTC target is not connected: bob',
    )
})

Deno.test('scenario-black-box CLI auto-closes unclosed rallar-memory connections', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                remotePeerId: 'bob',
                roomId: 'room-1',
            },
            bobRtc: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'bob',
                peerId: 'bob',
                remotePeerId: 'alice',
                roomId: 'room-1',
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
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 0)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.connectBob[0].status, 'SUCCESS')
    assertEquals(report.rtcConnections, {})

    const aliceAutoCloseEvent = report.rtcCloseEvents.aliceRtc
        .find((event: any) => event.autoCloseRequested === true)
    const bobAutoCloseEvent = report.rtcCloseEvents.bobRtc
        .find((event: any) => event.autoCloseRequested === true)

    assertEquals(aliceAutoCloseEvent?.autoCloseRequested, true)
    assertEquals(aliceAutoCloseEvent?.autoCloseSucceeded, true)
    assertEquals(bobAutoCloseEvent?.autoCloseRequested, true)
    assertEquals(bobAutoCloseEvent?.autoCloseSucceeded, true)

    const aliceRuntimeCloseEvent = report.rtcCloseEvents.aliceRtc
        .find((event: any) => event.reason === 'closed by rallar in-memory runtime')
    const bobRuntimeCloseEvent = report.rtcCloseEvents.bobRtc
        .find((event: any) => event.reason === 'closed by rallar in-memory runtime')

    assertEquals(aliceRuntimeCloseEvent?.phase, 'close')
    assertEquals(aliceRuntimeCloseEvent?.closedBy, 'rallar-in-memory-runtime')
    assertEquals(aliceRuntimeCloseEvent?.connection, 'aliceRtc')
    assertEquals(aliceRuntimeCloseEvent?.actor, 'alice')
    assertEquals(aliceRuntimeCloseEvent?.peerId, 'alice')
    assertEquals(aliceRuntimeCloseEvent?.roomId, 'room-1')

    assertEquals(bobRuntimeCloseEvent?.phase, 'close')
    assertEquals(bobRuntimeCloseEvent?.closedBy, 'rallar-in-memory-runtime')
    assertEquals(bobRuntimeCloseEvent?.connection, 'bobRtc')
    assertEquals(bobRuntimeCloseEvent?.actor, 'bob')
    assertEquals(bobRuntimeCloseEvent?.peerId, 'bob')
    assertEquals(bobRuntimeCloseEvent?.roomId, 'room-1')
})

Deno.test('scenario-black-box CLI reports failure when rallar-memory peer connects twice', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtcOne: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1',
            },
            aliceRtcTwo: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1',
            },
        },
        steps: [
            {
                name: 'connectAliceFirst',
                type: 'rtc.connect',
                connection: 'aliceRtcOne',
            },
            {
                name: 'connectAliceSecond',
                type: 'rtc.connect',
                connection: 'aliceRtcTwo',
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 1)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 1)
    assertEquals(report.summary.firstFailure.name, 'connectAliceSecond')
    assertEquals(report.resultsByName.connectAliceFirst[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.connectAliceSecond[0].status, 'FAILURE')
    assertEquals(report.resultsByName.connectAliceSecond[0].result, 'RTC connect failed')
    assertEquals(
        report.resultsByName.connectAliceSecond[0].actual.exception,
        'Rallar in-memory RTC peer is already connected: alice',
    )
})

Deno.test('scenario-black-box CLI allows rallar-memory peer to reconnect after close', async () => {
    const workingDirectory = await writeTempConfig({
        connections: {
            aliceRtcOne: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1',
            },
            aliceRtcTwo: {
                type: 'rtc',
                provider: 'rallar-memory',
                actor: 'alice',
                peerId: 'alice',
                roomId: 'room-1',
            },
        },
        steps: [
            {
                name: 'connectAliceFirst',
                type: 'rtc.connect',
                connection: 'aliceRtcOne',
            },
            {
                name: 'closeAliceFirst',
                type: 'rtc.close',
                connection: 'aliceRtcOne',
            },
            {
                name: 'connectAliceSecond',
                type: 'rtc.connect',
                connection: 'aliceRtcTwo',
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 0)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAliceFirst[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.closeAliceFirst[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.connectAliceSecond[0].status, 'SUCCESS')

    const aliceRuntimeCloseEvent = report.rtcCloseEvents.aliceRtcOne
        .find((event: any) => event.reason === 'closed by rallar in-memory runtime')

    assertEquals(aliceRuntimeCloseEvent?.phase, 'close')
    assertEquals(aliceRuntimeCloseEvent?.closedBy, 'rallar-in-memory-runtime')
    assertEquals(aliceRuntimeCloseEvent?.connection, 'aliceRtcOne')
    assertEquals(aliceRuntimeCloseEvent?.actor, 'alice')
    assertEquals(aliceRuntimeCloseEvent?.peerId, 'alice')
    assertEquals(aliceRuntimeCloseEvent?.roomId, 'room-1')
})

Deno.test('scenario-black-box CLI rallar-memory close event includes diagnostics', async () => {
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
            },
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc',
            },
            {
                name: 'closeAlice',
                type: 'rtc.close',
                connection: 'aliceRtc',
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
                        overlayId: 'overlay-1',
                    },
                },
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 0)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.waitForAliceClose[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.closedBy, 'rallar-in-memory-runtime')
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.connection, 'aliceRtc')
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.actor, 'alice')
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.peerId, 'alice')
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.roomId, 'room-1')
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.groupId, 'group-1')
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.overlayId, 'overlay-1')
})

Deno.test('scenario-black-box CLI RTC success report includes generic routing diagnostics', async () => {
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
                remotePeerId: 'bob',
            },
        },
        steps: [
            {
                name: 'connectAlice',
                type: 'rtc.connect',
                connection: 'aliceRtc',
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 0)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)
    const connectResult = report.resultsByName.connectAlice[0]

    assertEquals(report.summary.failure, 0)
    assertEquals(connectResult.status, 'SUCCESS')
    assertEquals(connectResult.provider, 'rallar-memory')
    assertEquals(connectResult.actor, 'alice')
    assertEquals(connectResult.peerId, 'alice')
    assertEquals(connectResult.roomId, 'room-1')
    assertEquals(connectResult.groupId, 'group-1')
    assertEquals(connectResult.overlayId, 'overlay-1')
    assertEquals(connectResult.remotePeerId, 'bob')
    assertEquals(connectResult.action, 'connect')
    assertEquals(connectResult.connection, 'aliceRtc')
    assertEquals(connectResult.actual.provider, 'rallar-memory')
    assertEquals(connectResult.actual.actor, 'alice')
    assertEquals(connectResult.actual.peerId, 'alice')
    assertEquals(connectResult.actual.roomId, 'room-1')
    assertEquals(connectResult.actual.groupId, 'group-1')
    assertEquals(connectResult.actual.overlayId, 'overlay-1')
    assertEquals(connectResult.actual.remotePeerId, 'bob')
    assertEquals(connectResult.actual.action, 'connect')
    assertEquals(connectResult.actual.connection, 'aliceRtc')
})

Deno.test('scenario-black-box CLI RTC failure report includes generic routing diagnostics', async () => {
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
                remotePeerId: 'bob',
            },
        },
        steps: [
            {
                name: 'connectAliceMissingProvider',
                type: 'rtc.connect',
                connection: 'aliceRtc',
            },
        ],
    })

    const result = await runScenarioCli([
        '-w',
        workingDirectory,
        '-c',
        'config.json',
    ])

    assertEquals(result.code, 1)
    assertEquals(result.stderr, '')

    const report = JSON.parse(result.stdout)
    const connectResult = report.resultsByName.connectAliceMissingProvider[0]

    assertEquals(report.summary.failure, 1)
    assertEquals(connectResult.status, 'FAILURE')
    assertEquals(connectResult.result, 'RTC provider is not configured: missing-provider')
    assertEquals(connectResult.provider, 'missing-provider')
    assertEquals(connectResult.actor, 'alice')
    assertEquals(connectResult.peerId, 'alice')
    assertEquals(connectResult.roomId, 'room-1')
    assertEquals(connectResult.groupId, 'group-1')
    assertEquals(connectResult.overlayId, 'overlay-1')
    assertEquals(connectResult.remotePeerId, 'bob')
    assertEquals(connectResult.action, 'connect')
    assertEquals(connectResult.connection, 'aliceRtc')
    assertEquals(connectResult.actual.provider, 'missing-provider')
    assertEquals(connectResult.actual.actor, 'alice')
    assertEquals(connectResult.actual.peerId, 'alice')
    assertEquals(connectResult.actual.roomId, 'room-1')
    assertEquals(connectResult.actual.groupId, 'group-1')
    assertEquals(connectResult.actual.overlayId, 'overlay-1')
    assertEquals(connectResult.actual.remotePeerId, 'bob')
    assertEquals(connectResult.actual.action, 'connect')
    assertEquals(connectResult.actual.connection, 'aliceRtc')
})