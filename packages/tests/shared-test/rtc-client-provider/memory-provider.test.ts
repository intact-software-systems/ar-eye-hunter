import { assertEquals } from '@std/assert';
import { executeBlackBox } from '../../../shared-test/black-box-runner/execute-black-box.ts';
import {
    createRallarInMemoryProvider,
    createRallarInMemoryRuntime
} from '../../../shared-test/black-box-runner/rallar-in-memory-runtime.ts';
import { createRallarWebRtcProvider } from '../../../shared-test/black-box-runner/rallar-webrtc-runtime.ts';

Deno.test('createRallarWebRtcProvider can execute two-peer scenario through in-memory runtime', async () => {
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

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.connectBob[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceSendsToBob[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.bobSendsToAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveredBy, 'rallar-in-memory-runtime');
    assertEquals(report.resultsByName.bobSendsToAlice[0].actual.matchedMessage.data.deliveredBy, 'rallar-in-memory-runtime');
    assertEquals(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveredTo, 'bob');
    assertEquals(report.resultsByName.bobSendsToAlice[0].actual.matchedMessage.data.deliveredTo, 'alice');
    assertEquals(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveryGroup, 'room-1');
    assertEquals(report.resultsByName.bobSendsToAlice[0].actual.matchedMessage.data.deliveryGroup, 'room-1');
    assertEquals(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveryMode, 'direct');
    assertEquals(report.resultsByName.bobSendsToAlice[0].actual.matchedMessage.data.deliveryMode, 'direct');
    assertEquals(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliverySequence, 1);
    assertEquals(report.resultsByName.bobSendsToAlice[0].actual.matchedMessage.data.deliverySequence, 2);
});

Deno.test('createRallarWebRtcProvider routes in-memory message payload target before remotePeerId', async () => {
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

    assertEquals(report.summary.failure, 1);
    assertEquals(report.resultsByName.aliceSendsPayloadTargetToCharlie[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceSendsPayloadTargetToCharlie[0].actual.matchedMessage.data.deliveredBy, 'rallar-in-memory-runtime');
    assertEquals(report.resultsByName.aliceSendsPayloadTargetToCharlie[0].actual.matchedMessage.data.sentBy, 'alice');
    assertEquals(report.resultsByName.aliceSendsPayloadTargetToCharlie[0].actual.matchedMessage.data.deliveredTo, 'charlie');
    assertEquals(report.resultsByName.bobDoesNotReceiveCharlieTargetedMessage[0].status, 'FAILURE');
    assertEquals(report.resultsByName.bobDoesNotReceiveCharlieTargetedMessage[0].result, 'Expected RTC message was not received');
});

Deno.test('createRallarInMemoryProvider can execute two-peer scenario', async () => {
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

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.connectBob[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceSendsToBob[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveredBy, 'rallar-in-memory-runtime');
    assertEquals(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveryGroup, 'room-1');
    assertEquals(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveryMode, 'direct');
    assertEquals(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliverySequence, 1);
});

Deno.test('createRallarInMemoryProvider reports failure when peer connects twice', async () => {
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

    assertEquals(report.summary.failure, 1);
    assertEquals(report.resultsByName.connectAliceFirst[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.connectAliceSecond[0].status, 'FAILURE');
    assertEquals(report.resultsByName.connectAliceSecond[0].result, 'RTC connect failed');
    assertEquals(
        report.resultsByName.connectAliceSecond[0].actual.exception,
        'Rallar in-memory RTC peer is already connected: alice'
    );
});

Deno.test('createRallarInMemoryProvider allows peer to reconnect after close', async () => {
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

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.connectAliceFirst[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.closeAliceFirst[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.connectAliceSecond[0].status, 'SUCCESS');
});

Deno.test('createRallarInMemoryProvider emits close diagnostics', async () => {
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

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.waitForAliceClose[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.closedBy, 'rallar-in-memory-runtime');
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.connection, 'aliceRtc');
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.roomId, 'room-1');
});

Deno.test('createRallarInMemoryProvider emits group and overlay close diagnostics', async () => {
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

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.waitForAliceClose[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.groupId, 'group-1');
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.overlayId, 'overlay-1');
});

Deno.test('createRallarWebRtcProvider can broadcast through in-memory runtime when no target is specified', async () => {
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

    assertEquals(report.summary.failure, 1);
    assertEquals(report.resultsByName.aliceBroadcastsToRoom[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceBroadcastsToRoom[0].actual.matchedMessage.data.deliveredBy, 'rallar-in-memory-runtime');
    assertEquals(report.resultsByName.charlieDoesNotReceiveOtherRoomBroadcast[0].status, 'FAILURE');
    assertEquals(report.resultsByName.charlieDoesNotReceiveOtherRoomBroadcast[0].result, 'Expected RTC message was not received');
});

Deno.test('createRallarWebRtcProvider can broadcast through in-memory runtime with explicit broadcast flag', async () => {
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

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.aliceBroadcastsToBob[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.charlieReceivesExplicitBroadcast[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceBroadcastsToBob[0].actual.matchedMessage.data.deliveredBy, 'rallar-in-memory-runtime');
    assertEquals(report.resultsByName.charlieReceivesExplicitBroadcast[0].actual.matchedMessage.data.deliveredBy, 'rallar-in-memory-runtime');
    assertEquals(report.resultsByName.aliceBroadcastsToBob[0].actual.matchedMessage.data.deliveredTo, 'bob');
    assertEquals(report.resultsByName.charlieReceivesExplicitBroadcast[0].actual.matchedMessage.data.deliveredTo, 'charlie');
    assertEquals(report.resultsByName.aliceBroadcastsToBob[0].actual.matchedMessage.data.deliveryMode, 'broadcast');
    assertEquals(report.resultsByName.charlieReceivesExplicitBroadcast[0].actual.matchedMessage.data.deliveryMode, 'broadcast');
    assertEquals(report.resultsByName.aliceBroadcastsToBob[0].actual.matchedMessage.data.deliveryGroup, 'room-1');
    assertEquals(report.resultsByName.charlieReceivesExplicitBroadcast[0].actual.matchedMessage.data.deliveryGroup, 'room-1');
    assertEquals(report.resultsByName.aliceBroadcastsToBob[0].actual.matchedMessage.data.deliverySequence, 1);
    assertEquals(report.resultsByName.charlieReceivesExplicitBroadcast[0].actual.matchedMessage.data.deliverySequence, 2);
});

Deno.test('createRallarWebRtcProvider can broadcast through in-memory runtime with payload broadcast flag', async () => {
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

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.alicePayloadBroadcastsToBob[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.charlieReceivesPayloadBroadcast[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.alicePayloadBroadcastsToBob[0].actual.matchedMessage.data.deliveredBy, 'rallar-in-memory-runtime');
    assertEquals(report.resultsByName.charlieReceivesPayloadBroadcast[0].actual.matchedMessage.data.deliveredBy, 'rallar-in-memory-runtime');
    assertEquals(report.resultsByName.alicePayloadBroadcastsToBob[0].actual.matchedMessage.data.deliveredTo, 'bob');
    assertEquals(report.resultsByName.charlieReceivesPayloadBroadcast[0].actual.matchedMessage.data.deliveredTo, 'charlie');
    assertEquals(report.resultsByName.alicePayloadBroadcastsToBob[0].actual.matchedMessage.data.deliveryMode, 'broadcast');
    assertEquals(report.resultsByName.charlieReceivesPayloadBroadcast[0].actual.matchedMessage.data.deliveryMode, 'broadcast');
    assertEquals(report.resultsByName.alicePayloadBroadcastsToBob[0].actual.matchedMessage.data.deliveryGroup, 'room-1');
    assertEquals(report.resultsByName.charlieReceivesPayloadBroadcast[0].actual.matchedMessage.data.deliveryGroup, 'room-1');
});

Deno.test('createRallarWebRtcProvider reports in-memory runtime failure when broadcast has no targets', async () => {
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

    assertEquals(report.summary.failure, 1);
    assertEquals(report.resultsByName.aliceBroadcastsToEmptyRoom[0].status, 'FAILURE');
    assertEquals(report.resultsByName.aliceBroadcastsToEmptyRoom[0].result, 'RTC send failed');
    assertEquals(
        report.resultsByName.aliceBroadcastsToEmptyRoom[0].actual.exception,
        'Rallar in-memory RTC broadcast has no connected targets for peer: alice'
    );
});

Deno.test('createRallarWebRtcProvider reports in-memory runtime failure when target is missing', async () => {
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

    assertEquals(report.summary.failure, 1);
    assertEquals(report.resultsByName.aliceSendsToMissingBob[0].status, 'FAILURE');
    assertEquals(report.resultsByName.aliceSendsToMissingBob[0].result, 'RTC send failed');
    assertEquals(
        report.resultsByName.aliceSendsToMissingBob[0].actual.exception,
        'Rallar in-memory RTC target is not connected: missing-bob'
    );
});
