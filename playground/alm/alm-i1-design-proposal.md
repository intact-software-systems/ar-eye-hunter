# ALM I1 design proposal: reply correlation (I1a) and the trace bridge (I1b)

Release 8, slice I1 of [alm-improvement-plan.md](alm-improvement-plan.md). Written from three read-only surveys of
`main` at `e1a4efdf2` (the handle and contract survey, the trace and diagnostics survey, the consumer survey) and the
maintainer's rulings R1–R4 of 2026-10-27. I1 lands as two pull requests (R1). **I1a** is reply correlation: `corrId`
and `replyToMsgId` on the delivery handle, `awaitReply`, the inbound reply matcher, the reply helper on both sides,
the conformance `reply` family and the Relic planning request as the consumer proof; it closes F16. **I1b** is trace
propagation and payload-free harness diagnostics; it closes PC9; its design is §6 (2026-10-27, after I1a's merge). Completion
criterion 9 asks that correlation and tracing work across retry, repair, restart and every carrier attempt; I1a takes
its correlation half.

## 1. The problem

What exists:

- The envelope already carries the fields. `ALActions` is `{ corrId?, replyToMsgId? }` on `ALMessage.actions`
  (`packages/shared/al-contracts/al-contract.ts:117-121`, `:164`), and the persisted decoder accepts exactly those two
  keys as optional non-empty strings (`al-message-persistence-validation.ts:204-221`). The envelope version check is on
  `id.v` only, so no version bump is needed for fields the decoder already admits (`al-contract.ts:11`,
  `al-message-persistence-validation.ts:91-93`).
- Every transport re-shaping of an outbound message is an object spread of the first envelope: the RTC-to-WS
  admission retry, the post-admission hand-over, the volatile downgrade, the repair retransmission and the durable
  restore all re-admit the same `msgId` and `actions` (trace survey §3 table; pinned for the whole envelope by
  `packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts`). Correlation therefore survives
  fallback and repair once it is on the first envelope; it is unpinned for `actions`.
- The S1 handle (D9–D16): `RallarMessageHandle` has `msgId`, `typeId`, `lifecycle()`, `onEvent()`, `wait()` and
  `cancel()` (`packages/shared-web/browser/messages/rallar-message-contracts.ts:112-122`). `wait({ until?, timeoutMs?,
  signal? })` resolves `{ status: 'settled' | 'timeout' | 'aborted', lifecycle }` and never throws; a caller timeout
  leaves the message alive (`browser-rallar-delivery-registry.ts:260-315`). The registry is the browser's bounded
  observation store, 60 s for terminal entries and 512 entries (`browser-delivery-composition.ts:7`,
  `browser-rallar-delivery-registry.ts:317-370`); handles do not survive a reload and a lost observation is
  `unobservable` (D13).
- A received message is `RallarMessage<T>` with `senderId` (the sender's session, `id.senderId`) and the `raw`
  envelope (`rallar-message-contracts.ts:18-29`, `to-rallar-message.ts:5-21`). WS messages reach the page through one
  any-message inbox with ordered handlers (`browser/websocket/browser-websocket-inbox.ts`), and the messaging
  subscriptions register handler `messages` at order 20 (`browser-rallar-message-subscriptions.ts:130-141`).
- Server replies exist only as payload correlation: the CRDT topics reply with `route.resourceId = requestId` and the
  request id in the payload (`install-rallar-crdt-ws-topics.ts:174-208`); the game authority client keys pending
  commands by payload `seq` (`rallar-game-authority-client.ts:68,244,338-350`).
- The server AI transport is built and unwired: `installRallarServerAiWebSocketTopic` defines a request topic,
  authorizes `generate`, runs `RallarServerAi.generateJson` and publishes the result as a room, world or all
  broadcast on a result topic (`packages/shared-server/rallar-ai/install-rallar-server-ai-websocket-topic.ts:88-137`,
  `rallar-server-ai-result-publication.ts:134-157`). Its handler message has no `raw` (`:39-41`), so it cannot address
  the asker. Only `shared-server/mod.ts` and its tests reference it.
- Relic planning is browser-local: `useRelicPlanningAi.ask()` generates with the browser facade, validates, marks the
  result `proposed` and broadcasts it to the hunter's own sessions (`apps/relic-hunters-v1/src/game/ai/
  useRelicPlanningAi.ts:190-302`, broadcast `:272-280`). The default provider is a deterministic mock in development
  and tests and absent in production (`:96-99`, `:378-389`). Commands already go to the server on a `command`
  channel addressed to `serverPeerId` and wait on the handle (`send-relic-ws-command.ts:18-39`); the server's own
  envelopes carry `senderId = rallar.ws.serverPeerId` (`apps/relic-hunter-server-v1/src/main.ts:71`,
  `packages/relic-hunters/server/compute-relic-game-publications.ts:116`).

What is missing:

- No writer or reader of `actions.corrId` or `actions.replyToMsgId` anywhere (handle survey §1.3). The builders take
  no `actions` option (`al-contract.ts:178-198`, `:225-258`); `RallarMessageSendBase` has no correlation input
  (`rallar-message-contracts.ts:40-56`).
- The handle has no `corrId`, no `replyToMsgId`, no reply wait. No inbound path matches a reply to its request, so a
  duplicate, a late reply or a wrong responder has no defined outcome. There is no reply helper on either side.
- The harness cannot express a reply: `messages.send` has no correlation field and no command awaits or sends a reply
  (`packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts:358-430`). No conformance scenario has a
  responder.
- Relic's own documentation records the gap: a WS-path failure "is still only logged until a reply channel exists"
  (`apps/relic-hunters-v1/docs/runtime-data-flow.md:99-100`).

## 2. The design, per concern

### 2.a The send side: `corrId` is the request's `msgId` unless the caller passes one (D438)

Every ALM send has a correlation id. By default it is the message's own `msgId`, and it is derived, not stamped: a
message without `actions.corrId` has `corrId = id.msgId`. One pure function owns that rule,
`toALCorrId(message)` in `packages/shared/al-contracts/to-al-reply-actions.ts`, and every reader goes through it (the
registry, the reply builders, the harness). The wire carries `actions.corrId` only when the caller passes a `corrId`,
which is a re-ask under the same correlation. Ordinary sends therefore keep their bytes, their canonical identity
(`al-outbound-canonical-message.ts:235-237` does not include `actions`) and the hosted manifests' figures.

- The builders gain `actions?: ALActions` on `ALMessageBuilderOptions`, `ALBroadcastMessageBuilderOptions` and the
  multicast options, and `buildALMessage` writes it verbatim when present (`al-contract.ts:178-198`, `:225-258`,
  `:297-317`). The builders mint nothing: a builder that defaulted `corrId` would put it on every server envelope.
- `RallarMessageSendBase` gains `corrId?: string`; absent means "this message starts its correlation". It flows to the
  lane, typed and peer-addressed sends through the existing `Omit<…>` option types (`rallar-message-contracts.ts:
  165-172`). `replyToMsgId` is not a public send input: only the reply helper (§2.e) sets it.
- `BrowserMessageInputValidator` gains the issue `$.corrId` (a non-empty string of at most 128 UTF-8 bytes), beside its
  existing issues (`browser-message-input-validator.ts`). The decoder needs no change.

### 2.b The handle: `corrId`, `replyToMsgId` and `awaitReply` (D439)

`RallarMessageHandle` gains two fields and one method, in the shape of `wait()`:

```ts
readonly corrId: string;
/** The request this message replies to; absent when the message is not a reply. */
readonly replyToMsgId: string | undefined;
awaitReply<T = unknown>(options: RallarMessageReplyWaitOptions): Promise<RallarMessageReplyOutcome<T>>;
```

`RallarMessageReplyWaitOptions` is `{ timeoutMs: number; signal?: AbortSignal }`. The timeout is required: an
acknowledged request is terminal, so a wait without its own clock would have nothing to end it. The outcome is a
value and the call never throws:

```ts
type RallarMessageReplyOutcome<T = unknown> =
    | Readonly<{ status: 'replied'; reply: RallarMessage<T>; lifecycle: ALDeliveryLifecycle; }>
    | Readonly<{ status: 'timeout' | 'aborted' | 'undelivered'; lifecycle: ALDeliveryLifecycle; }>;
```

`lifecycle` is the request's lifecycle when the wait resolves. The reply payload is unvalidated (`T` defaults to
`unknown`); the caller validates it, as RallarAI output must be (`.agents/skills/rallar-ai/SKILL.md`).

Three clocks stay independent:

| Clock                                        | Set by                                               | Ends                                                        |
| -------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------- |
| ACK timeout (`qos.ack.timeoutMs`)            | the reliability normalization, 2 s and three retries | one receipt attempt; exhausted retries settle `failed`      |
| Message deadline (`constraints.expiresAtMs`) | the send's `ttlMs` or the channel's 30 s             | the request's lifetime; unconfirmed by then it is `expired` |
| Reply timeout (`awaitReply.timeoutMs`)       | the caller                                           | the caller's wait for the application reply                 |

A receipt is not a reply: `acknowledged` is protocol acceptance, and the reply is the separate application evidence
the standing direction names. A `timeout` leaves the request alive: its lifecycle, attempts and receipt go on as
before, nothing is cancelled and nothing claims failure; the roadmap's "timeout as `unconfirmed`" is this outcome
(there is no `unconfirmed` state, handle survey §4). The wait resolves `undelivered` when the request's lifecycle is
terminal in any state other than `acknowledged` or `transport-accepted` (`rejected`, `failed`, `expired`,
`superseded`, `cancelled`, `unobservable`), because no reply can be expected through this observation; the caller
reads why from `lifecycle`. Precedence when the call starts: a recorded reply, then a closed slot (`timeout`), then
`undelivered`, then an aborted signal, else the wait arms.

### 2.c The reply slot: one per observation, bounded by the registry (D440)

Each registry observation owns one reply slot, opened at `open()` with the request's `corrId` (via `toALCorrId`) and
its expected responder: the `toPeerId` of a unicast request, and any sender for an audience request. The slot lives in
a new owner, `BrowserMessageReplySlots` (`packages/shared-web/browser/messages/browser-message-reply-slots.ts`), which
the registry constructs and drives as it does the fallback controller (`browser-rallar-delivery-registry.ts:82-87`), so
the registry file does not grow a second state machine. A slot is `open`, `replied` or `timed-out`:

- One reply per request (R2). The first accepted reply moves the slot to `replied` and resolves every open wait; a
  reply that arrives before anyone awaits is kept on the slot and returned at once by a later `awaitReply`.
- The first wait that times out closes the slot (`timed-out`) and resolves every other open wait `timeout`; later
  calls return `timeout` at once. `aborted` and `undelivered` end only that wait and leave the slot as it is, so a
  delivered-but-unacknowledged request can still be answered.
- Retention is the registry's: the age rule does not drop an entry while a reply wait is open (that wait's required
  timeout bounds it), and the count bound releases it like any entry, which resolves its waits `undelivered` with
  the lifecycle the release published. Session end (`releaseAll`) does the same. No timer exists outside the wait's
  own timeout and abort, the pattern `startWait` already follows (`:278-315`).
- After a reload a durable request resumes with no handle (D13) and therefore no slot; its reply is dropped as late.

### 2.d The inbound matcher: WS, one inbox handler, typed drops (D441)

A message whose `actions.replyToMsgId` is set is a reply, and replies reach only the matcher: a new owner
`BrowserMessageReplyInbox` (`packages/shared-web/browser/messages/browser-message-reply-inbox.ts`) subscribes the WS
inbox once as handler `message-replies` at order 15, and the `messages` handler at order 20 skips replies, so a
reply never reaches an `onMessage` subscriber of its type as well. For each reply the matcher builds the
`RallarMessage` (with its own `reply()`, §2.e) and calls `deliveries.recordReply(reply)`, which answers with a typed
admission:

- `matched`: the slot is open and the sender is the expected responder, or any sender for an audience request.
- `wrong-responder`: the slot exists and the sender is not the request's `toPeerId`. The reply is dropped.
- `late`: the slot is `replied` (a second, distinct reply), `timed-out`, or no observation holds the request
  (`unobserved`: evicted, another tab's, or after a reload). The reply is dropped.

Each drop emits one payload-free inbound diagnostic through the session's `inboundDiagnostics` port
(`packages/shared-web/browser/connection/rallar-diagnostics-ports.ts:19-61`): `reply-late` with `cause: 'replied' |
'timed-out' | 'unobserved'`, or `reply-wrong-responder` with `expectedSenderId`. Both carry `msgId`, `replyToMsgId`,
`corrId`, `typeId`, `senderId` and `carrier`, and nothing of the payload; the kinds join the
`ALInboundRuntimeDiagnosticEvent` union (`packages/shared/alm/inbound/al-inbound-runtime-diagnostics.ts:26-182`).
Copies of one reply (a cross-carrier duplicate, a retransmission) never reach the matcher twice: the inbound runtime
deduplicates per `msgId` before delivery (`packages/shared/alm/inbound/README.md`), which is the "existing msgId
dedup" of R2.

Replies travel over WS in I1a, and the matcher has no RTC registration. The RTC inbox selects one callback per
`typeId` and holds a message that has no callback as `retry` until a consumer registers or the message expires
(`packages/shared/services/web-rtc-rx-streamer-service.ts:459-485`); the messaging subscriptions own that one
registration per type (`browser-rallar-message-subscriptions.ts:143-157`). A matcher registration would either
overwrite the application's callback for the type or consume, with no listener, messages that the hold keeps for a
later subscriber. The WS inbox has no such hold in the page, which already keeps a wildcard consumer
(`browser-state-cache-lifecycle.ts:138`; `ws-queue-box-client-service.ts:551-596`), so one any-message handler sees
every reply of every type. The request itself may travel on any carrier and strategy.

### 2.e `reply()` on `RallarMessage` and `newALReplyMessage` on the server (D442, D443)

`RallarMessage<T>` gains one method (R4):

```ts
reply<R>(payload: R, options?: RallarMessageReplyOptions): Promise<RallarMessageHandle>;
```

with `RallarMessageReplyOptions = { typeId?: string; ttlMs?: number }`: an absent `typeId` replies on the request's
type, an absent `ttlMs` takes the purpose default. The reply is a WS unicast to `senderId` (the requester's session),
on the request's `topicId` and `contextId`, in the request's room when the request named one
(`readALTargetGroupRef`, `al-contract.ts`), with `actions = toALReplyActions(request)` = `{ corrId:
toALCorrId(request), replyToMsgId: request.id.msgId }`. Its delivery defaults are the `command` purpose's,
`AL_CHANNEL_SEND_DEFAULTS.command` (at-least-once, the addressee's receipt, 30 s, volatile;
`packages/shared/al-contracts/resolve-al-channel-send-defaults.ts:21-34`): the two purposes coincide for an addressed
send and the request's purpose is not on the wire. It returns an ordinary handle, so the responder observes its
reply's delivery like any send. `BrowserRallarMessageSender.sendReply(request, payload, options)` is the browser's one
place that sets `replyToMsgId`; the messages controller constructs the sender before the subscriptions and the reply
inbox and hands both `sendReply`, so construction stays visible.

State events are not repliable: the room and people event streams build their messages before messaging exists and
replay synthesizes some of them locally (`browser/rooms/room-events.ts:215,329`,
`browser/people/browser-rallar-people-events.ts:254,396`). `RallarStateEventListener` therefore takes
`RallarStateEventMessage<T> = Omit<RallarMessage<T>, 'reply'>`, built by `toRallarStateEventMessage` (today's
`toRallarMessage`); `toRallarMessage(transport, message, sendReply)` builds the repliable message for the messaging
subscriptions and the reply inbox.

The server gets one builder (R4), `newALReplyMessage(request, { senderId, typeId, payload })` in
`packages/shared/al-contracts/new-al-reply-message.ts`: `newALUnicastMessage` to `request.id.senderId` on
`newALEventRoute(request.route.topicId, request.route.contextId)`, the request's target group ref, the same
`command` defaults and `toALReplyActions(request)`. Both sides take the reply fields from `toALReplyActions`, so one
function mints them.

`installRallarServerAiWebSocketTopic` replies instead of broadcasting (D443): its handler message gains `raw:
ALMessage`, as the router delivers it (`rallar-server-ws-router-contracts.ts:74-78`); the result is published as
`newALReplyMessage(message.raw, { senderId: config.serverSenderId, typeId: config.replyTypeId, payload: result })`
with `config.replyFanout`; the config's `resultTopicId`, `resultTypeId`, `resultScope` and `resultFanout` become
`replyTypeId` and `replyFanout`, and it gains `requestScope: RallarServerWsTopicScope`, passed to the topic
definition so the router's room authorization admits only a room member's request (`:91-97`). The HTTP twin and
`createRallarServerAiResultPublisher` are unchanged. The installer has no other consumer, so nothing keeps the
broadcast shape.

### 2.f The Relic consumer: planning asks the server AI (D444)

- **Protocol.** `RELIC_TYPES` gains `aiPlanningRequest: 'relic.ai.planning-request.v1'` and `aiPlanningReply:
  'relic.ai.planning-reply.v1'` on the existing `RELIC_TOPICS.aiPlanning` (`packages/relic-hunters/src/protocol.ts:
  6-20`). The request payload is the RallarAI JSON request without its `signal` (the server decoder refuses unknown
  fields, `decode-rallar-server-ai-json-request.ts:4-16`); the reply payload is the `RallarAiJsonResult`.
- **One planning contract.** The parts both sides need move from `apps/relic-hunters-v1/src/game/ai/
  relic-planning-ai.ts` to `packages/relic-hunters/src/planning-ai.ts`: the schema id and version, the suggestion
  schema and prompt, the context and suggestion types, `validateRelicPlanningAiSuggestion` and a boundary decoder
  `decodeRelicPlanningAiContext(value: unknown): Either<string, RelicPlanningAiContext>`; and the deterministic
  suggestion (`mockRelicPlanningSuggestion` and its helpers, `:533-695`) becomes
  `computeRelicPlanningAiSuggestion(context)` in `packages/relic-hunters/src/compute-relic-planning-ai-suggestion.ts`.
  The browser's mock provider calls it; nothing is copied.
- **Server.** `apps/relic-hunter-server-v1/src/relic-planning-ai-topic.ts` installs the topic from `main.ts` with
  `createRallarServerAi` over a deterministic provider that decodes the context and answers
  `computeRelicPlanningAiSuggestion`, validates its own value before returning it, `requestScope: 'room'`,
  `serverSenderId: rallar.ws.serverPeerId`, `replyFanout: 'outbox'` (the receipted server-to-session path the hunter
  events use, D168) and an `authorize` that admits only the planning schema id and version with a room. Server AI with
  a deterministic answer is the rallar-ai skill's fallback rule taken whole; an Ollama-backed planner is carried.
- **Browser.** `sendRelicPlanningRequest(facade, roomId, request)` in `apps/relic-hunters-v1/src/game/ai/
  send-relic-planning-request.ts` mirrors `sendRelicWsCommand`: undefined `serverPeerId` returns at once; otherwise a
  `command` channel on the planning topic sends the request with `peerId: serverPeerId` and awaits the reply for
  `RELIC_PLANNING_REPLY_TIMEOUT_MS` (5 s, the browser policy's generation timeout, `useRelicPlanningAi.ts:55-59`). It
  returns `Either<RelicPlanningRequestFallback, RallarAiJsonResult<RelicPlanningAiSuggestion>>`, the left naming
  `no-server`, `timeout`, `aborted`, `undelivered` or `invalid-reply`. A reply is valid only when its result decodes,
  its `requestId`, schema id and version are the request's, its `baseStateRevision` is still current (exact) and
  `validateRelicPlanningAiSuggestion` accepts the value. `ask()` tries the server first; on any left it runs today's
  local path when a local provider exists and reads `unavailable` otherwise. A valid reply becomes `proposed` and is
  handled exactly as a local suggestion: it is the asking session's own (`local: true`), it primes only the draft,
  and the principal broadcast to the hunter's other sessions is unchanged. Submit Plan stays the only authoritative
  path. `canGenerate` becomes true with a server peer even without a local provider.
- **Session addressing.** Relic keys its players by session (`runtime-data-flow.md:91`). The reply goes to the
  asking session's id, never to the principal, so a hunter's second tab neither receives nor answers the other's
  request.

### 2.g The proof (D445)

- **Conformance family `reply`** in `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/reply/`, beside
  `server-command.ts`, with a browser responder, since the API server has no generic reply topic:
  `reply-correlated` over `ws` and `rtc-with-ws-fallback` (the sender's `command` unicast to the receiver reads
  `replied`, `replyToMsgId` is the request's `msgId`, `corrId` is that `msgId`, the reply's sender is the receiver;
  the reply itself is acknowledged); `reply-timeout-late` over `ws` (no reply inside a short timeout reads `timeout`
  with the request still `acknowledged`; the receiver replies after a release message and the sender's inbound
  diagnostics show one `reply-late` with `cause` `timed-out`); `reply-first-wins` on the three-agent roles over `ws`
  (a room request answered by both recipients reads `replied` once, from either, and one `reply-late` with `cause`
  `replied`); `reply-undelivered` over `ws` (a request whose only carrier attempt is dropped by the transport fault
  port and whose short deadline elapses reads `undelivered` with lifecycle `expired`, the `deadline-expiry.ts`
  pattern). The cells join `ALM_CONFORMANCE_SCENARIOS` (`create-alm-conformance-recipes.ts:131-179`) and the
  `AlmConformanceScenarioId` union, and are withheld from hosted manifests 18 and 22 in the list beside the claim
  cells (`apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts:80-110`), which stay byte-identical.
- **Harness commands.** `messages.awaitReply { handleId, timeoutMs }` returns a payload-free value (`status`, the
  request's `state` and `corrId`, and for `replied` the reply's `msgId`, `replyToMsgId`, `corrId`, `senderId` and
  `typeId`); `messages.reply { typeId, index, payload, handleId }` replies to the `index`-th message of that type the
  connection received and records the reply's handle under `handleId`, so `messages.observe` follows it. The typed
  channel recorder keeps the last 16 received messages per type for it. The ledger's `messages.observe` timeout
  convention is followed: the command reports the outcome as its value and never throws on `timeout`.
- **Wrong responder** has no honest product path into a lane cell: a unicast request reaches only its addressee, and
  a harness forgery would be test-only wiring. It is pinned at the matcher's unit level with a constructed envelope.
- **Unit pins.** The builders' `actions` and `toALCorrId`/`toALReplyActions`/`newALReplyMessage`
  (`packages/tests/shared/al-contracts/`); the slot states, clocks, precedence and retention
  (`packages/tests/shared-web/messages/browser-message-reply-slots.test.ts`); the matcher's three admissions, the
  `messages` handler skipping replies and the payload-free diagnostics with a sentinel payload
  (`browser-message-reply-inbox.test.ts`); `reply()` and `corrId` on sends (`browser-rallar-message-sender.test.ts`,
  `browser-typed-message-channels.test.ts`); `actions` preserved across the fallback hand-over, the admission retry
  and the volatile downgrade (`browser-message-fallback-identity.test.ts`); the installer's reply
  (`install-rallar-server-ai-websocket-topic.test.ts`); public API snapshots for the four new type names.
- **Relic.** A Deno test of the planning topic (`apps/relic-hunter-server-v1/test/relic-planning-ai-topic.test.ts`:
  the reply's target, fields and validated suggestion; a non-member, a foreign schema and an undecodable context get
  no reply); the app test of the request (`apps/relic-hunters-v1/tests/send-relic-planning-request.test.ts`: every
  left and the valid reply) and the hook in `packages/tests/relic-hunters/relic-web-app.browser.test.ts` (server
  suggestion shown, local fallback on timeout); the Playwright spec `tests/playwright/relic-hunters/
  ai-planning-reply.spec.ts` on the fake backend (`relic-browser-backend.ts`), which answers with `newALReplyMessage`
  and a distinct headline, then stops answering to show the local fallback.

### 2.h Docs, corrections and carries (D446)

The product description's "Correlation and actions" paragraph becomes CURRENT for I1a with this meaning (one reply,
the addressee or any audience member as responder, no response-schema registration because the caller validates,
late and wrong-responder replies dropped with payload-free diagnostics), the public-surface list loses "correlation
builders" from its absent parts, and the transport-switch sentence keeps trace for I1b. The inbound and outbound
READMEs name the reply matcher, the slot and the `actions` option; `docs/rallar-api-reference.md` and
`packages/shared-web/browser/README.md` document `awaitReply`, `reply()` and `corrId`; Relic's runtime data flow replaces its "until a reply channel exists" sentence
and describes the server planning path. The roadmap's I1 row is split as in §4, and F16 is marked resolved at the
close. Carried, not done by I1a: replies over RTC (the registration ownership in §2.d), several replies per request,
response-schema registration, durable reply waits across a reload, an Ollama planning provider, and everything in
§2.i.

### 2.i I1b, outcome-shaped: trace propagation and payload-free harness diagnostics

I1b closes PC9 ("one observable identity") with the chain the trace survey names in its "Gaps for I1". Its
decisions are taken in §6, written after I1a merged; the four points below are the outcome shape they refine.

1. **A trace id on the envelope at creation.** A `traceId` builder option and a byte and charset bound for `id.traceId`
   (today it falls in the resource limits' `other` bucket, `al-message-resource-limits.ts:235-260`); a send option,
   minted once per logical send when absent; the handle and `RallarMessage` expose it. Because the outbound identity
   hashes `traceId` (`al-outbound-canonical-message.ts:234-237`), it is stamped before first admission and never
   changes, and retries, fallback, repair and restore preserve it with no new code (trace survey §3).
2. **HTTP and AppInbox into the server envelope.** There is no AppInbox trace id today: the AppInbox identity is the
   path `requestId`, and `AuditStamp.traceId` is never populated (trace survey §0.2, §1.1). One HTTP carrier for the id
   (browser headers, the CORS `allowHeaders` at `apps/api-v1/src/services/install-api-http-middleware.ts:27`, the
   timing middleware's validation and context, `rallar.timing`), captured outside the logical command so a retry with
   a new trace is not an idempotency conflict, stamped on the AppInbox command envelope
   (`create-app-inbox-client-runtime.ts:98-105`), inherited by WS-origin commands (`relic-game-service.ts:126`), and
   stamped on every server publication the handler mints, `newALReplyMessage` included; controls stay trace-free.
3. **Payload-free diagnostics.** `traceId` and `corrId` appended at the end of message-scoped runtime events (scenario
   waits match key order), and the harness emitters that carry payloads today (`black-box-rallar-ws-send-controller.ts:
   114`, the typed-channel and connection message events, the console-warning bridge, the remote-browser relay) made
   payload-free, with bounded free-text `detail` and timing error strings.
4. **Evidence.** Sender and receiver trace equality, the same trace across an RTC-to-WS leg, a server-originated
   scenario from HTTP through AppInbox to the browser, and a sentinel-payload guard over every diagnostic the lane
   records.

## 3. Decisions (2026-10-27)

- **D438** `corrId` is derived: a message without `actions.corrId` has `corrId = id.msgId` (`toALCorrId`); the wire
  carries `actions.corrId` only for a caller-passed re-ask id. The builders gain `actions?: ALActions` and mint
  nothing; `RallarMessageSendBase` gains `corrId?` with the validator issue `$.corrId` (≤ 128 bytes); `replyToMsgId`
  is not a public send input; no envelope version bump.
- **D439** The handle gains `corrId: string`, `replyToMsgId: string | undefined` and `awaitReply({ timeoutMs, signal?
  })` with a required timeout, resolving `replied | timeout | aborted | undelivered` with the request's lifecycle and
  never throwing. The ACK timeout, the message deadline and the reply timeout are independent; `timeout` leaves the
  request alive; `undelivered` is a terminal state other than `acknowledged` or `transport-accepted`.
- **D440** One reply slot per registry observation in `BrowserMessageReplySlots`, driven by the registry: one reply
  per request; an early reply is kept; the first timeout closes the slot for every wait; abort and `undelivered` end
  one wait; the age rule spares an entry with an open reply wait, the count bound and session end resolve it
  `undelivered`; no slot after a reload (D13).
- **D441** Replies (messages with `actions.replyToMsgId`) reach only `BrowserMessageReplyInbox`, a WS inbox handler at
  order 15 that the `messages` handler skips; admissions `matched`, `wrong-responder` (unicast `toPeerId` mismatch),
  `late` (`replied`, `timed-out`, `unobserved`); drops emit payload-free `reply-late` and `reply-wrong-responder`
  inbound diagnostics; duplicates fall to the inbound msgId dedup; replies travel over WS and the matcher registers
  no RTC type in I1a.
- **D442** `RallarMessage.reply(payload, { typeId?, ttlMs? })` sends a WS unicast to the requester's session on the
  request's route and room with `toALReplyActions(request)` and the `command` purpose defaults, through
  `BrowserRallarMessageSender.sendReply`; state events take `RallarStateEventMessage<T> = Omit<RallarMessage<T>,
  'reply'>`.
- **D443** `newALReplyMessage(request, { senderId, typeId, payload })` is the server's one reply builder;
  `installRallarServerAiWebSocketTopic` replies to the asking session with it (handler message gains `raw`, config
  gains `replyTypeId`, `replyFanout` and `requestScope` and loses the result topic, type, scope and fanout).
- **D444** Relic planning asks the server: `relic.ai.planning-request.v1` and `relic.ai.planning-reply.v1` on
  `room.relic.ai.planning`; the planning contract and the deterministic suggestion move to `packages/relic-hunters`;
  the server answers through the installer with a deterministic `RallarServerAi`, room-scoped and schema-authorized;
  the browser validates the reply into a `proposed`, local, draft-priming suggestion and falls back to the local path
  on every left; the reply is addressed to the asking session.
- **D445** The conformance `reply` family (`reply-correlated`, `reply-timeout-late`, `reply-first-wins`,
  `reply-undelivered`) with `messages.awaitReply` and `messages.reply`, withheld from manifests 18 and 22; the wrong
  responder pinned at unit level; unit, Deno, app and Playwright pins as in §2.g.
- **D446** Docs and corrections as in §2.h and §4; I1a closes F16; I1b (trace and payload-free harness diagnostics,
  PC9) stays outcome-shaped as in §2.i; carries as in §2.h and §5.

## 4. Corrections to the roadmap and the product description

- The roadmap's "8 I1" outcome row is split into I1a (reply correlation, this proposal) and I1b (trace and
  payload-free diagnostics). Its "AppInbox trace id bridged into the envelope" becomes "a trace id carried from the
  HTTP request through AppInbox into the envelope": no AppInbox trace id exists to bridge (trace survey §0.2). Its
  "timeout as `unconfirmed`" is the `timeout` outcome of `awaitReply`.
- The release map row "8 Integration | I1" becomes two rows, I1a and I1b, both medium, and "Nineteen PRs" becomes
  twenty, applied with I1a's close.
- The consumer row's Relic cell "AI planning request and reply on `awaitReply` with correlation and trace" keeps
  trace for I1b: the request and reply land in I1a, the trace on them in I1b.
- The requirement matrix's F16 row becomes "Resolved: correlation (I1a)" at the close; PC9 stays open for I1b.
- The product description's "Correlation and actions" promises "an optional response schema, expected
  sender/audience, deadline, and one/many response mode" and "an explicit late/expired outcome" for late replies.
  I1a defines one reply mode, the expected responder by target mode, the caller's reply timeout as the deadline, the
  caller's own validation in place of a registered schema, and a late reply as a dropped message with a payload-free
  `reply-late` diagnostic; the waiter's outcome is `timeout`. The paragraph is rewritten to that at delivery.
- The product description's "PLANNED — I1, session and trace identity" becomes "PLANNED — I1b", and "Three parts are
  absent: correlation and trace builders (I1)" becomes "trace builders (I1b)" at I1a's close.

## 5. Carries: what I1a does not do

Trace identity anywhere (I1b); payload-free harness emitters (I1b); replies over RTC and the per-type registration
they need; several replies per request or a collection mode; a registered response schema; a durable reply wait that
survives a reload; a typed server-side refusal reply when generation fails (the browser's timeout and local fallback
cover it); an Ollama-backed Relic planner; AR Eye Hunter (no change, as the consumer row says); the game authority
client's and the CRDT topics' payload correlation, which keep working and are not migrated.

## 6. I1b design: the trace bridge and the payload-free diagnostics class (2026-10-27)

Written after I1a merged (`0754c40c5`) from two read-only sweeps of that `main` (the server trace seams; the harness
payload consumers) and the maintainer's rulings R6–R10 of 2026-10-27. I1b lands as two pull requests (R10):
**I1b-i** carries the trace end to end (D447–D452, proof D453); **I1b-ii** puts it on the diagnostics and the harness
identity, makes the diagnostics class payload-free and closes PC9 (D454). One correction to the I1 surveys:
`id.sessionId` is live, not unset. The topology hydration unicast stamps it
(`rtc-topology-hydration-message.ts:37`) and the browser compares it
(`state-cache/is-rtc-topology-current-state-message.ts:44`); I1b leaves it alone and is trace only.

### 6.a One identity, three carriers (R6, D447)

The trace id is one string with one grammar, `[A-Za-z0-9_-]{1,128}` (a UUID fits), owned by
`packages/shared/al-contracts/trace/al-trace-id.ts`: `newALTraceId()` mints a UUID, `validateALTraceId(value)` returns
every issue, and `decodeALTraceId(value: unknown)` is the boundary decoder. It travels as the HTTP request header
`x-request-id`, as the AppInbox command envelope's `id.traceId`, and as `id.traceId` on every publication, reply and
control the server mints for it. The HTTP timing line's `requestId` is therefore the trace: the middleware already
keys on that header, echoes it and records it; I1b makes it validate the header with the grammar instead of trusting
it, mint one when the header is absent or invalid, and set it on the Hono context, from which one reader,
`readApiRequestTraceId(context)`, gives it to every route. `x-request-id` joins the CORS `allowHeaders`, and the
OpenAPI document names it as the optional request header and the echoed response header. The mutation `requestId` in
the path stays what it is: the logical command's idempotency key, stable across a client's retries, while the trace
names one attempt. A retry with a new trace is not an idempotency conflict.

**As applied (I1b-i).** The grammar is stated once: `AL_TRACE_ID_MAX_LENGTH` (128) and
`AL_TRACE_ID_CHARACTER_CLASS` (`A-Za-z0-9_-`) build `AL_TRACE_ID_PATTERN`. `decodeALTraceId` refuses an absent value
`missing` and any other bad value `malformed`, and every trace validator calls it. The module has no barrel: consumers
import `al-contracts/trace/al-trace-id.ts`, as they import `reply/`. The middleware writes the `x-request-id` echo once,
after `next()`, beside `server-timing`, so a route that returns its own `Response` echoes it too. A WebSocket upgrade
gets the trace on its context but no echo, on its 101 and on its refusals alike. `readApiRequestTraceId` throws a
plain `Error` when the middleware did not run, so a route without the trace answers 500 as an invariant failure.

### 6.b The envelope: `traceId` required, version 4 (R8, D447)

`ALMessageId.traceId` becomes `string` and `AL_MESSAGE_ENVELOPE_VERSION` becomes `4`; decoders refuse any other
version as `unsupported`, as the version-3 bump did for `targets.rosterVersion`. `buildALMessage` stamps
`newALTraceId()` when the builder input carries none; the builder options and every typed builder accept `traceId`.
The persisted validator and the inbound decoder require the grammar, so a foreign trace that is too long or
malformed is refused `malformed`, not admitted into the `other` resource bucket. The outbound canonical identity
already hashes `traceId` (`al-outbound-canonical-message.ts:236`), so the trace is fixed before first admission and
retry, fallback, repair and restore carry it unchanged with no new code; I1b-i pins that on the browser dispatch,
the fallback controller, the repair retransmission and the checkpoint restore. Every literal envelope in tests and
recipes moves to version 4 with a trace; the hand-built `id` literals in production (25) take the trace from their
input, and the four exact-key or byte-exact `id` validators (admin prune page, the group presence summary recompute,
the auth logout provenance re-derivation, the formation timer recompute) accept and reproduce it.

**As applied (I1b-i).** The persisted validator decodes `id.traceId` with `decodeALTraceId`, and the inbound decoder
is the same function, so a missing or bad trace is refused `malformed` and any version but 4 `unsupported`.
`RtcTopologyPublication.traceId` is a required persisted field with the same grammar, and it enters the execution
command digest. A topology publication persisted before version 4 is refused as corrupt, as its version-3 envelope
is refused `unsupported`: there is no backfill and no migration code. The 18 JSON recipes moved to version 4,
each with a trace.

### 6.c The browser: a trace per send, inherited by the reply (D448)

`RallarMessageSendBase` gains `traceId?: string` with the validator issue `$.traceId`; a send without one mints one in
`buildALMessage`, so each logical send has its own trace and the same trace across every carrier attempt. The handle
exposes `traceId`, `RallarMessage` exposes `traceId` from `raw.id`, and `RallarMessage.reply()` copies the request's
trace into the reply (the reply is a new envelope whose trace is the request's, as its `corrId` is). The optional
input exists for one purpose: linking a send to an earlier operation's trace, such as a reply the caller composes
by hand or a send that continues an HTTP mutation; it is not a default. Every browser HTTP call to api-v1 or the Relic
server sends `x-request-id`, minted per request in `executeHttpRequest`, the one place browser HTTP headers are
built; the two direct `fetch` callers (`state-read/point-read.ts`, the Relic app's `game/api.ts`) go through it, and
the unused `authFetch` is deleted.

**As applied (I1b-i).** The one place is `sendApiHttpRequest(input)` in
`packages/shared-web/browser/api/send-api-http-request.ts`, which replaced `executeHttpRequest` and takes one named
`SendApiHttpRequestInput`. `newApiRequestHeaders(options)` beside it builds the headers and mints `x-request-id` per
call, so a retried request carries a new trace. The two direct `fetch` callers build their headers with
`newApiRequestHeaders` and keep their own `fetch`, because each needs the raw `Response`. Both read a failed body with
the one `readApiErrorBody`. A stated trace outside the grammar is refused with the issue `$.traceId` on WS and RTC
before anything is queued. The handle's `traceId` is the envelope's, read when the registry opens the observation.

### 6.d AppInbox: the command envelope carries the request's trace (D450)

`AppInboxEnqueueInput.traceId: string` is required: every enqueue names the trace of the request it serves. The one
factory, `createDefaultAppInboxQueueMessage`, stamps it on the command envelope's `id.traceId` and the stored command
(the payload JSON, the idempotency identity's `{type, authority, data}` and the persisted command decoder's exact
keys) does not carry it: the envelope is the one carrier, and handlers read `context.message.id.traceId`. The
reservation winner's envelope is the retained one, so a replay or a loser observes the first request's trace, which
is the trace of the command that ran. The 56 HTTP mutation routes pass `readApiRequestTraceId(context)` into their
command builders; the WS-origin commands (the Relic command topic, the CRDT append ingress) inherit
`message.raw.id.traceId`; the autonomous enqueues (retention, presence expiry, formation timers, session cleanup,
WS connect and disconnect) mint `newALTraceId()`; the auth service, which builds its own inbox rows, stamps the request
trace on them.

**As applied (I1b-i).** The stored command is `AppInboxEnqueue`, which has no trace, and `AppInboxEnqueueInput
extends AppInboxEnqueue { traceId }` is what is enqueued. Handlers build `AppInboxCommandAttempt { attemptCount,
traceId }`, owned by `app-inbox/app-inbox-contracts.ts`, from `context.message`. The group trace lives in those
attempt facts, not in the persisted ingress authority, because materialization runs before the envelope exists. A
materialized reservation stamps its placeholder's trace on the materialized entry, so one reservation carries one
trace. The application operations follow the same pattern: `RallarServerAppInbox.Operation.enqueue` and `submit`
take `RallarServerAppInbox.EnqueueInput<Command> { command, traceId }`. The caller owns the trace, the generic owner
mints nothing, and the stored and hashed `Command` never carries it. Relic is the only production caller. Its HTTP
routes, in `apps/relic-hunter-server-v1/src/relic-game-routes.ts` (`initRelicGameRoutes`), pass
`readApiRequestTraceId(c)` in a named `RestRequest { session, requestId, traceId }`. Its WS command handler passes
`message.raw.id.traceId`. `RelicGameMutationService.CommandInput.traceId` is required, and
`captureRelicGameCommand` lists the captured fields, so the `relic:<sha(command)>` msgId and the idempotency identity
never see the trace. The CRDT WS ingress carries the envelope trace through `AuthenticatedCrdtAppendInput`,
`EnqueueAuthenticatedCrdtAppendInput` and `CreateAndEnqueueCrdtAppendInput`. The WS connect enqueue carries the
upgrade request's trace, and the RTC RTT enqueue carries the inbound envelope's. The test-only
`writeCrdtCommandUntilCompletion` and `writeCrdtCommandNoWaiting` are deleted, since no trace was in their scope.

### 6.e Server publications, replies and controls (D451)

Every envelope the server mints carries the trace of the command that caused it, and nothing else decides a trace:

- handler-minted publications (Relic game publications, the CRDT audit and fanout outbox, auth logout, the client
  continuation and state-sync rows, the formation timer, the connect trigger, the presence summary, the topology
  outbox, the admin prune page) take `traceId` in their compute input from the handler's `context.message.id.traceId`;
- work-derived publications (the coalesced topology revision, the topology promotion, the connect trigger replay,
  the presence summary worker's state-sync entries, the prune page worker, the overlay topology messages) inherit it
  from the work row's envelope (`entry`) or, for the presence summary and its state-sync entries, from the event's
  `traceId`, which D452 makes non-null;
- replies inherit the request's trace: `newALReplyMessage(request, …)` copies `request.id.traceId`, so the server AI
  topic, the Relic planning topic and the CRDT catch-up reply carry it;
- controls (ACK, NACK, receipt, relay ACK) carry the subject message's trace, since they are about that message;
- autonomous publications with no command behind them (the activation status clock, the retention entry, the
  topology hydration unicast, the replay repair) mint `newALTraceId()`.

Snapshot paging already copies `id` (`state-snapshot-page.ts:186`), so pages inherit it.

**As applied (I1b-i).** A trace is never minted inside a pure compute, because `validate` and the stored-row
validators recompute it. Each family's handler reads `context.message.id.traceId` once and passes it in its compute
input facts. Work-derived sites take the retained work row's envelope trace: the topology work, the presence summary
worker, the admin prune page worker and the coalesced topology head, where each generation carries the trace of the
change that wrote it. The presence summary reads the row's envelope, not the event, and a pin shows the two equal. The
commit bundle stamps its ACK, NACK and repair controls with the admitted message's trace, and the WS router NACK and
the inbound-authority NACK inherit the refused message's. The ACK relay reads `arrival.msg.id.traceId`, the admitted
ACK's own trace, which every production ACK takes from the message it acknowledges; the owner row's persisted shape is
unchanged. The receipt aggregation keeps the admitted message's trace in its in-memory `Admission`, and every receipt
is written from one `IssuedReceipt { receipt, deadlineAtMs, traceId }`. A swept `timed-out` receipt now reports the
aggregate's own deadline in its observation; row expiry is unchanged. The CRDT catch-up reply is built with
`newALUntargetedMessage` and passes the accepted request's trace. The complete set of server-minted traces is these
boundary mints, each pinned to validate and to differ between two mints:

- the group-topology planning service's local publication, which is never persisted and answers no command;
- the topology replay repair and the reconnect hydration, which restate current state to a peer and answer no
  command;
- the activation status clock arm, `createActivationStatusClockArm`, an outbox row the topology work cycle arms
  through a port that carries no trace;
- the autonomous group-state enqueues: retention and expired presence from their sweeps, the formation criterion and
  automation, topology publication and activation status commands from the topology work cycle's `submitCommand`
  ports, and session cleanup from a socket close;
- the client enqueues for a WS disconnect, fired by a socket close with no request in scope, and for expired
  sessions, from a sweep.

Beside them, the HTTP middleware mints only when `x-request-id` is absent or invalid, the browser mints one per HTTP
request, and `buildALMessage` mints only when a caller passes no trace.

### 6.f The audit stamp is the trace (R9, D452)

The mutation request bodies lose their optional `traceId` (27 OpenAPI schemas, the group and client validators, the
browser translation's pass-through) and `MutationActorInput.traceId` becomes `string`, filled by the inbox handler
from the command envelope before `compute`; the group and client idempotency identities no longer contain a body
trace. `AuditStamp`, `GroupEvent` and `ClientEvent` keep `traceId: string | null` as persisted and response
contracts, because rows written before I1b hold `null` and no migration rewrites them; every writer after I1b writes
a string, the autonomous mutations included (their enqueue minted one). So a state event the browser reads names the
same trace as the HTTP request that caused it, the AppInbox envelope that ran it and the publications it minted.

**As applied (I1b-i).** `MutationActorInput.traceId` is removed rather than made required. The actor input is part
of the hashed logical command, so a trace there would enter the idempotency identity, and the trace stays outside it.
`AuditStamp`, `GroupEvent` and `ClientEvent.traceId` are filled from the handler facts, read once per family from
`context.message.id.traceId`. A body `traceId` is refused as an unknown field (400). The group command's shape
changed, so its command hashes and event ids changed too; a persisted ingress command with the old key is refused,
with no migration.

### 6.g The proof of I1b-i (D453)

Unit (`packages/tests/shared`, `shared-web`, `shared-server`): the grammar and the decoders; a builder without a
trace mints one and a builder with one keeps it; a version-3 envelope is refused `unsupported`; the same trace across
the RTC-to-WS fallback, the repair retransmission, the checkpoint restore and the persisted round trip; the handle's
and the message's `traceId`; `reply()` copies the request's trace; `executeHttpRequest` sends `x-request-id` and
mints it per request; the enqueue factory stamps the envelope and keeps the stored command trace-free; each
handler-minted and work-derived publication carries its command's trace, each control its subject's, each
autonomous publication a fresh one; the audit stamp equals the envelope trace. Deno (`apps/api-v1/test`,
`apps/relic-hunter-server-v1/test`): the middleware validates, mints, echoes and exposes the header; the CORS
allow-list names it; a mutation route's enqueue carries the request's header value; a body `traceId` is refused as
an unknown field; the Relic HTTP command's publication and the Relic WS command's publication carry the request's
trace; the planning reply carries the request's trace. The black-box runner's raw WS recipes (18 JSON files) move to
version 4 with a trace. The conformance lane and the hosted manifests change only where version 4 forces it; trace
evidence in the lane is I1b-ii.

**As applied (I1b-i).** `sendApiHttpRequest`, not `executeHttpRequest`, is pinned to send and mint `x-request-id`.
The Deno end-to-end pins are `apps/api-v1/test/db/pglite-concurrent-group-setup.test.ts` (a group creation's
`x-request-id`, distinct from its `requestId`, on its APP_INBOX row and every APP_OUTBOX and WS_OUTBOX row),
`apps/relic-hunter-server-v1/test/relic-game-routes.test.ts` (a REST reset's header on every Relic publication and
its echo), `relic-server-service.test.ts` (a WS command's envelope trace on every Relic publication) and
`relic-planning-ai-topic.test.ts` (the planning reply). `pglite-ws-ticket-connect.test.ts` pins the WS connect's
trace, and `pglite-topology-auth.test.ts` the RTT ingress row's. The recipe `api-v1-group-state-delta-contents.json`
sends `x-request-id` and asserts it on the WS publication's `id.traceId` and its event's `traceId`. The black-box
runner keeps only allow-listed response headers (`normalizeBlackBoxResponseHeaders`), which drop `x-request-id`, so
the echo is pinned by Deno route tests; harness identity is I1b-ii (D454).

### 6.h I1b-ii, outcome-shaped (R7, D454)

`traceId` (and `corrId`) appended at the end of the message-scoped runtime diagnostics (scenario waits match key
order), on `RallarTimingEvent` and the AppInbox timing lines, the ws-receipt facts and the admin receipt recorder,
and in the black-box safe projections' allow-lists; the harness `messages.send` result value and the typed-channel
message event gain `traceId`, the identity assessors assert sender and receiver trace equality and the same trace
across the reload and fallback cells, and a server-originated cell proves HTTP through AppInbox to the browser. The
payload-free diagnostics class: the console-warning bridge sends a fixed token and source instead of
`JSON.stringify(args)`, the `ws.send` result stops echoing the sent `message`, the distributed-run diagnostic rows
carry identity instead of `payloadSummary` and no longer fall back to a payload's `topic`, and a sentinel-payload
guard over every diagnostic the lane records pins it. Message evidence events (`rallar.browser.*.message`, wait
results, the framework conformance fixtures, the realtime lane, the director diagnostics) keep their payloads as the
recipes' assertion surface (R7). Docs close PC9. The hosted manifests regenerate from their builders.

I1b-ii also owns the trace on harness identity: the black-box runner's compared response headers and the harness raw
control, which mints its own trace today (`submit-black-box-raw-control.ts`).

### 6.i Decisions

- **D447** One trace identity: `id.traceId` is required, `[A-Za-z0-9_-]{1,128}`, owned by `al-contracts/trace/`;
  envelope version 4, other versions refused `unsupported`; `buildALMessage` mints when absent; retries, fallback,
  repair and restore carry it unchanged.
- **D448** Browser: `traceId?` send input, a trace per send, `traceId` on the handle and on `RallarMessage`,
  `reply()` copies the request's; `x-request-id` minted per request in `executeHttpRequest`, the direct `fetch`
  callers folded onto it, `authFetch` deleted. As applied: the function is `sendApiHttpRequest(input)` with
  `newApiRequestHeaders` and one `readApiErrorBody`; `RallarServerAppInbox.Operation.enqueue` and `submit` take
  `{ command, traceId }` from their caller.
- **D449** HTTP: `x-request-id` is the carrier; the timing middleware validates, mints when absent or invalid,
  echoes, records and sets it; `readApiRequestTraceId(context)` is the one reader; CORS allows it; OpenAPI names it.
- **D450** AppInbox: `AppInboxEnqueueInput.traceId: string`; the factory stamps the envelope; the stored command
  and the idempotency identity stay trace-free; routes pass the request trace, WS-origin commands inherit the
  inbound envelope's, autonomous enqueues mint, auth stamps its own rows. As applied: the stored command is
  `AppInboxEnqueue`, `AppInboxEnqueueInput extends AppInboxEnqueue { traceId }`, handlers build
  `AppInboxCommandAttempt`, and the WS connect and RTT enqueues carry their request and envelope traces.
- **D451** Every server-minted envelope carries its command's trace: handler-minted through the compute input,
  work-derived from the work row or the event, replies from the request, controls from the subject message,
  autonomous publications mint. As applied: no mint inside a pure compute; `RtcTopologyPublication.traceId` is
  persisted; controls inherit with no persisted shape change; the complete set of server mints is in §6.e.
- **D452** The request body `traceId` is removed; `AuditStamp`, `GroupEvent` and `ClientEvent` keep
  `string | null` for rows written before I1b. As applied: `MutationActorInput.traceId` is removed, not made
  required, because the actor input is hashed into the logical command and the trace stays outside the idempotency
  identity; the stamp and the events are filled from the handler facts.
- **D453** Proof as in §6.g; the raw WS recipes move to version 4; lane trace evidence is I1b-ii. As applied: Deno
  end-to-end pins for api-v1 group creation and the Relic REST and WS commands; the response-header echo is pinned by
  Deno route tests, because the black-box runner drops `x-request-id`.
- **D454** I1b-ii as in §6.h: diagnostics and harness identity, the payload-free diagnostics class with its sentinel
  guard, message evidence keeps payloads (R7), docs close PC9. Harness identity includes the runner's compared
  response headers and the harness raw control's trace.

### 6.j Corrections and carries

- The roadmap's I1b row reads "a trace id stamped at envelope creation and carried from the HTTP request through
  AppInbox into server publications and replies, preserved across retries and fallback; payload-free runtime and
  harness diagnostics". As applied: the trace is required on a version-4 envelope; "payload-free harness
  diagnostics" is the diagnostics class, not the message evidence (R7); the row splits into I1b-i and I1b-ii.
- The product description's "PLANNED — I1b, session and trace identity" becomes trace identity only: session
  identity exists on the hydration unicast and is not a planned part.
- Carries: a trace on the realtime JSON lane (no msgId there); authored trace sentinels in receiver waits (the
  recipes keep payload sentinels); `traceparent` interoperability; a trace column beside the stored audit JSON.
