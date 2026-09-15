import { RALLAR_BLACK_BOX_ALM_COMMAND_CAPABILITIES } from '../alm/rallar-black-box-alm-command-capabilities.ts';
import type { RallarBlackBoxCommandCapability } from '../rallar-black-box-test-contracts.ts';
import {
    RALLAR_BLACK_BOX_COMMAND_BASE_FIELDS,
    RALLAR_BLACK_BOX_COMMAND_FIELDS
} from './rallar-black-box-command-fields.ts';

type CommandCapabilityWithoutFields = Omit<RallarBlackBoxCommandCapability, 'requiredFields' | 'optionalFields'>;

const COMMAND_CAPABILITIES_WITHOUT_FIELDS: readonly CommandCapabilityWithoutFields[] = [
    {
        kind: 'configure',
        title: 'Configure Runtime',
        description: 'Sets run, agent, provider, default room, transport, browser, control, and redaction context.',
        supportedProviderModes: [
            'simulated',
            'browser-rallar',
            'rallar-browser',
            'rallar-remote-browser',
            'rallar-memory',
            'mixed'
        ],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: [],
        artifactExpectations: ['runtime configuration snapshot', 'redacted config in reports'],
        example: {
            kind: 'configure',
            commandId: 'configure-local-agent',
            config: {
                runId: 'schema-example-run',
                agentId: 'agent-1',
                environment: 'local',
                apiBaseUrl: 'http://localhost:8080',
                actor: 'alice',
                roomId: 'bb-group',
                transport: 'realtime'
            }
        }
    },
    {
        kind: 'recipe.load',
        title: 'Load Recipe',
        description: 'Stages a recipe in a browser agent without starting unrelated shell execution.',
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: [],
        artifactExpectations: ['loaded recipe metadata', 'readiness/ACK result when used for staging'],
        example: {
            kind: 'recipe.load',
            commandId: 'load-health-recipe',
            recipe: {
                schemaVersion: 1,
                recipeId: 'health-only',
                commands: [{ kind: 'health', commandId: 'loaded-health' }]
            }
        }
    },
    {
        kind: 'recipe.run',
        title: 'Run Recipe',
        description: 'Runs an inline or previously loaded browser-agent recipe and records command results.',
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: [],
        artifactExpectations: ['per-command results', 'events', 'stats', 'final report'],
        example: {
            kind: 'recipe.run',
            commandId: 'run-health-recipe',
            recipe: {
                schemaVersion: 1,
                recipeId: 'health-run',
                commands: [{ kind: 'health', commandId: 'run-health' }]
            }
        }
    },
    {
        kind: 'recipe.cancel',
        title: 'Cancel Recipe',
        description: 'Requests cancellation of the active browser-agent recipe.',
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: [],
        artifactExpectations: ['cancel result', 'partial command history'],
        example: {
            kind: 'recipe.cancel',
            commandId: 'cancel-active-recipe',
            reason: 'operator requested cancellation'
        }
    },
    {
        kind: 'loop',
        title: 'Loop Commands',
        description:
            'Composite browser-agent command that repeats child commands with bounded count or duration and optional cadence.',
        supportedProviderModes: [
            'simulated',
            'browser-rallar',
            'rallar-browser',
            'rallar-remote-browser',
            'rallar-memory',
            'mixed'
        ],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: ['same live requirements as its child commands'],
        artifactExpectations: ['parent loop rollup', 'per-child command results', 'iteration metadata'],
        example: {
            kind: 'loop',
            commandId: 'loop-rtc-position',
            count: 3,
            intervalMs: 50,
            thresholds: {
                minAchievedRateHz: 10,
                minSendSuccessRatio: 0.95
            },
            commands: [
                {
                    kind: 'rtc.send',
                    commandId: 'loop-position-send',
                    connection: 'aliceRtc',
                    transport: 'realtime',
                    send: {
                        roomId: 'bb-group',
                        data: {
                            topic: 'schema.example.loop.position',
                            seq: '{loop.index}'
                        }
                    }
                }
            ]
        }
    },
    {
        kind: 'parallel',
        title: 'Parallel Command Groups',
        description:
            'Composite browser-agent command that runs bounded groups concurrently while each group runs its child commands sequentially.',
        supportedProviderModes: [
            'simulated',
            'browser-rallar',
            'rallar-browser',
            'rallar-remote-browser',
            'rallar-memory',
            'mixed'
        ],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: ['same live requirements as its child commands'],
        artifactExpectations: ['parent parallel rollup', 'per-group summaries', 'per-child command results'],
        example: {
            kind: 'parallel',
            commandId: 'parallel-room-traffic',
            maxConcurrency: 2,
            failFast: true,
            groups: [
                {
                    groupId: 'alice-sends',
                    commands: [
                        {
                            kind: 'ws.send',
                            commandId: 'alice-ws-send',
                            connection: 'apiWs',
                            data: {
                                typeId: 'schema.example.parallel.alice',
                                payload: {
                                    text: 'alice'
                                }
                            }
                        }
                    ]
                },
                {
                    groupId: 'bob-sends',
                    commands: [
                        {
                            kind: 'health',
                            commandId: 'bob-health'
                        }
                    ]
                }
            ]
        }
    },
    {
        kind: 'wait',
        title: 'Wait For Runtime Evidence',
        description:
            'Waits for a matching runtime event; with absent: true it instead holds the full window and fails when any buffered or new event matches.',
        supportedProviderModes: [
            'simulated',
            'browser-rallar',
            'rallar-browser',
            'rallar-remote-browser',
            'rallar-memory',
            'mixed'
        ],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: [
            'the matching evidence must be emitted by earlier or concurrent commands, browser adapters, or provider event bridges'
        ],
        artifactExpectations: ['matched event in the command result', 'timeout failure when evidence does not appear'],
        example: {
            kind: 'wait',
            commandId: 'wait-for-room-position',
            timeoutMs: 5_000,
            match: {
                kind: 'message',
                topic: 'rallar.browser.realtime.message',
                transport: 'realtime',
                payloadPath: 'data.topic',
                equals: 'room.position'
            }
        }
    },
    {
        kind: 'assert',
        title: 'Assert Runtime Evidence',
        description:
            'Checks a read-only browser-agent evidence source with equality, containment, numeric-bound, length, regex, and JSON-shape operators.',
        supportedProviderModes: [
            'simulated',
            'browser-rallar',
            'rallar-browser',
            'rallar-remote-browser',
            'rallar-memory',
            'mixed'
        ],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: ['the asserted source must be present in the browser-agent runtime state'],
        artifactExpectations: [
            'assert result with redacted actual and expected values',
            'failed command result when the assertion is false'
        ],
        example: {
            kind: 'assert',
            commandId: 'assert-received-count',
            source: 'state.messages.length',
            operator: 'gte',
            expected: 1
        }
    },
    {
        kind: 'rtc.connect',
        title: 'RTC Connect',
        description: 'Connects an RTC/realtime provider and can wait for exact-room ready peers.',
        supportedProviderModes: [
            'simulated',
            'browser-rallar',
            'rallar-browser',
            'rallar-remote-browser',
            'rallar-memory'
        ],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['Rallar API and signaling when provider mode is browser-rallar or rallar-browser'],
        artifactExpectations: ['connect diagnostics', 'readiness diagnostics', 'RTC stats'],
        example: {
            kind: 'rtc.connect',
            commandId: 'connect-alice-rtc',
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'bb-group',
            roomRef: { applicationId: 'rallar-server', groupId: 'bb-group' },
            transport: 'realtime',
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 10_000,
                intervalMs: 100
            },
            timeoutMs: 15_000
        }
    },
    {
        kind: 'rtc.send',
        title: 'RTC Send',
        description: 'Sends JSON through a connected RTC/realtime provider.',
        supportedProviderModes: [
            'simulated',
            'browser-rallar',
            'rallar-browser',
            'rallar-remote-browser',
            'rallar-memory'
        ],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: [
            'active RTC connection',
            'Rallar signaling when using browser-rallar or rallar-browser'
        ],
        artifactExpectations: [
            'send result',
            'message events',
            'NACK/failure diagnostics when delivery cannot complete'
        ],
        example: {
            kind: 'rtc.send',
            commandId: 'send-rtc-json',
            connection: 'aliceRtc',
            transport: 'realtime',
            send: {
                roomId: 'bb-group',
                data: {
                    topic: 'schema.example.rtc',
                    text: 'hello over RTC'
                }
            },
            timeoutMs: 5_000
        }
    },
    {
        kind: 'rtc.stream',
        title: 'RTC Stream',
        description:
            'Schedules a bounded RTC/realtime frame stream inside one browser-agent command and records aggregate pacing, delivery, and latency metrics.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser'],
        runtimeSurfaces: ['control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: [
            'active RTC connection',
            'Rallar signaling when using browser-rallar or rallar-browser'
        ],
        artifactExpectations: [
            'stream started/progress/completed diagnostics',
            'aggregate frame delivery metrics',
            'p50/p95/p99/max send duration'
        ],
        example: {
            kind: 'rtc.stream',
            commandId: 'stream-rtc-position',
            connection: 'aliceRtc',
            transport: 'realtime',
            roomId: 'bb-group',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            count: 3,
            intervalMs: 50,
            maxInFlight: 64,
            drainTimeoutMs: 5_000,
            send: {
                roomId: 'bb-group',
                data: {
                    topic: 'schema.example.rtc.stream.position',
                    seq: '{stream.index}',
                    frame: '{stream.iteration}',
                    tMs: '{stream.elapsedMs}'
                }
            },
            thresholds: {
                minSendSuccessRatio: 0.99,
                maxDroppedFrames: 0
            },
            timeoutMs: 10_000
        }
    },
    ...RALLAR_BLACK_BOX_ALM_COMMAND_CAPABILITIES,
    {
        kind: 'ws.open',
        title: 'WebSocket Open',
        description: 'Opens a browser-agent WebSocket connection.',
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-server', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['WebSocket endpoint and ticket/token when the target server requires auth'],
        artifactExpectations: ['open result', 'socket state events', 'close/error diagnostics'],
        example: {
            kind: 'ws.open',
            commandId: 'open-api-websocket',
            connection: 'apiWs',
            url: 'ws://localhost:8080/api/ws/{auth.sessionId}?ticket={auth.wsTicket}',
            timeoutMs: 10_000
        }
    },
    {
        kind: 'ws.send',
        title: 'WebSocket Send',
        description: 'Sends JSON or text through an open WebSocket connection.',
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-server', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['open WebSocket connection'],
        artifactExpectations: ['send result', 'message events when the server echoes or routes the payload'],
        example: {
            kind: 'ws.send',
            commandId: 'send-ws-json',
            connection: 'apiWs',
            data: {
                typeId: 'schema.example.ws',
                topicId: 'schema.example.ws',
                payload: {
                    text: 'hello over WebSocket'
                }
            },
            timeoutMs: 5_000
        }
    },
    {
        kind: 'ws.close',
        title: 'WebSocket Close',
        description: 'Closes a named WebSocket connection.',
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-server', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['open or known WebSocket connection'],
        artifactExpectations: ['close result', 'socket close event'],
        example: {
            kind: 'ws.close',
            commandId: 'close-api-websocket',
            connection: 'apiWs',
            code: 1000,
            reason: 'schema example complete'
        }
    },
    {
        kind: 'http.request',
        title: 'HTTP Request',
        description:
            'Runs a fetch-compatible HTTP request and stores response metadata/body according to response options.',
        supportedProviderModes: ['simulated', 'browser-rallar', 'rallar-server', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['HTTP endpoint', 'access token for protected Rallar Server APIs'],
        artifactExpectations: ['request timing', 'HTTP status', 'redacted response body'],
        example: {
            kind: 'http.request',
            commandId: 'get-rallar-health',
            request: {
                method: 'GET',
                path: '/health'
            },
            response: {
                body: 'json'
            },
            timeoutMs: 5_000
        }
    },
    {
        kind: 'crdt.open',
        title: 'CRDT Open',
        description: 'Opens a Rallar CRDT document through the browser Rallar facade and stores it under a handle.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: [
            'Rallar browser runtime with CRDT facade; live service only when transport is not local-only'
        ],
        artifactExpectations: ['document ref', 'handle', 'transport strategy', 'initial health'],
        example: {
            kind: 'crdt.open',
            commandId: 'open-crdt-checklist',
            handle: 'checklist',
            name: 'checklist',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            documentType: 'checklist',
            documentId: 'room-1',
            scope: {
                kind: 'room'
            },
            roomRef: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'room-1'
            },
            transport: 'ws',
            persist: true,
            tabSync: true,
            durableCatchUp: 'http',
            initialValue: {
                items: []
            },
            timeoutMs: 10_000
        }
    },
    {
        kind: 'crdt.apply',
        title: 'CRDT Apply',
        description: 'Applies an existing Rallar CRDT operation batch to an opened document handle.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['opened CRDT document handle'],
        artifactExpectations: ['update id', 'materialized value', 'pending counts', 'health'],
        example: {
            kind: 'crdt.apply',
            commandId: 'apply-crdt-title',
            handle: 'checklist',
            batch: {
                kind: 'batch',
                operationGroupId: 'group-title-1',
                operations: [
                    {
                        kind: 'register.set',
                        path: ['title'],
                        value: 'Ready',
                        policy: 'lww'
                    }
                ]
            }
        }
    },
    {
        kind: 'crdt.read',
        title: 'CRDT Read',
        description: 'Reads the materialized value and ref from an opened CRDT document handle.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['opened CRDT document handle'],
        artifactExpectations: ['materialized CRDT value', 'document ref', 'health'],
        example: {
            kind: 'crdt.read',
            commandId: 'read-crdt-checklist',
            handle: 'checklist'
        }
    },
    {
        kind: 'crdt.sync',
        title: 'CRDT Sync',
        description: 'Runs CRDT document sync with an optional transport override.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['opened CRDT document handle; live transport or HTTP catch-up when configured'],
        artifactExpectations: ['sync status', 'transport strategy', 'sent/received counts', 'pending counts'],
        example: {
            kind: 'crdt.sync',
            commandId: 'sync-crdt-checklist',
            handle: 'checklist',
            reason: 'black-box-convergence-check',
            transport: 'ws',
            timeoutMs: 10_000
        }
    },
    {
        kind: 'crdt.health',
        title: 'CRDT Status',
        description: 'Returns health for an opened CRDT document handle.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['opened CRDT document handle'],
        artifactExpectations: ['pending/failed/dependency counts', 'transport strategy', 'integrity status'],
        example: {
            kind: 'crdt.health',
            commandId: 'health-crdt-checklist',
            handle: 'checklist'
        }
    },
    {
        kind: 'crdt.wait',
        title: 'CRDT Wait',
        description: 'Polls an opened CRDT document until materialized value or health conditions match.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: [
            'opened CRDT document handle; live transport or HTTP catch-up when sync is requested'
        ],
        artifactExpectations: [
            'matched materialized value or health',
            'attempt count',
            'wait duration',
            'last sync result'
        ],
        example: {
            kind: 'crdt.wait',
            commandId: 'wait-crdt-checklist-converged',
            handle: 'checklist',
            timeoutMs: 10_000,
            intervalMs: 250,
            stableForMs: 500,
            sync: {
                reason: 'black-box-crdt-wait',
                transport: 'ws'
            },
            conditions: [
                {
                    source: 'value',
                    path: 'title',
                    operator: 'equals',
                    expected: 'Ready'
                },
                {
                    source: 'health',
                    path: 'pendingUpdateCount',
                    operator: 'equals',
                    expected: 0
                },
                {
                    source: 'health',
                    path: 'dependencyBlockedUpdateCount',
                    operator: 'equals',
                    expected: 0
                }
            ]
        }
    },
    {
        kind: 'crdt.undo',
        title: 'CRDT Undo',
        description: 'Applies actor-owned CRDT undo operations for a target operation group.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['opened CRDT document handle and caller-supplied inverse operations'],
        artifactExpectations: ['undo update id', 'materialized value', 'health'],
        example: {
            kind: 'crdt.undo',
            commandId: 'undo-crdt-title',
            handle: 'checklist',
            targetOperationGroupId: 'group-title-1',
            operationGroupId: 'undo-title-1',
            operations: [
                {
                    kind: 'register.set',
                    path: ['title'],
                    value: 'Untitled',
                    policy: 'lww'
                }
            ]
        }
    },
    {
        kind: 'crdt.redo',
        title: 'CRDT Redo',
        description: 'Reapplies actor-owned CRDT redo operations for a target operation group.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['opened CRDT document handle and caller-supplied redo operations'],
        artifactExpectations: ['redo update id', 'materialized value', 'health'],
        example: {
            kind: 'crdt.redo',
            commandId: 'redo-crdt-title',
            handle: 'checklist',
            targetOperationGroupId: 'group-title-1',
            operationGroupId: 'redo-title-1',
            operations: [
                {
                    kind: 'register.set',
                    path: ['title'],
                    value: 'Ready',
                    policy: 'lww'
                }
            ]
        }
    },
    {
        kind: 'crdt.close',
        title: 'CRDT Close',
        description: 'Closes an opened CRDT document handle without destroying local durable artifacts.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['opened CRDT document handle'],
        artifactExpectations: ['close result and final health snapshot when available'],
        example: {
            kind: 'crdt.close',
            commandId: 'close-crdt-checklist',
            handle: 'checklist'
        }
    },
    {
        kind: 'crdt.destroy',
        title: 'CRDT Destroy',
        description: 'Destroys an opened CRDT document handle and its local browser artifacts.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['opened CRDT document handle'],
        artifactExpectations: ['destroy result and removed handle'],
        example: {
            kind: 'crdt.destroy',
            commandId: 'destroy-crdt-checklist',
            handle: 'checklist'
        }
    },
    {
        kind: 'director.appoint',
        title: 'Appoint SPA Director',
        description: 'Appoints the current browser session as the Rallar group director through the browser facade.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['connected browser Rallar session with group update authorization'],
        artifactExpectations: ['director appointment status', 'updated director metadata'],
        example: {
            kind: 'director.appoint',
            commandId: 'appoint-director',
            roomId: 'bb-group',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            heartbeatTtlMs: 1_200
        }
    },
    {
        kind: 'director.resign',
        title: 'Resign SPA Director',
        description: 'Clears the current browser session director appointment when it is the appointed director.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['connected browser Rallar session'],
        artifactExpectations: ['director resignation status', 'updated director metadata'],
        example: {
            kind: 'director.resign',
            commandId: 'resign-director',
            roomId: 'bb-group',
            applicationId: 'rallar-server',
            workspaceId: 'default'
        }
    },
    {
        kind: 'director.status',
        title: 'Read SPA Director Status',
        description:
            'Reads local director appointment, freshness, and role state, optionally refreshing room metadata first.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['connected browser Rallar session; Rallar API when refresh is true'],
        artifactExpectations: ['director role, freshness, appointment epoch, and session id'],
        example: {
            kind: 'director.status',
            commandId: 'director-status',
            roomId: 'bb-group',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            refresh: true
        }
    },
    {
        kind: 'director.relay.start',
        title: 'Start SPA Director Relay',
        description:
            'Starts a deterministic test relay backed by rallar.director.createRelay and stores it under a handle.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['connected browser Rallar session with RTC/WS message subscriptions'],
        artifactExpectations: ['relay start diagnostics', 'director intent/output/snapshot events'],
        example: {
            kind: 'director.relay.start',
            commandId: 'start-director-relay',
            handle: 'game-director',
            roomId: 'bb-group',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            topicId: 'app.black-box.director',
            intentTypeId: 'app.black-box.director.intent',
            outputTypeId: 'app.black-box.director.output',
            heartbeatIntervalMs: 300,
            snapshotIntervalMs: 500
        }
    },
    {
        kind: 'director.intent',
        title: 'Send SPA Director Intent',
        description: 'Sends an intent through a started director relay toward the appointed director.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['started director relay and fresh director appointment'],
        artifactExpectations: ['intent send result and downstream director output events'],
        example: {
            kind: 'director.intent',
            commandId: 'send-director-intent',
            handle: 'game-director',
            intent: {
                intentId: 'intent-1',
                action: 'move',
                x: 1,
                y: 0
            }
        }
    },
    {
        kind: 'director.sync.request',
        title: 'Request SPA Director Sync',
        description: 'Requests a director snapshot through a started director relay.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['started director relay and fresh director appointment'],
        artifactExpectations: ['sync request send result and snapshot events'],
        example: {
            kind: 'director.sync.request',
            commandId: 'request-director-sync',
            handle: 'game-director',
            payload: {
                reason: 'late-join'
            }
        }
    },
    {
        kind: 'director.relay.stop',
        title: 'Stop SPA Director Relay',
        description: 'Stops a previously started director relay and clears its heartbeat/snapshot timers.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser', 'mixed'],
        runtimeSurfaces: ['spa-local', 'control-agent', 'black-box-runner-adapter'],
        liveServiceRequirements: ['started director relay handle'],
        artifactExpectations: ['relay stop diagnostics and final relay counters'],
        example: {
            kind: 'director.relay.stop',
            commandId: 'stop-director-relay',
            handle: 'game-director'
        }
    },
    {
        kind: 'formation.command',
        title: 'Command Room Formation',
        description:
            'Issues one of the eight room formation lifecycle commands through the browser facade and reports the receipt beside the room formation summary.',
        supportedProviderModes: ['browser-rallar'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: ['connected browser Rallar session holding the named room'],
        artifactExpectations: ['group snapshot receipt', 'room formation summary'],
        example: {
            kind: 'formation.command',
            commandId: 'formation-plan',
            command: 'plan',
            roomId: 'bb-group',
            applicationId: 'rallar-server',
            workspaceId: 'default'
        }
    },
    {
        kind: 'formation.readiness',
        title: 'Await Room Readiness',
        description:
            'Awaits the browser\'s own room readiness without refreshing the room or opening lanes, and reports the room formation summary captured when it resolved.',
        supportedProviderModes: ['browser-rallar'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: ['connected browser Rallar session holding the named room'],
        artifactExpectations: ['room formation summary at the tick readiness resolved'],
        example: {
            kind: 'formation.readiness',
            commandId: 'formation-readiness',
            roomId: 'bb-group',
            applicationId: 'rallar-server',
            workspaceId: 'default'
        }
    },
    {
        kind: 'health',
        title: 'Health',
        description: 'Returns browser-agent runtime health without network side effects.',
        supportedProviderModes: [
            'simulated',
            'browser-rallar',
            'rallar-browser',
            'rallar-remote-browser',
            'rallar-memory',
            'mixed'
        ],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: [],
        artifactExpectations: ['runtime status snapshot'],
        example: {
            kind: 'health',
            commandId: 'health-check',
            label: 'Health check'
        }
    },
    {
        kind: 'stats',
        title: 'Stats',
        description: 'Captures a browser-agent stats snapshot.',
        supportedProviderModes: [
            'simulated',
            'browser-rallar',
            'rallar-browser',
            'rallar-remote-browser',
            'rallar-memory',
            'mixed'
        ],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: [],
        artifactExpectations: ['command counts', 'event counts', 'latest status'],
        example: {
            kind: 'stats',
            commandId: 'stats-snapshot'
        }
    },
    {
        kind: 'close',
        title: 'Close',
        description: 'Closes active browser-agent transports without clearing the whole runtime state.',
        supportedProviderModes: [
            'simulated',
            'browser-rallar',
            'rallar-browser',
            'rallar-remote-browser',
            'rallar-memory',
            'mixed'
        ],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: [],
        artifactExpectations: ['transport close events', 'final stats'],
        example: {
            kind: 'close',
            commandId: 'close-transports'
        }
    },
    {
        kind: 'reset',
        title: 'Reset',
        description: 'Resets browser-agent runtime command state and closes active transports.',
        supportedProviderModes: [
            'simulated',
            'browser-rallar',
            'rallar-browser',
            'rallar-remote-browser',
            'rallar-memory',
            'mixed'
        ],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: [],
        artifactExpectations: ['reset result', 'new idle runtime state'],
        example: {
            kind: 'reset',
            commandId: 'reset-agent'
        }
    }
];

export const RALLAR_BLACK_BOX_COMMAND_CAPABILITIES: readonly RallarBlackBoxCommandCapability[] =
    COMMAND_CAPABILITIES_WITHOUT_FIELDS.map(toCommandCapability);

function toCommandCapability(capability: CommandCapabilityWithoutFields): RallarBlackBoxCommandCapability {
    const fields = RALLAR_BLACK_BOX_COMMAND_FIELDS[capability.kind];
    return {
        kind: capability.kind,
        title: capability.title,
        description: capability.description,
        requiredFields: fields.required,
        optionalFields: [...fields.optional, ...RALLAR_BLACK_BOX_COMMAND_BASE_FIELDS],
        supportedProviderModes: capability.supportedProviderModes,
        runtimeSurfaces: capability.runtimeSurfaces,
        liveServiceRequirements: capability.liveServiceRequirements,
        artifactExpectations: capability.artifactExpectations,
        example: capability.example
    };
}
