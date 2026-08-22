# Iteration Plan: Integrating Existing Rallar RTC into the Black-box Runner

Status: historical iteration plan. The provider names proposed here were
superseded by `rallar-signaling`, its legacy `rallar` alias,
`rallar-browser`, and `rallar-remote-browser`. Use
`black-box-rtc-provider.md` for the current contract.

## Goal

Integrate the existing Rallar RTC implementation into the black-box runner without reimplementing RTC in the runner.

The black-box runner should remain a scenario execution and reporting tool. The real RTC behavior should stay inside Rallar.

## Guiding Principle

Do not duplicate Rallar RTC internals.

Instead, create a thin adapter:

```text
black-box RTC provider contract
    -> Rallar adapter
        -> existing Rallar RTC implementation
```

The black-box runner should only know how to:

- connect a session
- send a message
- close a session
- subscribe to message events
- subscribe to close/error events
- emit normalized report diagnostics

## Existing Integration Seam

The current seam is already good:

```ts
export function createRallarWebRtcRuntime(
    options: RallarWebRtcRuntimeOptions = {}
): RallarRtcRuntime {
    return {
        connect: async (args, dispatcher) => {
            if (!options.createSession) {
                throw toMissingRuntimeImplementationError(args);
            }

            return await options.createSession(args, dispatcher);
        }
    };
}
```

The adapter should implement:

```ts
createSession(args, dispatcher): Promise<RallarRtcRuntimeSession>
```

and return:

```ts
{
  send(message): Promise<void> | void
  close(): Promise<void> | void
}
```

## Proposed Provider Naming

Do not replace the current default `rallar` immediately.

Start with a new opt-in provider name:

```text
rallar-real
```

or:

```text
rallar-existing
```

or:

```text
rallar-rtc
```

Recommended first name:

```text
rallar-real
```

Provider registry during transition:

```ts
function createRtcProviders(): Record<string, RtcProvider> {
    return {
        rallar: createRallarWebRtcWebSocketSignalingProvider(),
        'rallar-real': createRallarExistingWebRtcProvider(),
        'rallar-stub': createRallarStubRtcProvider(),
        'rallar-memory': createRallarInMemoryProvider()
    };
}
```

This keeps the current signaling-only provider stable while the real adapter is developed.

## Iteration 1: Identify the Existing Rallar RTC Public API

Find the Rallar class/function that currently creates a working RTC session.

Examples of possible candidates:

```ts
new WebRtcQueueBoxClientService(...)
new QRtcPeerConnection(...)
new QRtcDataChannel(...)
createRallarRtcSession(...)
createWebRtcSession(...)
```

For the adapter, we need to know:

- how to create/connect a session
- how to send a data message
- how to close the session
- how incoming data messages are delivered
- how close/error events are delivered
- how signaling URL / room / peer IDs are passed in
- whether the implementation owns WebSocket signaling internally
- whether it needs initiator/responder role input

Expected output of this iteration:

```text
A small mapping table between black-box args and existing Rallar RTC API.
```

Example:

| Black-box field     | Existing Rallar field          |
| ------------------- | ------------------------------ |
| `args.connection`   | local scenario connection name |
| `args.peerId`       | local peer id                  |
| `args.remotePeerId` | remote peer id                 |
| `args.roomId`       | room id                        |
| `args.groupId`      | group id                       |
| `args.overlayId`    | overlay id                     |
| `args.signalingUrl` | signaling server URL           |

## Iteration 2: Add an Adapter File

Create a new adapter file.

Suggested file:

```text
rallar-existing-webrtc-provider.ts
```

or:

```text
rallar-real-webrtc-provider.ts
```

Initial shape:

```ts
export function createRallarExistingWebRtcProvider(): RtcProvider {
    return createRallarWebRtcProvider({
        createSession: async (args, dispatcher) => {
            const existingSession = await createExistingRallarSession({
                connection: args.connection,
                actor: args.actor,
                peerId: args.peerId,
                remotePeerId: args.remotePeerId,
                roomId: args.roomId,
                groupId: args.groupId,
                overlayId: args.overlayId,
                signalingUrl: args.signalingUrl
            });

            existingSession.onMessage?.((message: any) => {
                dispatcher.emitMessage({
                    topic: 'rallar.webrtc.data.message',
                    connection: args.connection,
                    actor: args.actor,
                    peerId: args.peerId,
                    roomId: args.roomId,
                    groupId: args.groupId,
                    overlayId: args.overlayId,
                    message
                });
            });

            existingSession.onClose?.((event: any) => {
                dispatcher.emitClose({
                    phase: 'close',
                    reason: event?.reason || 'closed by existing Rallar RTC implementation',
                    closedBy: 'rallar-existing-webrtc-runtime',
                    connection: args.connection,
                    actor: args.actor,
                    peerId: args.peerId,
                    roomId: args.roomId,
                    groupId: args.groupId,
                    overlayId: args.overlayId,
                    event
                });
            });

            return {
                send: (message) => existingSession.send(message),
                close: () => existingSession.close()
            };
        }
    });
}
```

The names in this example should be changed to match the real Rallar API.

Expected output of this iteration:

```text
A provider adapter that compiles but may use fake/mocked existing session in tests.
```

## Iteration 3: Register the Provider

Update the provider registry:

```ts
function createRtcProviders(): Record<string, RtcProvider> {
    return {
        rallar: createRallarWebRtcWebSocketSignalingProvider(),
        'rallar-real': createRallarExistingWebRtcProvider(),
        'rallar-stub': createRallarStubRtcProvider(),
        'rallar-memory': createRallarInMemoryProvider()
    };
}
```

Add a small CLI test to verify the provider name exists:

```text
scenario-black-box CLI report includes default RTC provider names
```

Expected provider names:

```text
rallar
rallar-real
rallar-stub
rallar-memory
```

Expected output of this iteration:

```text
Scenarios can opt into provider: "rallar-real".
```

## Iteration 4: Adapter Unit Tests with a Fake Existing Rallar Session

Before using real WebRTC, test the adapter with a fake implementation that behaves like the existing Rallar API.

Test cases:

1. connect succeeds
2. send delegates to existing session
3. incoming message is emitted into black-box `rtcMessages`
4. close delegates to existing session
5. close event is emitted into black-box `rtcCloseEvents`
6. connect failure becomes `RTC connect failed`
7. send failure becomes `RTC send failed`
8. close failure becomes `RTC close failed`

Example scenario:

```ts
Deno.test('rallar-real adapter forwards incoming data messages', async () => {
    // fake existing Rallar session
    // adapter wraps it
    // executeBlackBox connect/send/wait
    // assert message diagnostics
});
```

Expected output of this iteration:

```text
The adapter contract is verified without requiring real browser WebRTC.
```

## Iteration 5: First Real Local Scenario

Create a minimal real scenario using the existing Rallar implementation.

Example config:

```json
{
  "connections": {
    "aliceRtc": {
      "type": "rtc",
      "provider": "rallar-real",
      "actor": "alice",
      "peerId": "alice",
      "remotePeerId": "bob",
      "roomId": "room-1",
      "signalingUrl": "ws://localhost:8080/ws"
    },
    "bobRtc": {
      "type": "rtc",
      "provider": "rallar-real",
      "actor": "bob",
      "peerId": "bob",
      "remotePeerId": "alice",
      "roomId": "room-1",
      "signalingUrl": "ws://localhost:8080/ws"
    }
  },
  "steps": [
    {
      "name": "connectAlice",
      "type": "rtc.connect",
      "connection": "aliceRtc"
    },
    {
      "name": "connectBob",
      "type": "rtc.connect",
      "connection": "bobRtc"
    },
    {
      "name": "aliceSendsMessage",
      "type": "rtc.send",
      "connection": "aliceRtc",
      "request": {
        "send": {
          "topic": "chat.message",
          "payload": {
            "from": "alice",
            "to": "bob",
            "text": "hello bob"
          }
        }
      }
    },
    {
      "name": "bobReceivesMessage",
      "type": "rtc.wait",
      "connection": "bobRtc",
      "expect": {
        "connection": "bobRtc",
        "withinMs": 5000,
        "message": {
          "topic": "rallar.webrtc.data.message",
          "message": {
            "topic": "chat.message",
            "payload": {
              "text": "hello bob"
            }
          }
        }
      }
    }
  ]
}
```

This scenario may need changes depending on how the existing Rallar implementation handles roles and signaling.

Expected output of this iteration:

```text
One local two-peer black-box scenario using real Rallar RTC.
```

## Iteration 6: Role Handling

Real WebRTC usually needs clear role handling.

Add config fields if needed:

```json
{
  "rtcRole": "offerer"
}
```

or:

```json
{
  "initiator": true
}
```

Possible role names:

```text
offerer
answerer
initiator
responder
polite
impolite
```

The adapter should translate black-box config into the existing Rallar role model.

Example:

```ts
const role = args.rtcRole || args.role || (args.initiator ? 'offerer' : 'answerer');
```

Expected output of this iteration:

```text
The two-peer scenario is deterministic and does not suffer from offer glare.
```

## Iteration 7: Connection-open Semantics

Define what `rtc.connect` should mean for `rallar-real`.

Possible levels:

1. signaling connected
2. peer connection created
3. data channel open
4. fully ready for send

Recommended:

```text
rtc.connect should complete when the data channel is ready to send.
```

If the existing Rallar implementation distinguishes signaling-open and data-channel-open, support explicit options:

```json
{
  "waitForOpen": true,
  "openTimeoutMs": 5000
}
```

Expected diagnostics:

```json
{
  "topic": "rallar.webrtc.connected",
  "connection": "aliceRtc",
  "peerId": "alice",
  "roomId": "room-1",
  "signalingOpened": true,
  "peerConnectionState": "connected",
  "dataChannelReadyState": "open"
}
```

Expected output of this iteration:

```text
rtc.connect has a clear meaning for real Rallar RTC.
```

## Iteration 8: Error Diagnostics

Map existing Rallar errors into black-box failure reports.

Important failures:

- signaling URL missing
- signaling WebSocket failed
- offer creation failed
- answer creation failed
- ICE candidate handling failed
- peer connection failed
- data channel did not open
- send before open
- remote peer not found
- timeout waiting for peer

Recommended error shape:

```json
{
  "phase": "peer-connection",
  "reason": "data channel did not open",
  "connection": "aliceRtc",
  "actor": "alice",
  "peerId": "alice",
  "roomId": "room-1",
  "readyState": "connecting"
}
```

Expected output of this iteration:

```text
Failures are diagnosable from the report without opening debugger logs.
```

## Iteration 9: Decide When to Promote `rallar-real`

Keep both providers during stabilization:

```text
rallar       = signaling-only
rallar-real  = existing real Rallar RTC adapter
```

Promote only after real RTC scenarios are stable:

```ts
rallar: createRallarExistingWebRtcProvider();
```

Then optionally keep signaling-only under a new explicit name:

```text
rallar-signaling
```

Recommended promotion condition:

```text
At least one local two-peer scenario passes consistently.
At least one send/wait scenario passes consistently.
Close diagnostics are stable.
Failure diagnostics are useful.
Dry-run still works without invoking provider.
```

## Iteration 10: Documentation Update

After integration, update:

```text
black-box-rtc-provider.md
README.md
example configs
```

Document:

- `rallar-real`
- when to use `rallar-memory`
- when to use `rallar`
- whether `rallar` is still signaling-only or now real RTC
- required signaling server setup
- role fields
- timeout fields
- diagnostics

## Completion Criteria

The integration can be considered complete when:

- `rallar-real` provider is registered
- adapter tests pass with fake existing Rallar session
- at least one real two-peer scenario passes locally
- dry-run does not invoke the real provider
- success/failure reports include generic RTC diagnostics
- message and close events include actor/peer/room/group/overlay diagnostics
- docs explain the boundary and usage

## Related Follow-up: Browser-agent Composite Primitives

The RTC provider integration above is separate from browser-agent recipe
orchestration. `rallar-bb-test` still needs compact control primitives for
visible and remote browser agents, especially for realtime traffic patterns.

The follow-up plan lives in:

```text
packages/shared-test/rallar-bb-test/docs/rallar-bb-test-composite-primitives-iterations.md
```

That plan covers:

- `loop` for repeated browser-agent commands with configurable cadence
- `parallel` for bounded concurrent command groups
- generic `wait` and lightweight `assert` primitives
- optional distributed barriers for multi-browser start synchronization
- black-box-runner pacing refinements where the existing soak/traffic/parallel
  model can be made easier to author
