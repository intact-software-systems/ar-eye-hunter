import { expect, test } from 'bun:test';
import { executeBlackBox } from '../../../shared-test/black-box-runner/execute-black-box.ts';
import {
    createRallarInMemoryProvider,
    createRallarInMemoryRuntime
} from '../../../shared-test/black-box-runner/rallar-in-memory-runtime.ts';
import { createRallarWebRtcProvider } from '../../../shared-test/black-box-runner/rallar-webrtc-runtime.ts';

test('createRallarWebRtcProvider can execute two-peer scenario through in-memory runtime', async () => {
    const provider = createRallarWebRtcProvider({
        createSession: createRallarInMemoryRuntime({ now: Date.now, state: { connections: new Map(), nextDeliverySequence: 1 } }).connect
    });

    const aliceToBob = {
        topic: 'chat.message',
        payload: {
            from: 'alice',
            to: 'bob',
            text: 'hello bob'
        }
    };

    const bobToAlice = {
        topic: 'chat.message',
        payload: {
            from: 'bob',
            to: 'alice',
            text: 'hello alice'
        }
    };

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        remotePeerId: 'bob',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'bobRtc',
                        provider: 'rallar',
                        actor: 'bob',
                        peerId: 'bob',
                        remotePeerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                connectBob: {}
            },
            {
                RTC: {
                    request: {
                        action: 'send',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        remotePeerId: 'bob',
                        roomId: 'room-1',
                        send: aliceToBob,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3
                    },
                    response: {
                        connection: 'bobRtc',
                        withinMs: 1000,
                        message: aliceToBob
                    }
                },
                aliceSendsToBob: {}
            },
            {
                RTC: {
                    request: {
                        action: 'send',
                        connection: 'bobRtc',
                        provider: 'rallar',
                        actor: 'bob',
                        peerId: 'bob',
                        remotePeerId: 'alice',
                        roomId: 'room-1',
                        send: bobToAlice,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 4
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        message: bobToAlice
                    }
                },
                bobSendsToAlice: {}
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    expect(report.summary.failure).toEqual(0);
    expect(report.resultsByName.connectAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.connectBob[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.aliceSendsToBob[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.bobSendsToAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveredBy).toEqual('rallar-in-memory-runtime');
    expect(report.resultsByName.bobSendsToAlice[0].actual.matchedMessage.data.deliveredBy).toEqual('rallar-in-memory-runtime');
    expect(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveredTo).toEqual('bob');
    expect(report.resultsByName.bobSendsToAlice[0].actual.matchedMessage.data.deliveredTo).toEqual('alice');
    expect(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveryGroup).toEqual('room-1');
    expect(report.resultsByName.bobSendsToAlice[0].actual.matchedMessage.data.deliveryGroup).toEqual('room-1');
    expect(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveryMode).toEqual('direct');
    expect(report.resultsByName.bobSendsToAlice[0].actual.matchedMessage.data.deliveryMode).toEqual('direct');
    expect(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliverySequence).toEqual(1);
    expect(report.resultsByName.bobSendsToAlice[0].actual.matchedMessage.data.deliverySequence).toEqual(2);
});

test('createRallarWebRtcProvider routes in-memory message payload target before remotePeerId', async () => {
    const provider = createRallarWebRtcProvider({
        createSession: createRallarInMemoryRuntime({ now: Date.now, state: { connections: new Map(), nextDeliverySequence: 1 } }).connect
    });

    const messageToCharlie = {
        topic: 'chat.message',
        payload: {
            from: 'alice',
            to: 'charlie',
            text: 'hello charlie'
        }
    };

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        remotePeerId: 'bob',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'bobRtc',
                        provider: 'rallar',
                        actor: 'bob',
                        peerId: 'bob',
                        remotePeerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                connectBob: {}
            },
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'charlieRtc',
                        provider: 'rallar',
                        actor: 'charlie',
                        peerId: 'charlie',
                        remotePeerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3
                    },
                    response: {}
                },
                connectCharlie: {}
            },
            {
                RTC: {
                    request: {
                        action: 'send',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        remotePeerId: 'bob',
                        roomId: 'room-1',
                        send: messageToCharlie,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 4
                    },
                    response: {
                        connection: 'charlieRtc',
                        withinMs: 1000,
                        message: messageToCharlie
                    }
                },
                aliceSendsPayloadTargetToCharlie: {}
            },
            {
                RTC: {
                    request: {
                        action: 'wait',
                        connection: 'bobRtc',
                        provider: 'rallar',
                        actor: 'bob',
                        peerId: 'bob',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 5
                    },
                    response: {
                        connection: 'bobRtc',
                        withinMs: 100,
                        message: messageToCharlie
                    }
                },
                bobDoesNotReceiveCharlieTargetedMessage: {}
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    expect(report.summary.failure).toEqual(1);
    expect(report.resultsByName.aliceSendsPayloadTargetToCharlie[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.aliceSendsPayloadTargetToCharlie[0].actual.matchedMessage.data.deliveredBy).toEqual('rallar-in-memory-runtime');
    expect(report.resultsByName.aliceSendsPayloadTargetToCharlie[0].actual.matchedMessage.data.sentBy).toEqual('alice');
    expect(report.resultsByName.aliceSendsPayloadTargetToCharlie[0].actual.matchedMessage.data.deliveredTo).toEqual('charlie');
    expect(report.resultsByName.bobDoesNotReceiveCharlieTargetedMessage[0].status).toEqual('FAILURE');
    expect(report.resultsByName.bobDoesNotReceiveCharlieTargetedMessage[0].result).toEqual('Expected RTC message was not received');
});

test('createRallarInMemoryProvider can execute two-peer scenario', async () => {
    const provider = createRallarInMemoryProvider({ now: Date.now, state: { connections: new Map(), nextDeliverySequence: 1 } });

    const aliceToBob = {
        topic: 'chat.message',
        payload: {
            from: 'alice',
            to: 'bob',
            text: 'hello bob through provider factory'
        }
    };

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        remotePeerId: 'bob',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'bobRtc',
                        provider: 'rallar-memory',
                        actor: 'bob',
                        peerId: 'bob',
                        remotePeerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                connectBob: {}
            },
            {
                RTC: {
                    request: {
                        action: 'send',
                        connection: 'aliceRtc',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        remotePeerId: 'bob',
                        roomId: 'room-1',
                        send: aliceToBob,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3
                    },
                    response: {
                        connection: 'bobRtc',
                        withinMs: 1000,
                        message: aliceToBob
                    }
                },
                aliceSendsToBob: {}
            }
        ],
        0,
        {
            rtcProviders: {
                'rallar-memory': provider
            }
        }
    );

    expect(report.summary.failure).toEqual(0);
    expect(report.resultsByName.connectAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.connectBob[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.aliceSendsToBob[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveredBy).toEqual('rallar-in-memory-runtime');
    expect(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveryGroup).toEqual('room-1');
    expect(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveryMode).toEqual('direct');
    expect(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliverySequence).toEqual(1);
});

test('createRallarInMemoryProvider reports failure when peer connects twice', async () => {
    const provider = createRallarInMemoryProvider({ now: Date.now, state: { connections: new Map(), nextDeliverySequence: 1 } });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtcOne',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAliceFirst: {}
            },
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtcTwo',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                connectAliceSecond: {}
            }
        ],
        0,
        {
            rtcProviders: {
                'rallar-memory': provider
            }
        }
    );

    expect(report.summary.failure).toEqual(1);
    expect(report.resultsByName.connectAliceFirst[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.connectAliceSecond[0].status).toEqual('FAILURE');
    expect(report.resultsByName.connectAliceSecond[0].result).toEqual('RTC connect failed');
    expect(report.resultsByName.connectAliceSecond[0].actual.exception).toEqual('Rallar in-memory RTC peer is already connected: alice');
});

test('createRallarInMemoryProvider allows peer to reconnect after close', async () => {
    const provider = createRallarInMemoryProvider({ now: Date.now, state: { connections: new Map(), nextDeliverySequence: 1 } });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtcOne',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAliceFirst: {}
            },
            {
                RTC: {
                    request: {
                        action: 'close',
                        connection: 'aliceRtcOne',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                closeAliceFirst: {}
            },
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtcTwo',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3
                    },
                    response: {}
                },
                connectAliceSecond: {}
            }
        ],
        0,
        {
            rtcProviders: {
                'rallar-memory': provider
            }
        }
    );

    expect(report.summary.failure).toEqual(0);
    expect(report.resultsByName.connectAliceFirst[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.closeAliceFirst[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.connectAliceSecond[0].status).toEqual('SUCCESS');
});

test('createRallarInMemoryProvider emits close diagnostics', async () => {
    const provider = createRallarInMemoryProvider({ now: Date.now, state: { connections: new Map(), nextDeliverySequence: 1 } });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'close',
                        connection: 'aliceRtc',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                closeAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'wait',
                        connection: 'aliceRtc',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        close: {
                            phase: 'close',
                            reason: 'closed by rallar in-memory runtime',
                            closedBy: 'rallar-in-memory-runtime',
                            connection: 'aliceRtc',
                            actor: 'alice',
                            peerId: 'alice',
                            roomId: 'room-1'
                        }
                    }
                },
                waitForAliceClose: {}
            }
        ],
        0,
        {
            rtcProviders: {
                'rallar-memory': provider
            }
        }
    );

    expect(report.summary.failure).toEqual(0);
    expect(report.resultsByName.connectAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.closeAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.waitForAliceClose[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.closedBy).toEqual('rallar-in-memory-runtime');
    expect(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.connection).toEqual('aliceRtc');
    expect(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.roomId).toEqual('room-1');
});

test('createRallarInMemoryProvider emits group and overlay close diagnostics', async () => {
    const provider = createRallarInMemoryProvider({ now: Date.now, state: { connections: new Map(), nextDeliverySequence: 1 } });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        groupId: 'group-1',
                        overlayId: 'overlay-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'close',
                        connection: 'aliceRtc',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        groupId: 'group-1',
                        overlayId: 'overlay-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                closeAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'wait',
                        connection: 'aliceRtc',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        groupId: 'group-1',
                        overlayId: 'overlay-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3
                    },
                    response: {
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
                },
                waitForAliceClose: {}
            }
        ],
        0,
        {
            rtcProviders: {
                'rallar-memory': provider
            }
        }
    );

    expect(report.summary.failure).toEqual(0);
    expect(report.resultsByName.connectAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.closeAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.waitForAliceClose[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.groupId).toEqual('group-1');
    expect(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.overlayId).toEqual('overlay-1');
});

test('createRallarWebRtcProvider can broadcast through in-memory runtime when no target is specified', async () => {
    const provider = createRallarWebRtcProvider({
        createSession: createRallarInMemoryRuntime({ now: Date.now, state: { connections: new Map(), nextDeliverySequence: 1 } }).connect
    });

    const broadcastMessage = {
        topic: 'presence.update',
        payload: {
            from: 'alice',
            online: true
        }
    };

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'bobRtc',
                        provider: 'rallar',
                        actor: 'bob',
                        peerId: 'bob',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                connectBob: {}
            },
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'charlieRtc',
                        provider: 'rallar',
                        actor: 'charlie',
                        peerId: 'charlie',
                        roomId: 'room-2',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3
                    },
                    response: {}
                },
                connectCharlieDifferentRoom: {}
            },
            {
                RTC: {
                    request: {
                        action: 'send',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        send: broadcastMessage,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 4
                    },
                    response: {
                        connection: 'bobRtc',
                        withinMs: 1000,
                        message: broadcastMessage
                    }
                },
                aliceBroadcastsToRoom: {}
            },
            {
                RTC: {
                    request: {
                        action: 'wait',
                        connection: 'charlieRtc',
                        provider: 'rallar',
                        actor: 'charlie',
                        peerId: 'charlie',
                        roomId: 'room-2',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 5
                    },
                    response: {
                        connection: 'charlieRtc',
                        withinMs: 100,
                        message: broadcastMessage
                    }
                },
                charlieDoesNotReceiveOtherRoomBroadcast: {}
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    expect(report.summary.failure).toEqual(1);
    expect(report.resultsByName.aliceBroadcastsToRoom[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.aliceBroadcastsToRoom[0].actual.matchedMessage.data.deliveredBy).toEqual('rallar-in-memory-runtime');
    expect(report.resultsByName.charlieDoesNotReceiveOtherRoomBroadcast[0].status).toEqual('FAILURE');
    expect(report.resultsByName.charlieDoesNotReceiveOtherRoomBroadcast[0].result).toEqual('Expected RTC message was not received');
});

test('createRallarWebRtcProvider can broadcast through in-memory runtime with explicit broadcast flag', async () => {
    const provider = createRallarWebRtcProvider({
        createSession: createRallarInMemoryRuntime({ now: Date.now, state: { connections: new Map(), nextDeliverySequence: 1 } }).connect
    });

    const broadcastMessage = {
        topic: 'presence.update',
        broadcast: true,
        payload: {
            from: 'alice',
            online: true
        }
    };

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        remotePeerId: 'bob',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'bobRtc',
                        provider: 'rallar',
                        actor: 'bob',
                        peerId: 'bob',
                        remotePeerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                connectBob: {}
            },
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'charlieRtc',
                        provider: 'rallar',
                        actor: 'charlie',
                        peerId: 'charlie',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3
                    },
                    response: {}
                },
                connectCharlie: {}
            },
            {
                RTC: {
                    request: {
                        action: 'send',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        remotePeerId: 'bob',
                        roomId: 'room-1',
                        send: broadcastMessage,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 4
                    },
                    response: {
                        connection: 'bobRtc',
                        withinMs: 1000,
                        message: broadcastMessage
                    }
                },
                aliceBroadcastsToBob: {}
            },
            {
                RTC: {
                    request: {
                        action: 'wait',
                        connection: 'charlieRtc',
                        provider: 'rallar',
                        actor: 'charlie',
                        peerId: 'charlie',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 5
                    },
                    response: {
                        connection: 'charlieRtc',
                        withinMs: 1000,
                        message: broadcastMessage
                    }
                },
                charlieReceivesExplicitBroadcast: {}
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    expect(report.summary.failure).toEqual(0);
    expect(report.resultsByName.aliceBroadcastsToBob[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.charlieReceivesExplicitBroadcast[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.aliceBroadcastsToBob[0].actual.matchedMessage.data.deliveredBy).toEqual('rallar-in-memory-runtime');
    expect(report.resultsByName.charlieReceivesExplicitBroadcast[0].actual.matchedMessage.data.deliveredBy).toEqual('rallar-in-memory-runtime');
    expect(report.resultsByName.aliceBroadcastsToBob[0].actual.matchedMessage.data.deliveredTo).toEqual('bob');
    expect(report.resultsByName.charlieReceivesExplicitBroadcast[0].actual.matchedMessage.data.deliveredTo).toEqual('charlie');
    expect(report.resultsByName.aliceBroadcastsToBob[0].actual.matchedMessage.data.deliveryMode).toEqual('broadcast');
    expect(report.resultsByName.charlieReceivesExplicitBroadcast[0].actual.matchedMessage.data.deliveryMode).toEqual('broadcast');
    expect(report.resultsByName.aliceBroadcastsToBob[0].actual.matchedMessage.data.deliveryGroup).toEqual('room-1');
    expect(report.resultsByName.charlieReceivesExplicitBroadcast[0].actual.matchedMessage.data.deliveryGroup).toEqual('room-1');
    expect(report.resultsByName.aliceBroadcastsToBob[0].actual.matchedMessage.data.deliverySequence).toEqual(1);
    expect(report.resultsByName.charlieReceivesExplicitBroadcast[0].actual.matchedMessage.data.deliverySequence).toEqual(2);
});

test('createRallarWebRtcProvider can broadcast through in-memory runtime with payload broadcast flag', async () => {
    const provider = createRallarWebRtcProvider({
        createSession: createRallarInMemoryRuntime({ now: Date.now, state: { connections: new Map(), nextDeliverySequence: 1 } }).connect
    });

    const broadcastMessage = {
        topic: 'presence.update',
        payload: {
            broadcast: true,
            from: 'alice',
            online: true
        }
    };

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        remotePeerId: 'bob',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'bobRtc',
                        provider: 'rallar',
                        actor: 'bob',
                        peerId: 'bob',
                        remotePeerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                connectBob: {}
            },
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'charlieRtc',
                        provider: 'rallar',
                        actor: 'charlie',
                        peerId: 'charlie',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3
                    },
                    response: {}
                },
                connectCharlie: {}
            },
            {
                RTC: {
                    request: {
                        action: 'send',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        remotePeerId: 'bob',
                        roomId: 'room-1',
                        send: broadcastMessage,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 4
                    },
                    response: {
                        connection: 'bobRtc',
                        withinMs: 1000,
                        message: broadcastMessage
                    }
                },
                alicePayloadBroadcastsToBob: {}
            },
            {
                RTC: {
                    request: {
                        action: 'wait',
                        connection: 'charlieRtc',
                        provider: 'rallar',
                        actor: 'charlie',
                        peerId: 'charlie',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 5
                    },
                    response: {
                        connection: 'charlieRtc',
                        withinMs: 1000,
                        message: broadcastMessage
                    }
                },
                charlieReceivesPayloadBroadcast: {}
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    expect(report.summary.failure).toEqual(0);
    expect(report.resultsByName.alicePayloadBroadcastsToBob[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.charlieReceivesPayloadBroadcast[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.alicePayloadBroadcastsToBob[0].actual.matchedMessage.data.deliveredBy).toEqual('rallar-in-memory-runtime');
    expect(report.resultsByName.charlieReceivesPayloadBroadcast[0].actual.matchedMessage.data.deliveredBy).toEqual('rallar-in-memory-runtime');
    expect(report.resultsByName.alicePayloadBroadcastsToBob[0].actual.matchedMessage.data.deliveredTo).toEqual('bob');
    expect(report.resultsByName.charlieReceivesPayloadBroadcast[0].actual.matchedMessage.data.deliveredTo).toEqual('charlie');
    expect(report.resultsByName.alicePayloadBroadcastsToBob[0].actual.matchedMessage.data.deliveryMode).toEqual('broadcast');
    expect(report.resultsByName.charlieReceivesPayloadBroadcast[0].actual.matchedMessage.data.deliveryMode).toEqual('broadcast');
    expect(report.resultsByName.alicePayloadBroadcastsToBob[0].actual.matchedMessage.data.deliveryGroup).toEqual('room-1');
    expect(report.resultsByName.charlieReceivesPayloadBroadcast[0].actual.matchedMessage.data.deliveryGroup).toEqual('room-1');
});

test('createRallarWebRtcProvider reports in-memory runtime failure when broadcast has no targets', async () => {
    const provider = createRallarWebRtcProvider({
        createSession: createRallarInMemoryRuntime({ now: Date.now, state: { connections: new Map(), nextDeliverySequence: 1 } }).connect
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'send',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        send: {
                            topic: 'presence.update'
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                aliceBroadcastsToEmptyRoom: {}
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    expect(report.summary.failure).toEqual(1);
    expect(report.resultsByName.aliceBroadcastsToEmptyRoom[0].status).toEqual('FAILURE');
    expect(report.resultsByName.aliceBroadcastsToEmptyRoom[0].result).toEqual('RTC send failed');
    expect(report.resultsByName.aliceBroadcastsToEmptyRoom[0].actual.exception).toEqual(
        'Rallar in-memory RTC broadcast has no connected targets for peer: alice'
    );
});

test('createRallarWebRtcProvider reports in-memory runtime failure when target is missing', async () => {
    const provider = createRallarWebRtcProvider({
        createSession: createRallarInMemoryRuntime({ now: Date.now, state: { connections: new Map(), nextDeliverySequence: 1 } }).connect
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        remotePeerId: 'missing-bob',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'send',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        remotePeerId: 'missing-bob',
                        roomId: 'room-1',
                        send: {
                            topic: 'chat.message'
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                aliceSendsToMissingBob: {}
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    expect(report.summary.failure).toEqual(1);
    expect(report.resultsByName.aliceSendsToMissingBob[0].status).toEqual('FAILURE');
    expect(report.resultsByName.aliceSendsToMissingBob[0].result).toEqual('RTC send failed');
    expect(report.resultsByName.aliceSendsToMissingBob[0].actual.exception).toEqual('Rallar in-memory RTC target is not connected: missing-bob');
});
