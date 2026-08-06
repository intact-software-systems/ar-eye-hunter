# Rallar Ontologies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce separately versioned domain, realtime-protocol, and repository-code-standards ontologies that make existing Rallar semantics discoverable and traceable without changing runtime authority or wire formats.

**Architecture:** Small hand-authored TypeScript vocabulary modules are the primary semantic representation; separate binding modules point from those concepts to existing contracts, schemas, validators, protocol constants, owners, and checker implementations with explicit stability levels. Deterministic build-time tooling composes any selected modules and emits JSON-LD and Markdown, while production runtime and enforcement code never depend on ontology artifacts. Existing runtime code remains authoritative for state, authorization, transactions, convergence, payload validation, delivery, and code-rule identities.

**Tech Stack:** TypeScript 7, Node/tsx, Vitest, existing Rallar contracts and validators, a build-time JSON-LD 1.1 processor, generated JSON-LD and Markdown, and the existing Node ESM repository-style checker.

## Global Constraints

- Execute each task on the named non-default `codex/*` track in section 9, based on a default branch that already contains its declared prerequisites. Do not create one long-lived combined ontology branch.
- Keep every task's commit, push, and pull-request scope independent and follow the repository's publication approvals and completion gates.
- Preserve every existing public export, import path, ALMessage v2 field, `typeId`, topic, lane ID, and Group/Room translation behavior.
- Keep `GroupRef` as the authoritative composite application/workspace/group identity.
- Model Room as a browser/product projection of authoritative Group state, never as a synonym or second authority.
- Do not use `owl:sameAs`, `skos:exactMatch`, or type-name equality to equate runtime/domain concepts. Use explicit Rallar relations such as `projects`, `identifiedBy`, and `usesGroupRef` with directional meaning.
- Keep direct `rallar.realtime` RTC lane traffic distinct from AL-enveloped `rallar.messages` traffic.
- Keep `.agents/skills/rallar-code-writing/references/repo-code-style.md` authoritative for normative code standards.
- Keep TypeScript contracts, OpenAPI, runtime validators/decoders, and AST checkers authoritative for enforcement.
- Keep existing code-rule IDs checker-owned. Ontology modules may import and verify them, but checkers must never import ontology source or generated ontology artifacts.
- Ontology metadata describes semantics, relationships, validator selection, traceability, and documentation. It never grants authorization or owns state, transactions, game decisions, convergence, or retries.
- Do not put ontology IDs, JSON-LD, RDF, or schema metadata into RTC or WebSocket packets.
- Do not add a triple store, RDF library, OWL reasoner, SHACL runtime, or network lookup in the first implementation.
- Do not hand-maintain the same fact in TypeScript ontology data, JSON-LD, Markdown, checker code, and schema files. Existing contract owners keep their facts; ontology bindings import or reference them; generated files are projections.
- Use repository-relative source references only. Generated artifacts contain no absolute paths, credentials, payload values, principals, sessions, tokens, or environment data.
- Classify every code binding as `contractual`, `owner`, `implementation`, or `example`. Only contractual bindings may block CI for exact resolution; implementation and example drift is report-only.
- Keep binding IDs out of vocabulary terms. Stable exported wire/topic/lane values may be imported as semantic identity; validator/schema, authorization-owner, and lane-config references live in separate binding profiles joined by stable term/route IDs.
- Make registry composition pure and deterministic. Do not add a mutable global registry or hidden startup registration.
- A runtime validator selected through ontology metadata remains the existing validator function; the ontology does not reimplement validation.
- Adding automatic payload validation to an existing receive path, changing failure timing, changing `senderId` meaning, or correlating fallback attempts on the wire requires separately approved compatibility work.
- Add ontology detail only when it answers an accepted competency question, identifies an authority boundary, or binds a stable contract. Do not model private call graphs, line numbers, every field, or temporary adapters.
- Follow TDD: each implementation task writes and runs its RED tests before production changes.
- Preserve unrelated working-tree changes and stage only files named by the active task.

---

## 1. Executive Decision

### 1.1 Primary representation

Use small, immutable TypeScript vocabulary and binding modules built with `as const satisfies` and composed by pure functions. Use repository-governed HTTPS IRIs:

```text
https://github.com/intact-software-systems/ar-eye-hunter/ontology/domain
https://github.com/intact-software-systems/ar-eye-hunter/ontology/realtime
https://github.com/intact-software-systems/ar-eye-hunter/ontology/code-standards
https://github.com/intact-software-systems/ar-eye-hunter/ontology/extension/<owner>/<ontology-name>
https://github.com/intact-software-systems/ar-eye-hunter/ontology/term/<owned-term-name>
https://github.com/intact-software-systems/ar-eye-hunter/ontology/relation/<owned-relation-name>
https://github.com/intact-software-systems/ar-eye-hunter/ontology/route/<owned-route-name>
https://github.com/intact-software-systems/ar-eye-hunter/ontology/owner/<owned-capability-name>
https://github.com/intact-software-systems/ar-eye-hunter/ontology/binding-set/<owned-binding-set-name>
https://github.com/intact-software-systems/ar-eye-hunter/ontology/binding/<owned-binding-name>
https://github.com/intact-software-systems/ar-eye-hunter/ontology/binding-profile/<owned-profile-name>
```

The IRI is semantic identity, not a runtime route. Rallar controls the repository namespace, but the initial `0.x` releases make no public dereferenceability or external-governance promise; publishing redirects or content negotiation requires the separate approval in section 13. Each ontology starts at experimental version `0.1.0`, has its own version IRI ending in `/version/0.1.0`, and promotes to stable `1.0.0` only after named consumers demonstrate the competency questions. Existing wire IDs remain compact strings such as `rallar.crdt.update.v1`, `room.crdt`, and `realtime`; vocabulary terms import those stable values while separate binding profiles trace them to their owning exports.

Governed IDs use their exact canonical ASCII form: lowercase owner/name segments containing letters, digits, dots, and hyphens, with slashes only at declared namespace boundaries. Ontology-series IDs use the declared top-level series or `/extension/<owner>/<name>` form; they cannot occupy the reserved `term`, `relation`, `route`, `owner`, `binding-set`, `binding`, or `binding-profile` subnamespaces. Validation rejects empty segments, query/fragment suffixes, percent-encoded alternatives, Unicode-confusable spellings, and implicit URL normalization. Equality is exact string equality after validation, so two spellings cannot silently identify the same concept.

The representation decision is:

| Technology          | Decision                                                  | Reason                                                                                                                             |
| ------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript registry | Primary, hand-authored                                    | Fits the monorepo, separates vocabulary from code bindings, imports existing constants, and needs no new runtime dependency.       |
| JSON-LD 1.1         | Deterministic generated projection                        | Provides linked-data interchange from vocabulary data only; a build-time processor verifies expansion semantics.                   |
| RDF/RDFS            | Representable through JSON-LD context; no runtime library | Basic class/relation semantics are useful, but a graph engine is unnecessary for the pilot.                                        |
| OWL                 | Rejected for the initial releases                         | Open-world reasoning does not match Rallar's closed-world validation and would add operational complexity.                         |
| SHACL               | Deferred                                                  | It can later be generated for external RDF consumers, but it must not duplicate runtime validation in initial releases.            |
| JSON Schema/OpenAPI | Referenced existing enforcement source                    | Payload and HTTP shapes stay with their current schema owners. The ontology stores references, not copied schemas.                 |
| Runtime decoders    | Referenced existing enforcement source                    | Existing validators keep error timing and accepted shapes.                                                                         |
| SKOS                | Reused vocabulary in generated JSON-LD                    | Supplies concept, label, definition, concept-scheme, broader/narrower, and related semantics without OWL reasoning.                |
| Dublin Core Terms   | Reused vocabulary in generated JSON-LD                    | Links each version resource to its concept scheme with `dcterms:hasVersion`, `dcterms:isVersionOf`, and an identifier.             |
| AST checker         | Existing enforcement and rule-ID source                   | The code-standards ontology imports checker-owned IDs and links them to normative sections; the checker never depends on ontology. |
| Triple store        | Rejected for the initial releases                         | Static composition and reports meet the pilot needs with no service, storage, security, or deployment burden.                      |

### 1.2 Non-goals

- No knowledge graph service or query endpoint.
- No automatic inference in browser/server request paths.
- No generated domain classes, REST DTOs, AL envelopes, or authorization policy.
- No replacement of `GroupRef`, `GroupSnapshot`, `RallarRoomState`, ALMessage, CRDT validators, OpenAPI, or checker findings.
- No exhaustive catalog of every app/game message in the pilot.
- No payload bytes added to direct RTC, AL-over-RTC, AL-over-WS, or signaling messages.
- No silent runtime validation rollout through `toRallarMessage<T>` or direct realtime listeners.
- No claim that an unvalidated or assertion-only payload has a runtime schema or validator.
- No hard CI dependency on private implementation symbols or repository file layout.

## 2. Current-State Architecture And Gaps

### 2.1 Domain ownership

| Concept                          | Current authority or projection                         | Key symbols                                                                                   |
| -------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Application/Workspace scope      | Shared contract vocabulary                              | `GroupScope`, `ClientScope`, `StateScope` in `packages/shared/api/**`                         |
| GroupRef                         | Authoritative scoped identity                           | `GroupRef` in `packages/shared/api/group-types.ts`                                            |
| Group/Membership/Presence        | Authoritative group-state values                        | `Group`, `GroupMember`, `GroupPresenceSession`, `GroupPresenceSummary`                        |
| Principal/ClientInstance/Session | Authoritative client-state values                       | `ClientPrincipal`, `ClientInstance`, `ClientSession` in `packages/shared/api/client-types.ts` |
| Snapshot/Event                   | Complete authoritative projections/history              | `GroupSnapshot`, `ClientSnapshot`, `GroupEvent`, `ClientEvent`                                |
| Room                             | Browser/product projection                              | `RallarRoomSummary`, `RallarRoomState`, `toRallarRoomSummary`, `toRallarRoomState`            |
| Topology                         | Scoped computed snapshot                                | `RallarOverlayTopologySnapshot`                                                               |
| CRDT document                    | Collaborative document identity and state               | `RallarCrdtDocumentRef`, `RallarCrdtUpdateEnvelope`, `RallarCrdtSnapshotEnvelope`             |
| AI result/proposal               | Validated proposal with lifecycle, not domain authority | `RallarAiJsonResult`, `RallarAiResultLifecycleState`, accepted-result helpers                 |

OpenAPI already owns serialized schemas for `ClientPrincipal`, `ClientInstance`, `ClientSession`, `ClientSnapshot`, `Group`, `GroupMember`, `GroupPresenceSession`, `GroupSnapshot`, `GroupRef`, and `RallarCrdtUpdateEnvelope` in `apps/api-v1/resources/api-v1-openapi.yaml`. Runtime validation already exists in `packages/shared/api/authoritative-state-validation.ts`, `packages/shared/api/rallar-validation.ts`, and `packages/shared/crdt/crdt-codec.ts`.

`RallarAiSchemaRegistry` in `packages/shared/rallar-ai/rallar-ai-schema-registry.ts` is the closest existing registry precedent: callers construct it explicitly, entries use an exact `schemaId@schemaVersion` key, `compatibleWith` lists exact accepted prior versions, and listing is deterministic. The ontology adopts those compatibility and deterministic-listing semantics but does not merge with, populate, or replace the AI schema registry. Expanded AI terms link to `RallarAiSchemaRegistry` and `toRallarAiSchemaKey` as existing schema/version owners.

The ontology must link to these owners. It must not copy their fields or claim that Room is authoritative.

### 2.2 Protocol family traces

The following code-derived traces justify the semantic boundaries selected by this plan. They are review evidence in this plan, not ontology records: generated artifacts and CI must not preserve exact helper names, call order, or cleanup methods. Task 9 extracts only stable exchange-pattern, envelope, authority, validation, and result-ownership concepts from them.

#### Direct JSON/binary RTC lane traffic

Construction and registration:

1. Browser composition creates `RallarRealtimeController` through `createRallarRealtimeController(...)` in `packages/shared-web/browser/rallar-runtime/realtime.ts` after middleware/RTC dependencies exist.
2. `onJson(laneId, handler)` or `onBinary(laneId, handler)` records a listener and calls `registerLaneCallbacks(laneId)`.
3. `registerCallbacksForPeer(...)` registers `QRtcDataChannel.onRawMessageDo(...)` for each active peer/lane. Peer lifecycle attachment repeats registration for newly created peers.
4. The first possible callback invocation is the channel's `RTCDataChannel.onmessage`, after the channel and listener callback are registered.

Runtime invocation, failure, cleanup, and result:

1. `RallarRealtimeFacade.sendJson` / `sendBinary` reaches `sendJson` / `sendBinary` in the controller.
2. The controller connects middleware, resolves peers, calls `WebRtcConnectionService.ensurePeerLaneOpen`, and then calls `QRtcDataChannel.sendJson` or `sendBinary`.
3. `sendJson` only performs `JSON.stringify`; `sendRaw` owns closed/backpressure/queue/sent decisions and returns `RtcDataChannelSendResult` per peer. Room helpers aggregate these into `RallarRoomRealtimeSendResult` with `sent`, `partial`, `no-targets`, `not-ready`, or `failed` status.
4. Receive dispatch parses a string with `JSON.parse` to `unknown`, then delivers it through a generic `RallarRealtimeHandler<T>` without payload-schema validation. Binary delivery only normalizes to `ArrayBuffer`.
5. Parse errors and listener exceptions are logged and not delivered. Unsubscribe removes the listener; `deleteLaneIfUnused` removes raw callbacks. `detachLaneCallbacks` removes all lane callbacks during runtime cleanup.

Scope consequence: the lane carries no automatic Room identity. A shared-lane payload must carry `roomRef` and the consumer must check `isSameGroupRef`, unless the lane is unique to one room.

#### ALMessage over RTC

Construction and registration:

1. `RallarMessagesController.sendRtcMessage` validates send inputs and constructs an AL v2 multicast message with `newALMulticastMessage`; `GroupRef` is placed in `targets.groupRef`.
2. `WebRtcRxStreamerService` and `WebRtcOverlayMulticastManager` construct inbound/outbound AL runtimes before peer callbacks can fire.
3. `RallarMessagesController.registerRtcMessageCallback` registers a type-ID callback with `WebRtcRxStreamerService.onInboxMessageDo`.
4. `WebRtcRxStreamerService.addPeer` registers the AL channel callback with `QRtcDataChannel.onRtcMessageDo`.

Runtime invocation, failure, cleanup, and result:

1. `sendRtcMessage` calls `WebRtcRxStreamerService.enqueueOutboxIfAbsent`; the multicast manager and `ALOutboundMessageRuntime` plan QoS, deduplication, ordering, supersedence, persistence, forwarding, and immediate/queued dispatch.
2. `WebRtcOverlayMulticastManager.sendPreparedMessage` resolves the immediate next hop, checks channel health, and calls `peer.channel.send(msg)`. Missing targets/channels and non-open channels become typed outbound statuses/retry hints.
3. The peer channel parses the JSON object and `WebRtcRxStreamerService.addPeer` casts it to `ALMessage`; sender mismatch is currently warned, not rejected there.
4. `ALInboundMessageRuntime.handleIncomingMessage` owns control-message handling, deduplication, ordering, persistence, forwarding, and dispatch. `RallarMessagesController.dispatchTransportMessage` converts the envelope through `toRallarMessage<T>` and invokes matching listeners.
5. The caller sees `RallarMessageSendResult` with transport, AL message, queue entries, status, and reason. Listener exceptions are logged. Unsubscribe removes type registrations when no RTC subscriptions remain; `detachRtc` removes all registered type callbacks.

#### ALMessage over WebSocket

Construction and registration:

1. `RallarMessagesController.sendWsMessage` constructs an AL v2 broadcast message with `newALBroadcastMessage`.
2. The authenticated API route `apps/api-v1/src/routes/ws-routes.ts:init` validates a WebSocket ticket/session, binds the socket connection ID to `authSession.sessionId`, records trusted connection facts, and enqueues the lifecycle mutation through AppInbox.
3. `WsQueueBoxClientService` and `WsQueueBoxServerService` construct AL inbound/outbound runtimes before socket callbacks are registered.
4. `initRallarSystemWsTopics` registers reserved system topics; `RallarServerWsFacade.install` registers the dynamic topic router through `onAnyInboxMessageDo`.

Runtime invocation, failure, cleanup, and result:

1. Browser `sendWsMessage` calls `WsQueueBoxClientService.enqueueOutboxIfAbsent`; the outbound runtime sends immediately or queues through QueueBox.
2. Server `WsQueueBoxServerService.handleIncomingServerMessage` resolves the authenticated peer for the connection and drops messages whose `message.id.senderId` does not equal that peer.
3. Server `ALInboundMessageRuntime` dispatches to system callbacks and the dynamic router. `RallarServerWsFacade.handle` rejects system/reserved/unknown topics, missing targets, oversized or invalid JSON payloads, failed room authorization, schema-invalid payloads, and policy-denied messages before handlers/fanout.
4. Fanout is `none`, `live-only`, or durable `outbox`; the server queue service reports recipient/send failures. The client inbound runtime dispatches by `typeId`, and `toRallarMessage<T>` performs generic decode for listeners.
5. Client send callers receive `RallarMessageSendResult`. WebSocket health/reconnect state is caller-visible. `close` disables reconnect and closes the socket; lifecycle code removes server connection state and enqueues authoritative disconnect cleanup through AppInbox.

#### RTC signaling over WebSocket

Construction and registration:

1. `initialiseRtcConnectionService` constructs `WsRtcSignalingTransportUsingWsQBox`, then `WebRtcConnectionService`, then calls `connectSignaler`.
2. `WsRtcSignalingTransportUsingWsQBox.connect` registers socket lifecycle callbacks and a signaling `typeId` inbox callback before connecting.
3. `initRtcSignalingTopic` registers the corresponding server system-topic callback.

Runtime invocation, failure, cleanup, and result:

1. `QRtcPeerConnection.sendSignal` creates `QRtcSignalingMessage` and serializes outbound sends through `outboundSignalingChain`.
2. `WsRtcSignalingTransportUsingWsQBox.send` wraps the signal in an AL unicast message and enqueues it on WS.
3. The authenticated WS server routes it to `initRtcSignalingTopic`, which parses the inner resource with a type assertion and sends the unchanged AL envelope to `toId`.
4. Client `WebRtcConnectionService.toSignalingProtocol().onMessage` parses and asserts `QRtcSignalingMessage`, checks `toId`/self, applies inbound peer admission, and calls `QRtcPeerConnection.handleSignal`; `payload` remains `unknown` until asserted as `QRtcDataExchanged`.
5. Errors are logged in transport callbacks/signaling chains; peer attempt budgets and lane readiness expose connection failure. The transport currently has no explicit unregister/dispose method for its two callback registrations.

#### `rtc-with-ws-fallback`

Construction and registration:

1. `RallarMessagesController.createRoomMessageChannel` defaults `send` to `rtc-with-ws-fallback`.
2. `sendTypedMessageWithStrategy` owns the transport order and success decision.
3. CRDT reuses this shape through `sendRallarCrdtLiveUpdate` and `sendThroughOrderedTransports` for `rallar.crdt.update.v1`.

Runtime invocation, failure, cleanup, and result:

1. RTC is attempted first. If the returned AL outbound status is successful, that result is returned.
2. A non-success RTC result causes a new WS send and returns the WS result. Without a caller-supplied `resourceId`/correlation value, the two attempts can have different AL message/resource IDs.
3. The generic channel does not deduplicate the semantic operation across transports; message-specific idempotency/convergence remains a domain responsibility.
4. Subscription cleanup is the union of the RTC and WS unsubscribe paths described above.

### 2.3 Validation gaps the ontology will expose, not silently fix

- `ALPayload.typeId` is not statically coupled to a payload TypeScript type or runtime validator.
- `decodeMessagePayload<T>` parses JSON and asserts `T`; on parse failure it returns the raw string asserted as `T`.
- Direct realtime parses JSON to `unknown` and delivers it through generic handlers without schema validation.
- RTC AL ingress casts the decoded channel object to `ALMessage`; complete persisted-envelope validation is not universal live-ingress validation.
- `QRtcSignalingMessage.payload` is `unknown`, and signaling parsing uses assertions.
- `senderId` can mean session, peer, node, or server depending on the builder/caller.
- `validatePersistedALMessage` validates the complete AL envelope but deliberately does not validate domain payloads by `typeId`.
- Fallback attempts may represent one semantic operation with different transport-specific AL identities and no explicit correlation.

The initial report represents these with discriminated validation semantics plus separate binding profiles, sender-kind vocabulary, and correlation ownership. It must say `unvalidated` where that is the current truth; runtime behavior changes are separate work.

### 2.4 Competency questions and detail ceiling

The ontology exists to answer the following questions. Each question has a stable ID used by pilot tests and the generated report:

| ID            | Question                                                                                                                                        | Minimum evidence                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `CQ-DOM-001`  | Given Room, what authoritative concept does it project, what scoped identity identifies it, and which translation boundary owns the projection? | Group and GroupRef term relations plus contractual Room translation bindings.                            |
| `CQ-DOM-002`  | How do Principal, ClientInstance, and Session relate without treating a bare session ID as global identity?                                     | Identity/lifecycle relations and authoritative contract bindings.                                        |
| `CQ-RT-001`   | Given one `typeId` and topic, what scopes, transports, target modes, delivery semantics, and authorization owner apply?                         | One message term, route semantics, and owner bindings.                                                   |
| `CQ-RT-002`   | What payload and envelope validation actually occurs, and where is validation absent or assertion-only?                                         | Discriminated validation semantics plus a separate binding profile with no invented schema or validator. |
| `CQ-RT-003`   | How does direct RTC lane traffic differ from AL-enveloped RTC/WS traffic, and where must Room scope be carried?                                 | Direct-lane and AL exchange-pattern terms.                                                               |
| `CQ-RT-004`   | For RTC-with-WS fallback, which IDs correlate attempts and who owns deduplication/convergence?                                                  | Fallback relation and explicit `domain-owned` correlation disposition.                                   |
| `CQ-STD-001`  | Given a code-rule ID, where are its normative rule, checker, review evidence, enforcement gate, exception policy, owner, and removal condition? | Checker-owned rule ID plus code-standard bindings.                                                       |
| `CQ-BIND-001` | Which code bindings are contractual, which identify an owner, and which are merely implementation or example pointers?                          | Binding-strength inventory and drift report.                                                             |

Task 8 may add the following candidate questions only if the human accepts them at the pilot go/no-go. Until then, the report labels them `proposed-for-expansion`, not answered requirements:

| ID           | Candidate expansion question                                                                                                                                            | Minimum evidence after approval                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `CQ-DOM-003` | How do membership, presence, snapshots, and events refer to Group/Principal/Session without becoming new identity authorities?                                          | Lifecycle relations plus existing contract/owner bindings; no copied payload unions. |
| `CQ-DOM-004` | Which topology, CRDT, and AI artifacts are authoritative, derived, collaborative, or proposals, and which existing registry or acceptance boundary owns their validity? | Authority classifications plus stable contract/registry/owner bindings.              |

The detail ceiling is strict:

- Add a term, relation, or binding only when it answers one of these questions, establishes stable identity, or identifies an authority/contract boundary.
- Do not catalog private helper chains, line numbers, every TypeScript field, transient composition functions, or every message family.
- An implementation reference may improve navigation but may not become a semantic invariant or hard CI gate.
- Tasks 8-9 require a human go/no-go after the pilot report demonstrates all eight answers. A green structural test alone is insufficient.

## 3. Proposed Metamodels

### 3.1 Vocabulary contracts

Task 1 implements a minimal semantic core in the narrow `@shared/ontology/mod.ts` surface. It contains no repository paths and no code-standard-specific type:

```ts
export type RallarOntologyIri =
  `https://github.com/intact-software-systems/ar-eye-hunter/ontology/${string}`;
export type RallarOntologyId = RallarOntologyIri;
export type RallarOntologyVersionIri = `${RallarOntologyId}/version/${number}.${number}.${number}`;
export type RallarOntologyTermId =
  `https://github.com/intact-software-systems/ar-eye-hunter/ontology/term/${string}`;
export type RallarOntologyOwnerId =
  `https://github.com/intact-software-systems/ar-eye-hunter/ontology/owner/${string}`;
export type RallarOntologyRelationId =
  | `https://github.com/intact-software-systems/ar-eye-hunter/ontology/relation/${string}`
  | 'http://www.w3.org/2004/02/skos/core#broader'
  | 'http://www.w3.org/2004/02/skos/core#narrower'
  | 'http://www.w3.org/2004/02/skos/core#related';
export type RallarOntologyVersion = `${number}.${number}.${number}`;
export type RallarOntologyCompetencyQuestionId = `CQ-${string}`;

export interface RallarOntologyReference {
  readonly relationId: RallarOntologyRelationId;
  readonly targetTermId: RallarOntologyTermId;
}

export interface RallarOntologyTermBase {
  readonly termId: RallarOntologyTermId;
  readonly kind: string;
  readonly label: string;
  readonly definition: string;
  readonly status: 'draft' | 'active' | 'deprecated';
  readonly references: readonly RallarOntologyReference[];
  readonly supersededBy?: RallarOntologyTermId;
  readonly removalCondition?: string;
}

export interface RallarOntologyVocabularyModule<
  TTerm extends RallarOntologyTermBase = RallarOntologyTermBase,
> {
  readonly ontologyId: RallarOntologyId;
  readonly ownerId: RallarOntologyOwnerId;
  readonly version: RallarOntologyVersion;
  readonly versionIri: RallarOntologyVersionIri;
  readonly maturity: 'experimental' | 'stable';
  readonly compatibleWith: readonly RallarOntologyVersionIri[];
  readonly requiredVocabularyVersionIris: readonly RallarOntologyVersionIri[];
  readonly competencyQuestionIds: readonly RallarOntologyCompetencyQuestionId[];
  readonly terms: readonly TTerm[];
}
```

`RALLAR_RELATION_IDS` is one hand-authored constant map for custom relation IRIs such as `scopedBy`, `identifies`, `projects`, `identifiedBy`, `sessionOf`, `runsOn`, `mayCarryScope`, and `usesGroupRef`. Free-form predicates are prohibited. Generated JSON-LD uses SKOS for concept schemes, labels, definitions, and generic hierarchy/association; custom Rallar IRIs express domain-specific relations.

Relations are directional and asserted only as authored. The generator does not synthesize inverse, transitive, symmetric, broader/narrower, or equivalence facts; adding such inference later requires a separate semantic decision and tests.

### 3.2 Repository binding contracts

Bindings are annotations over vocabulary terms, not part of term identity or the generated semantic graph:

```ts
export type RallarOntologyBindingId =
  `https://github.com/intact-software-systems/ar-eye-hunter/ontology/binding/${string}`;
export type RallarOntologyBindingSetId =
  `https://github.com/intact-software-systems/ar-eye-hunter/ontology/binding-set/${string}`;
export type RallarOntologyBindingProfileId =
  `https://github.com/intact-software-systems/ar-eye-hunter/ontology/binding-profile/${string}`;

export type RallarOntologyBindingStrength = 'contractual' | 'owner' | 'implementation' | 'example';

export type RallarOntologyBindingTarget =
  | Readonly<{
      kind: 'typescript-export';
      modulePath: string;
      exportName: string;
    }>
  | Readonly<{
      kind: 'wire-constant';
      modulePath: string;
      exportName: string;
      propertyPath?: readonly string[];
    }>
  | Readonly<{
      kind: 'openapi-component';
      documentPath: string;
      componentName: string;
    }>
  | Readonly<{
      kind: 'runtime-validator';
      modulePath: string;
      exportName: string;
      validatorId: string;
    }>
  | Readonly<{
      kind: 'normative-anchor';
      documentPath: string;
      anchor: string;
    }>
  | Readonly<{
      kind: 'export-property';
      modulePath: string;
      exportName: string;
      propertyName: string;
    }>
  | Readonly<{
      kind: 'package-script';
      manifestPath: string;
      scriptName: string;
    }>
  | Readonly<{
      kind: 'repository-owner';
      ownerId: RallarOntologyOwnerId;
      path: string;
    }>
  | Readonly<{
      kind: 'implementation-symbol';
      path: string;
      symbol: string;
    }>
  | Readonly<{
      kind: 'example';
      path: string;
    }>;

export interface RallarOntologyBinding {
  readonly bindingId: RallarOntologyBindingId;
  readonly termId: RallarOntologyTermId;
  readonly role:
    | 'authoritative-contract'
    | 'projection'
    | 'wire-identity'
    | 'schema'
    | 'runtime-validation'
    | 'authorization-owner'
    | 'identifier'
    | 'normative-standard'
    | 'enforcement-owner'
    | 'enforcement-gate'
    | 'review-evidence'
    | 'exception-policy'
    | 'implementation'
    | 'example';
  readonly strength: RallarOntologyBindingStrength;
  readonly target: RallarOntologyBindingTarget;
}

export interface RallarOntologyBindingProfileBase {
  readonly profileId: RallarOntologyBindingProfileId;
  readonly termId: RallarOntologyTermId;
  readonly kind: string;
}

export interface RallarOntologyBindingModule<
  TProfile extends RallarOntologyBindingProfileBase = RallarOntologyBindingProfileBase,
> {
  readonly bindingSetId: RallarOntologyBindingSetId;
  readonly ontologyId: RallarOntologyId;
  readonly vocabularyVersionIri: RallarOntologyVersionIri;
  readonly ownerId: RallarOntologyOwnerId;
  readonly version: RallarOntologyVersion;
  readonly versionIri: RallarOntologyVersionIri;
  readonly maturity: 'experimental' | 'stable';
  readonly compatibleWith: readonly RallarOntologyVersionIri[];
  readonly bindings: readonly RallarOntologyBinding[];
  readonly profiles: readonly TProfile[];
}
```

Binding validation is strength-aware:

- `contractual` resolves through real module imports, OpenAPI parsing, Markdown-anchor parsing, or checker-owned exports and blocks CI when missing;
- `owner` requires the owner ID and owning path to exist but never freezes a private method name;
- `implementation` and `example` appear in the Markdown drift report and never fail normal CI for symbol/path movement;
- source-text substring search is not accepted as proof that an export, OpenAPI component, or normative anchor resolves.

### 3.3 Domain and realtime profiles

Domain and realtime modules extend the semantic base in their owning package. Repository code-standard contracts remain under `scripts/ontology`:

```ts
export interface RallarDomainOntologyTerm extends RallarOntologyTermBase {
  readonly kind: 'domain';
  readonly domainKind:
    | 'scope'
    | 'identity'
    | 'entity'
    | 'value-object'
    | 'projection'
    | 'snapshot'
    | 'event'
    | 'proposal';
  readonly authority: 'authoritative' | 'derived' | 'projection' | 'proposal';
  readonly identityFields: readonly string[];
}

export type RallarMessageTransportKind = 'al-rtc' | 'al-ws';
export type RallarMessageTargetMode = 'unicast' | 'multicast' | 'broadcast';
export type RallarMessageRouteId =
  `https://github.com/intact-software-systems/ar-eye-hunter/ontology/route/${string}`;
export type RallarSenderKind = 'client-session' | 'peer-session' | 'server-node' | 'system';

export interface RallarMessageRouteSemantics {
  readonly routeId: RallarMessageRouteId;
  readonly topicId: string;
  readonly scope: 'room' | 'app' | 'world' | 'all' | 'system';
  readonly transports: readonly RallarMessageTransportKind[];
  readonly targetModes: readonly RallarMessageTargetMode[];
  readonly requestedReliability: 'best-effort' | 'at-least-once';
  readonly acknowledgement: 'none' | 'receiver' | 'all-logical-recipients' | 'group-leader';
  readonly ordering: 'none' | 'al-policy' | 'al-policy-and-domain';
  readonly deduplication: 'none' | 'al-message-id' | 'al-semantic-key' | 'domain-owned';
  readonly supersedence: 'none' | 'al-latest-wins' | 'domain-owned';
  readonly qosOwnership: 'sender' | 'receiver' | 'shared' | 'domain-owned';
  readonly authorization: 'required' | 'not-applicable';
}

export type RallarPayloadSchemaVersionSemantics =
  | Readonly<{
      kind: 'wire-type-id';
    }>
  | Readonly<{
      kind: 'payload-field';
      fieldPath: string;
    }>
  | Readonly<{
      kind: 'external-registry';
      registryId: string;
    }>;

export type RallarPayloadValidationSemantics =
  | Readonly<{
      kind: 'runtime-payload';
      schemaVersion: RallarPayloadSchemaVersionSemantics;
    }>
  | Readonly<{
      kind: 'envelope-only';
      reason: string;
    }>
  | Readonly<{
      kind: 'unvalidated';
      mechanism: 'generic-assertion' | 'unknown-payload';
      reason: string;
    }>;

export interface RallarMessageOntologyTerm extends RallarOntologyTermBase {
  readonly kind: 'message-type';
  readonly wireTypeId: string;
  readonly routes: readonly RallarMessageRouteSemantics[];
  readonly senderKinds: readonly RallarSenderKind[];
  readonly validation: RallarPayloadValidationSemantics;
  readonly correlation: 'message-id' | 'actions-correlation' | 'domain-owned';
}

export interface RallarRtcLaneOntologyTerm extends RallarOntologyTermBase {
  readonly kind: 'rtc-lane';
  readonly laneId: string;
  readonly envelope: 'none';
  readonly payloadKinds: readonly ('json' | 'binary')[];
  readonly roomScopeCarrier: 'payload-room-ref-or-unique-lane';
}

export type RallarPayloadValidationBinding =
  | Readonly<{
      kind: 'runtime-payload';
      schemaBindingId: RallarOntologyBindingId;
      schemaVersionContractBindingId: RallarOntologyBindingId;
      validatorBindingId: RallarOntologyBindingId;
    }>
  | Readonly<{
      kind: 'envelope-only';
      envelopeValidatorBindingId: RallarOntologyBindingId;
      payloadGapOwnerBindingId: RallarOntologyBindingId;
    }>
  | Readonly<{
      kind: 'unvalidated';
      boundaryBindingId: RallarOntologyBindingId;
      gapOwnerBindingId: RallarOntologyBindingId;
    }>;

export interface RallarMessageOntologyBindingProfile extends RallarOntologyBindingProfileBase {
  readonly kind: 'message-bindings';
  readonly wireTypeBindingId: RallarOntologyBindingId;
  readonly routeBindings: readonly Readonly<{
    routeId: RallarMessageRouteId;
    topicBindingId: RallarOntologyBindingId;
    authorizationBindings: readonly Readonly<{
      transport: RallarMessageTransportKind;
      ownerBindingIds: readonly RallarOntologyBindingId[];
    }>[];
  }>[];
  readonly validation: RallarPayloadValidationBinding;
}

export interface RallarRtcLaneOntologyBindingProfile extends RallarOntologyBindingProfileBase {
  readonly kind: 'rtc-lane-bindings';
  readonly laneConfigBindingId: RallarOntologyBindingId;
}

export type RallarRealtimeOntologyBindingModule = RallarOntologyBindingModule<
  RallarMessageOntologyBindingProfile | RallarRtcLaneOntologyBindingProfile
>;
```

Vocabulary terms contain no binding IDs. The companion realtime binding profile supplies validator/schema, route-authorization-owner, and lane-config bindings. These contracts describe observed semantics; they cannot authorize, validate, route, or make delivery guarantees true at runtime.

### 3.4 Domain example records and bindings

The pilot vocabulary contains no file paths:

```ts
export const RALLAR_DOMAIN_TERM_IDS = {
  application:
    'https://github.com/intact-software-systems/ar-eye-hunter/ontology/term/domain.application',
  workspace:
    'https://github.com/intact-software-systems/ar-eye-hunter/ontology/term/domain.workspace',
  groupRef:
    'https://github.com/intact-software-systems/ar-eye-hunter/ontology/term/domain.group-ref',
  group: 'https://github.com/intact-software-systems/ar-eye-hunter/ontology/term/domain.group',
  room: 'https://github.com/intact-software-systems/ar-eye-hunter/ontology/term/domain.room-projection',
  principal:
    'https://github.com/intact-software-systems/ar-eye-hunter/ontology/term/domain.principal',
  clientInstance:
    'https://github.com/intact-software-systems/ar-eye-hunter/ontology/term/domain.client-instance',
  session: 'https://github.com/intact-software-systems/ar-eye-hunter/ontology/term/domain.session',
} as const satisfies Record<string, RallarOntologyTermId>;

const groupRefTerm: RallarDomainOntologyTerm = {
  termId: RALLAR_DOMAIN_TERM_IDS.groupRef,
  kind: 'domain',
  label: 'GroupRef',
  definition: 'Composite application/workspace/group identity used by authoritative group state.',
  status: 'draft',
  domainKind: 'identity',
  authority: 'authoritative',
  identityFields: ['applicationId', 'workspaceId', 'groupId'],
  references: [
    {
      relationId: RALLAR_RELATION_IDS.scopedBy,
      targetTermId: RALLAR_DOMAIN_TERM_IDS.application,
    },
    {
      relationId: RALLAR_RELATION_IDS.scopedBy,
      targetTermId: RALLAR_DOMAIN_TERM_IDS.workspace,
    },
    {
      relationId: RALLAR_RELATION_IDS.identifies,
      targetTermId: RALLAR_DOMAIN_TERM_IDS.group,
    },
  ],
};

const roomTerm: RallarDomainOntologyTerm = {
  termId: RALLAR_DOMAIN_TERM_IDS.room,
  kind: 'domain',
  label: 'Room projection',
  definition: 'Browser/product view projected from authoritative GroupSnapshot state.',
  status: 'draft',
  domainKind: 'projection',
  authority: 'projection',
  identityFields: ['roomRef'],
  references: [
    {
      relationId: RALLAR_RELATION_IDS.projects,
      targetTermId: RALLAR_DOMAIN_TERM_IDS.group,
    },
    {
      relationId: RALLAR_RELATION_IDS.identifiedBy,
      targetTermId: RALLAR_DOMAIN_TERM_IDS.groupRef,
    },
  ],
};
```

The companion binding module owns contractual `typescript-export`/`openapi-component` bindings for `GroupRef`, and contractual Room boundary bindings for `RallarRoomSummary`, `RallarRoomState`, `toRallarRoomSummary`, and `toRallarRoomState`. `Principal -> ClientInstance -> Session` mirrors the actual reference hierarchy; no term describes a bare session ID as global identity.

### 3.5 Protocol example record and bindings

The cross-transport pilot remains `rallar.crdt.update.v1`. Its term states the honest validation class and schema-version carrier; the separate profile supplies schema, contract, and validator binding IDs:

```ts
const crdtUpdateTerm: RallarMessageOntologyTerm = {
  termId:
    'https://github.com/intact-software-systems/ar-eye-hunter/ontology/term/realtime.message.rallar-crdt-update-v1',
  kind: 'message-type',
  label: 'Rallar CRDT live update v1',
  definition: 'A CRDT update envelope carried inside ALMessage over permitted live transports.',
  status: 'draft',
  wireTypeId: RALLAR_CRDT_UPDATE_TYPE_ID,
  routes: [
    {
      routeId:
        'https://github.com/intact-software-systems/ar-eye-hunter/ontology/route/realtime.crdt-update.room',
      topicId: RALLAR_CRDT_ROOM_TOPIC_ID,
      scope: 'room',
      transports: ['al-rtc', 'al-ws'],
      targetModes: ['multicast', 'broadcast'],
      requestedReliability: 'at-least-once',
      acknowledgement: 'none',
      ordering: 'al-policy-and-domain',
      deduplication: 'al-message-id',
      supersedence: 'none',
      qosOwnership: 'shared',
      authorization: 'required',
    },
    {
      routeId:
        'https://github.com/intact-software-systems/ar-eye-hunter/ontology/route/realtime.crdt-update.app',
      topicId: RALLAR_CRDT_APP_TOPIC_ID,
      scope: 'app',
      transports: ['al-ws'],
      targetModes: ['broadcast'],
      requestedReliability: 'at-least-once',
      acknowledgement: 'none',
      ordering: 'al-policy-and-domain',
      deduplication: 'al-message-id',
      supersedence: 'none',
      qosOwnership: 'shared',
      authorization: 'required',
    },
  ],
  senderKinds: ['client-session'],
  validation: {
    kind: 'runtime-payload',
    schemaVersion: {
      kind: 'payload-field',
      fieldPath: '$.schemaVersion',
    },
  },
  correlation: 'domain-owned',
  references: [
    {
      relationId: RALLAR_RELATION_IDS.usesGroupRef,
      targetTermId: RALLAR_DOMAIN_TERM_IDS.groupRef,
    },
  ],
};
```

The vocabulary imports the existing type/topic constants because those compact IDs are stable semantic protocol identity. Its companion realtime binding profile points to contractual wire/type and route/topic constant bindings, binds the OpenAPI component, schema-version contract, and `validateRallarCrdtUpdateEnvelope`, and associates each route/transport pair with the applicable WS authorization, RTC admission, or domain acceptance owner. Profile validation proves that resolved constant values equal the vocabulary values. `authorizeAcceptedEnvelope` may appear as an informational implementation pointer, never as a hard symbol dependency.

The direct lane term uses `DEFAULT_REALTIME_DATA_CHANNEL_LANE.id` and declares `envelope: 'none'`. Its separate lane binding profile points to a contractual `wire-constant` target for `DEFAULT_REALTIME_DATA_CHANNEL_LANE` with `propertyPath: ['id']`; profile validation compares the resolved value with `laneId`. `createRallarRealtimeController` is an implementation binding and may drift without blocking CI.

### 3.6 Code-standard example record

The code-standard vocabulary is deliberately thinner than the checker. It names the semantic rule and removal condition; separate bindings link to the checker-owned rule ID, normative standard, stable repository commands, owner, and example evidence. Severity, thresholds, applicability mechanics, parser behavior, exception fields, and finding messages remain solely in the standard/checker/tests.

The checker-owned `scripts/repo-style-check/repo-style-rule-ids.mjs` is the single source for rule IDs. Existing checkers and the ontology both import it; neither imports the other:

```ts
interface RepositoryCodeStandardOntologyTerm extends RallarOntologyTermBase {
  readonly kind: 'code-standard-rule';
  readonly ruleFamily: 'construction' | 'layout' | 'contract';
}

const forwardCaptureRule: RepositoryCodeStandardOntologyTerm = {
  termId:
    'https://github.com/intact-software-systems/ar-eye-hunter/ontology/term/code-rule.construction-forward-capture',
  kind: 'code-standard-rule',
  ruleFamily: 'construction',
  label: 'Forward-captured construction dependency',
  definition:
    'A construction-time dependency is captured before the owning composition establishes it.',
  status: 'draft',
  references: [],
  removalCondition:
    'Remove only with the normative construction rule, checker finding, test evidence, and human approval policy.',
};
```

Its binding module uses:

- a contractual `export-property` target whose property resolves to `repoStyleRuleIds.constructionForwardCapture`;
- a contractual `normative-anchor` target in the authoritative repository code standard;
- contractual `package-script` targets for stable enforcement commands such as `check:repo-style` and `check:repo-style:changed`;
- an `owner` binding for the checker capability, without naming its private functions;
- `example` bindings for representative tests/review evidence, which may move without blocking CI;
- a contractual `exception-policy` anchor only when the normative document exposes a stable anchor; otherwise the rule's general normative anchor is the sole policy authority.

`file.length` and `contract.optional-command` follow the same thin semantic shape. The generated Markdown may display the current checker-owned rule-ID value after resolving the binding; the vocabulary never stores or generates that value.

## 4. Package And Dependency Boundaries

### 4.1 File map locked before tasks

| File                                                                       | Responsibility                                                                                                         |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/ontology/rallar-ontology-contracts.ts`                    | Generic vocabulary, IRI, relation, version, and binding contracts only. It has no code-standard-specific type.         |
| `packages/shared/ontology/rallar-ontology-registry.ts`                     | Pure vocabulary/binding validation, deterministic catalog creation, lookup, and reference resolution.                  |
| `packages/shared/ontology/rallar-domain-ontology-contracts.ts`             | Domain term profile.                                                                                                   |
| `packages/shared/ontology/rallar-realtime-ontology-contracts.ts`           | Message, route, validation-classification, and RTC-lane profiles.                                                      |
| `packages/shared/ontology/rallar-domain-ontology.ts`                       | Experimental domain vocabulary root and pilot terms.                                                                   |
| `packages/shared/ontology/rallar-domain-ontology-bindings.ts`              | Contractual/owner/informational bindings for pilot domain terms.                                                       |
| `packages/shared/ontology/rallar-domain-state-ontology.ts`                 | Post-pilot membership, presence, snapshot, event, and topology terms.                                                  |
| `packages/shared/ontology/rallar-domain-collaboration-ontology.ts`         | Post-pilot CRDT document terms.                                                                                        |
| `packages/shared/ontology/rallar-domain-ai-ontology.ts`                    | Post-pilot AI result/proposal lifecycle terms.                                                                         |
| `packages/shared/ontology/rallar-realtime-ontology.ts`                     | Experimental realtime vocabulary root and CRDT pilot message term.                                                     |
| `packages/shared/ontology/rallar-realtime-ontology-bindings.ts`            | CRDT wire/schema/validator/owner bindings.                                                                             |
| `packages/shared/ontology/rallar-al-ontology.ts`                           | Post-pilot AL v2 concept terms.                                                                                        |
| `packages/shared/ontology/rallar-signaling-ontology.ts`                    | Post-pilot signaling terms with honest unvalidated boundaries.                                                         |
| `packages/shared/ontology/rallar-payload-validator-registry.ts`            | Opt-in mapping from contractual validator binding IDs to existing validators.                                          |
| `packages/shared/ontology/mod.ts`                                          | Intentional narrow domain/realtime ontology export. Do not add it to `packages/shared/mod.ts` in the initial releases. |
| `packages/shared-web/browser/rallar-browser-realtime-ontology.ts`          | Browser-owned direct RTC lane vocabulary extension. It is not imported by the facade.                                  |
| `packages/shared-web/browser/rallar-browser-realtime-ontology-bindings.ts` | Lane-config and informational implementation bindings.                                                                 |
| `scripts/repo-style-check/repo-style-rule-ids.mjs`                         | Checker-owned stable rule IDs consumed by checkers and ontology tooling. Not generated.                                |
| `scripts/ontology/repository-code-standard-contracts.ts`                   | Repository-only code-standard term profile.                                                                            |
| `scripts/ontology/repository-code-standards-ontology.ts`                   | Repository-owned code-rule vocabulary and bindings importing checker-owned IDs.                                        |
| `scripts/ontology/rallar-ontology-competency-questions.ts`                 | Hand-authored question catalog from section 2.4 and pure evidence evaluation; no runtime imports.                      |
| `scripts/ontology/rallar-ontology-artifacts.ts`                            | Pure JSON-LD and Markdown rendering from selected vocabulary/binding modules.                                          |
| `scripts/ontology/generate-rallar-ontology.ts`                             | File I/O CLI with write and `--check` modes.                                                                           |
| `docs/rallar-ontology.jsonld`                                              | Checked-in deterministic semantic projection; excludes code-path bindings.                                             |
| `docs/rallar-ontology-reference.md`                                        | Checked-in report containing vocabulary, binding strengths, drift warnings, and competency answers.                    |
| `examples/ontology-registry/README.md`                                     | App/game extension and lookup recipe.                                                                                  |

Dependency direction:

```text
existing stable wire/type/lane constants --> vocabulary modules --+
existing contracts/schemas/validators ------------> binding modules |
checker-owned rule IDs --> existing checkers                 |      |
          |                                                  v      v
          +------------------------------------------> scripts/ontology
                                                               |
                                                               +--> generated JSON-LD
                                                               +--> generated Markdown
```

`packages/shared` never imports `packages/shared-web`, `scripts`, checker modules, or generated documentation. `packages/shared-web` may import the generic ontology contracts for its optional lane module. Build-time scripts may import shared/shared-web ontology modules and checker-owned rule IDs. Existing runtime facades and existing checkers never import ontology modules or generated ontology artifacts.

## 5. Source-Of-Truth And Generation Model

| Fact                                  | Single hand-authored owner                                         | Ontology behavior                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Concept identity/definition/relation  | Owning vocabulary module                                           | Store once and project to JSON-LD/Markdown.                                                        |
| Vocabulary/binding-series ownership   | Owning module's controlled owner IRI                               | Project ownership; bind an owner path separately when repository navigation is useful.             |
| Vocabulary dependency                 | Importing vocabulary's exact `requiredVocabularyVersionIris` entry | Require only semantic dependencies; never infer them from TypeScript imports.                      |
| Binding-to-vocabulary compatibility   | Binding module's exact `vocabularyVersionIri`                      | Reject a binding set applied to another vocabulary version.                                        |
| Domain field shape                    | Existing TypeScript contract; OpenAPI for HTTP serialization       | Contractual binding only; never copy the shape.                                                    |
| Group/Room translation                | `room-group-state-translation.ts`                                  | Model Room as projection; bind the stable boundary, not its internal call graph.                   |
| AL v2 wire shape                      | `al-contract.ts`                                                   | Describe envelope concepts without emitting/changing fields.                                       |
| Message type/topic ID                 | Existing exported constant                                         | Import it into the binding/term module; never restate the string.                                  |
| Direct lane ID/config                 | Existing exported lane config                                      | Import the config; do not copy ordered/retransmit/flow-control values.                             |
| Payload runtime validation            | Existing validator function                                        | Contractually bind only when the validator exists; otherwise use `envelope-only` or `unvalidated`. |
| HTTP schema                           | Existing OpenAPI component                                         | Contractual component binding only.                                                                |
| Code-rule ID                          | `scripts/repo-style-check/repo-style-rule-ids.mjs`                 | Import and trace it; never generate it from ontology.                                              |
| Normative code rule                   | Markdown standard                                                  | Contractual anchor binding; do not copy thresholds or prose.                                       |
| Checker severity/applicability/output | Existing checker and its tests                                     | Owner/example bindings only; do not restate behavior in vocabulary.                                |
| Stable enforcement command            | Root `package.json` script                                         | Contractual package-script binding; the ontology does not execute or define the gate.              |
| JSON-LD/Markdown                      | Selected TypeScript vocabulary/binding modules                     | Generate JSON-LD from vocabulary only and Markdown from both.                                      |

The generator sorts ontology IDs, term IDs, relation IDs, binding IDs, binding-profile IDs, and report rows. It emits no timestamp. `ontology:check` renders in memory and compares exact bytes to the two checked-in projections. Each selected ontology can generate and validate independently; absence of the code-standard module cannot block domain/realtime generation.

## 6. Versioning And Compatibility

- Each vocabulary and binding module owns an independent semantic version. All pilot modules start at `0.1.0` with `maturity: 'experimental'` and draft terms.
- Promote one ontology to `1.0.0`/`stable` only after a named consumer uses it and its competency questions have remained sufficient through at least one real change.
- Vocabulary patch: labels or definitions change without changing meaning or relations. Vocabulary minor: additive draft terms/relations. Vocabulary major after 1.0: removal/rename, authority change, identity change, or incompatible relation change.
- Binding patch: a target path/re-export or informational pointer moves without changing the referenced contract's meaning. Binding minor: additive binding or owner clarification. Binding major after 1.0: the meaning of a bound schema/validator/wire/checker contract changes incompatibly.
- Every module carries a stable ontology-series IRI and a distinct version IRI. `compatibleWith` lists exact prior version IRIs, not bare version strings.
- Vocabulary dependencies list exact required version IRIs. A dependency is satisfied only by that exact selected version or by a selected newer module whose explicit `compatibleWith` contains the required version IRI; there is no SemVer-range inference. The pilot realtime vocabulary requires domain `0.1.0` because it relates CRDT messages to GroupRef; domain and code-standards vocabularies remain independent.
- Each binding module names the exact `vocabularyVersionIri` it annotates. A binding-only patch keeps that value unchanged; a vocabulary minor/major update requires a matching binding release before the pair is accepted together.
- Existing `typeId` and topic versions remain independent protocol versions. Ontology `0.2.0` does not make `rallar.crdt.update.v1` into a v2 message.
- Ontology, term, route, owner, binding-set, binding, binding-profile, wire, and rule IDs are never reused for a different meaning.
- Deprecation retains the old term with `status: 'deprecated'`, an owner binding, and explicit `removalCondition`. Set `supersededBy` only when a real replacement exists; it must resolve and cannot point to the same term. Removal waits for a major ontology version and catalog/binding consumer evidence; repository text search is supplementary.
- No implicit SemVer-range compatibility or OWL compatibility inference is introduced in the initial releases.
- Generated JSON-LD changes are reviewed as API-like metadata. Existing network and package APIs remain unchanged.

## 7. Security, Authorization, Performance, And Payload Size

- Authorization binding profiles contain owner binding IDs; vocabulary contains only descriptive sender/scope/required semantics. Neither returns an authorization decision.
- The protocol ontology records separate WS server authorization, RTC peer admission, and application payload acceptance; it does not collapse them into one boolean.
- Generated artifacts contain no sample tokens, WebSocket tickets, access tokens, real IDs, message resources, or runtime observations.
- Binding validation rejects absolute/traversing repository paths and unsafe property segments. The build-time resolver canonicalizes targets after symlink resolution, requires containment under the repository root, and never accepts package specifiers or URLs. Contractual targets resolve structurally; owner targets require a real path; implementation/example drift produces report warnings only.
- No ontology code is imported by `rallar.ts`, `rallar-core.ts`, `rallar-realtime.ts`, middleware startup, WebRTC send/receive, WS routing, or API routes.
- No packet gains any field or byte. Existing payload-size limits remain owned by `validateRallarJsonPayload`, `RallarServerWsFacade`, CRDT options, and RTC flow control.
- `ontology:generate` and `ontology:check` are build/repository tools. They run in Node through `tsx`, use a build-time JSON-LD 1.1 processor without remote context loading, make no network calls, and must finish from a clean checkout.
- Browser bundle-boundary tests and `check:browser-bundles` prove the new browser ontology extension is not pulled into existing public browser entry points.

## 8. Vertical-Slice Pilot

The pilot is Tasks 1-7, delivered as independently reviewable foundation, domain, realtime, and standards slices. Tasks 8-9 do not begin automatically after green tests: they require the human go/no-go defined below.

Pilot content:

- Domain: Application, Workspace, GroupRef, Group, Room projection, Principal, supporting ClientInstance, and Session.
- AL message: `rallar.crdt.update.v1` with room/app topic variants, schema/validator binding, sender kind, authorization-owner refs, transport rules, and fallback semantics.
- Direct RTC: browser `realtime` lane, with no metadata added to packets.
- Standards: `construction.forward-capture`, `file.length`, and `contract.optional-command`.
- Output: `docs/rallar-ontology-reference.md` and `docs/rallar-ontology.jsonld`; no generated artifact is consumed by runtime or enforcement code.
- Integrity: unique stable IDs, controlled relation IRIs, valid references, independent module validity, strength-aware binding resolution, honest validation coverage, checker-to-standard traceability, JSON-LD expansion, deterministic artifact bytes, and unchanged browser bundle boundaries.

Pilot exit criteria:

1. The report answers all eight competency questions with links to semantic terms and appropriately graded bindings.
2. Focused ontology, CRDT, realtime, and checker tests pass; existing checker output remains unchanged without importing ontology code.
3. `ontology:check` passes without writing files, and a conforming JSON-LD processor expands the artifact to the expected IRIs without remote loading.
4. Existing `rallar.crdt.update.v1`, room realtime, and message fallback tests pass unchanged.
5. `check:browser-bundles` passes and existing runtime/browser entry points do not import ontology modules.
6. Git diff contains no changes to `ALMessage`, message builders, send/receive paths, OpenAPI schemas, authorization code, RTC lane configs, or checker behavior.
7. Contractual bindings resolve; implementation/example drift is visible but cannot fail the gate.
8. The human explicitly approves or declines broader Tasks 8-9 after reviewing report usefulness and maintenance cost.

If criteria 1-7 fail, fix or roll back the owning slice; do not weaken the gate. If criterion 8 is declined, keep the successful pilot and mark Tasks 8-9 intentionally deferred rather than incomplete.

## 9. Implementation Tasks

### Task 1: Add the vocabulary, binding, and catalog foundation

**Purpose:** Establish a small semantic core whose meaning is independent of repository layout, plus a separate graded binding layer.

**Prerequisites:** Start on `codex/rallar-ontology-foundation`; confirm the worktree does not contain overlapping user edits.

**Files:**

- Create: `packages/shared/ontology/rallar-ontology-contracts.ts`
- Create: `packages/shared/ontology/rallar-domain-ontology-contracts.ts`
- Create: `packages/shared/ontology/rallar-realtime-ontology-contracts.ts`
- Create: `packages/shared/ontology/rallar-ontology-registry.ts`
- Create: `packages/shared/ontology/mod.ts`
- Create: `packages/tests/shared/rallar-ontology-registry.test.ts`

**Production symbols:**

- IRI/version/relation contracts from section 3.1 and `RALLAR_RELATION_IDS`
- Binding contracts from section 3.2
- Domain/realtime profile contracts from section 3.3
- `RallarOntologyIssue`, `RallarOntologyCatalog`, `CreateRallarOntologyCatalogInput`
- `validateRallarOntologyVocabularyModule`, `validateRallarOntologyBindingModule`
- `validateRallarOntologyCatalog`, `createRallarOntologyCatalog`
- `getRallarOntologyTerm`, `getRallarOntologyBindings`, `getRallarOntologyBindingProfiles`

**Interfaces:**

```ts
export interface RallarOntologyIssue {
  readonly code:
    | 'invalid-ontology-iri'
    | 'invalid-version'
    | 'invalid-version-iri'
    | 'invalid-term-iri'
    | 'invalid-owner-iri'
    | 'invalid-relation-iri'
    | 'duplicate-ontology-id'
    | 'duplicate-version-iri'
    | 'duplicate-term-id'
    | 'duplicate-binding-set-id'
    | 'duplicate-binding-id'
    | 'duplicate-binding-profile-id'
    | 'invalid-maturity'
    | 'invalid-compatible-version-iri'
    | 'invalid-binding-target'
    | 'invalid-binding-strength'
    | 'missing-vocabulary-import'
    | 'binding-vocabulary-version-mismatch'
    | 'missing-reference'
    | 'missing-binding-term'
    | 'invalid-deprecation';
  readonly path: string;
  readonly message: string;
}

export interface CreateRallarOntologyCatalogInput {
  readonly vocabularies: readonly RallarOntologyVocabularyModule[];
  readonly bindingSets: readonly RallarOntologyBindingModule[];
}

export interface RallarOntologyCatalog {
  readonly vocabularies: readonly RallarOntologyVocabularyModule[];
  readonly bindingSets: readonly RallarOntologyBindingModule[];
  readonly terms: readonly RallarOntologyTermBase[];
  readonly bindings: readonly RallarOntologyBinding[];
  readonly bindingProfiles: readonly RallarOntologyBindingProfileBase[];
}

export function createRallarOntologyCatalog(
  input: CreateRallarOntologyCatalogInput,
): RallarOntologyCatalog;

export function getRallarOntologyTerm(
  catalog: RallarOntologyCatalog,
  termId: RallarOntologyTermId,
): RallarOntologyTermBase | undefined;

export function getRallarOntologyBindings(
  catalog: RallarOntologyCatalog,
  termId: RallarOntologyTermId,
): readonly RallarOntologyBinding[];

export function getRallarOntologyBindingProfiles(
  catalog: RallarOntologyCatalog,
  termId: RallarOntologyTermId,
): readonly RallarOntologyBindingProfileBase[];
```

`validate...` functions return all issues and never throw. `createRallarOntologyCatalog` sorts copied arrays and throws one `TypeError` containing all configuration issues only at this programmer boundary.

**Behavioral change:** Adds an opt-in metadata API only; no runtime or checker imports it.

**Compatibility effect:** Additive narrow module; no change to `packages/shared/mod.ts` or existing imports.

- [ ] **Step 1: Write RED foundation tests**

Test independent vocabulary/binding validation, deterministic ordering (including profiles), controlled relation IRIs, canonical repository-governed ontology/owner/term/version/profile IRIs (including rejection of query/fragment/percent-encoded/Unicode-confusable variants), duplicate IDs, exact declared vocabulary dependencies satisfied only by an exact or explicitly compatible selected version, exact binding-to-vocabulary version matching, matching series/version IRIs, missing term/profile references, invalid maturity/compatibility metadata, and deprecation rules (`removalCondition` required; optional `supersededBy` resolves and is not self). Also test strength/target compatibility, non-empty `propertyPath` segments that reject `__proto__`/`prototype`/`constructor`, and rejection of absolute/traversing repository paths.

Use an experimental vocabulary fixture with version `0.1.0`, a matching version IRI, a controlled owner IRI, no required imports, one `draft` parent term, one child relation using `RALLAR_RELATION_IDS`, and a separate experimental `0.1.0` binding set with its own matching version IRI/owner IRI, the vocabulary's exact version IRI, one contractual TypeScript-export binding, and one generic profile. Also prove that the vocabulary remains valid when its binding set is omitted.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npx vitest run packages/tests/shared/rallar-ontology-registry.test.ts
```

Expected: FAIL because `@shared/ontology/mod.ts` does not exist.

- [ ] **Step 3: Implement the contracts and pure catalog**

Keep repository I/O out of this task. Validate binding target syntax and strength compatibility only; structural export/schema/anchor resolution belongs to build-time governance. Sort without mutating callers. Do not add classes, mutable registration, clocks, environment access, or generic code-standard types.

- [ ] **Step 4: Run focused tests and shared type-check**

```bash
npx vitest run packages/tests/shared/rallar-ontology-registry.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
```

Expected: both exit 0.

- [ ] **Step 5: Commit the isolated foundation on its own branch**

```bash
git add packages/shared/ontology packages/tests/shared/rallar-ontology-registry.test.ts
git commit -m "feat: add Rallar ontology vocabulary and binding contracts"
```

**Acceptance criteria:** Semantic terms contain no code paths; binding strength is explicit; in-memory lookup uses `getXxx`; each module validates without unrelated ontology modules; no runtime/checker entry point changes.

**Rollback point:** Revert `feat: add Rallar ontology vocabulary and binding contracts`; no existing consumer can be affected.

---

### Task 2: Catalog the pilot domain identity and projection terms

**Purpose:** Make GroupRef scope, Group authority, Room projection, and client identity lifecycle explicit without copying domain shapes.

**Prerequisites:** Published Task 1 foundation. Execute on independent branch `codex/rallar-domain-ontology-pilot`.

**Files:**

- Create: `packages/shared/ontology/rallar-domain-ontology.ts`
- Create: `packages/shared/ontology/rallar-domain-ontology-bindings.ts`
- Modify: `packages/shared/ontology/mod.ts`
- Create: `packages/tests/shared/rallar-domain-ontology.test.ts`

**Production symbols:**

- `RALLAR_DOMAIN_ONTOLOGY_ID`, `RALLAR_DOMAIN_ONTOLOGY_VERSION`, `RALLAR_DOMAIN_ONTOLOGY_VERSION_IRI`
- `RALLAR_DOMAIN_TERM_IDS`
- `RALLAR_DOMAIN_BINDING_SET_ID`, `RALLAR_DOMAIN_BINDING_VERSION`, `RALLAR_DOMAIN_BINDING_VERSION_IRI`, `RALLAR_DOMAIN_BINDING_IDS`
- `rallarDomainOntology`, `rallarDomainOntologyBindings`

**Interfaces:**

- Consumes: `RallarOntologyVocabularyModule<RallarDomainOntologyTerm>` and `RallarOntologyBindingModule`.
- Produces the eight pilot terms from section 3.4 and separate contractual bindings sufficient to answer `CQ-DOM-001` and `CQ-DOM-002`.

**Behavioral change:** Adds semantic records only.

**Compatibility effect:** No contract, OpenAPI, persistence, route, or Room translation changes.

- [ ] **Step 1: Write RED semantic tests**

Assert:

```ts
expect(groupRef.identityFields).toEqual(['applicationId', 'workspaceId', 'groupId']);
expect(room.authority).toBe('projection');
expect(room.references).toContainEqual({
  relationId: RALLAR_RELATION_IDS.projects,
  targetTermId: RALLAR_DOMAIN_TERM_IDS.group,
});
expect(session.references).toEqual(
  expect.arrayContaining([
    {
      relationId: RALLAR_RELATION_IDS.sessionOf,
      targetTermId: RALLAR_DOMAIN_TERM_IDS.principal,
    },
    {
      relationId: RALLAR_RELATION_IDS.runsOn,
      targetTermId: RALLAR_DOMAIN_TERM_IDS.clientInstance,
    },
  ]),
);
```

Require vocabulary and binding versions `0.1.0`, matching series/version IRIs, the binding set's exact domain vocabulary version, experimental maturity, no required vocabulary imports, draft terms, no repository paths in serialized terms, contractual GroupRef/OpenAPI bindings, and contractual Room boundary bindings. Compose the vocabulary without its bindings and prove semantic validation remains valid.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run packages/tests/shared/rallar-domain-ontology.test.ts
```

Expected: FAIL because the domain module does not exist.

- [ ] **Step 3: Implement the pilot domain module**

Use `as const satisfies RallarOntologyVocabularyModule<RallarDomainOntologyTerm>` for terms and a separate binding module for:

- `GroupScope`, `GroupRef`, `Group` in `packages/shared/api/group-types.ts`;
- `ClientScope`, `ClientPrincipal`, `ClientInstance`, `ClientSession` in `packages/shared/api/client-types.ts`;
- matching OpenAPI component anchors;
- `RallarRoomSummary`, `RallarRoomState`, `toRallarRoomSummary`, and `toRallarRoomState` for Room.

Do not list all fields of Group, Room, Principal, ClientInstance, or Session. Only GroupRef identity fields are explicit because `CQ-DOM-001` requires composite identity. Stable exports and OpenAPI components are contractual; do not add implementation pointers beyond the named Room translation boundary.

- [ ] **Step 4: Run focused domain and validation tests**

```bash
npx vitest run \
  packages/tests/shared/rallar-domain-ontology.test.ts \
  packages/tests/shared/rallar-validation.test.ts \
  packages/tests/shared/authoritative-state-validation.test.ts \
  packages/tests/shared-web/rooms/room-group-state-translation.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
```

Expected: all exit 0 with existing domain behavior unchanged.

- [ ] **Step 5: Commit the domain pilot**

```bash
git add packages/shared/ontology/rallar-domain-ontology.ts \
  packages/shared/ontology/rallar-domain-ontology-bindings.ts \
  packages/shared/ontology/mod.ts \
  packages/tests/shared/rallar-domain-ontology.test.ts
git commit -m "feat: catalog core Rallar domain semantics"
```

**Acceptance criteria:** `CQ-DOM-001` and `CQ-DOM-002` are answerable; GroupRef is composite and authoritative; Room is a projection; terms remain valid without code bindings; only documented stable contracts receive contractual bindings.

**Rollback point:** Revert `feat: catalog core Rallar domain semantics`; Task 1 remains independently useful.

---

### Task 3: Catalog one cross-transport message and prove validator selection

**Purpose:** Demonstrate that ontology metadata can select an existing payload validator without changing receive paths.

**Prerequisites:** Published Tasks 1-2. Execute on independent branch `codex/rallar-realtime-ontology-pilot`.

**Files:**

- Create: `packages/shared/ontology/rallar-realtime-ontology.ts`
- Create: `packages/shared/ontology/rallar-realtime-ontology-bindings.ts`
- Create: `packages/shared/ontology/rallar-payload-validator-registry.ts`
- Modify: `packages/shared/ontology/mod.ts`
- Create: `packages/tests/shared/rallar-realtime-ontology.test.ts`

**Production symbols:**

- `RALLAR_REALTIME_ONTOLOGY_ID`, `RALLAR_REALTIME_ONTOLOGY_VERSION`, `RALLAR_REALTIME_ONTOLOGY_VERSION_IRI`
- `RALLAR_REALTIME_TERM_IDS`, `RALLAR_REALTIME_BINDING_SET_ID`, `RALLAR_REALTIME_BINDING_VERSION`, `RALLAR_REALTIME_BINDING_VERSION_IRI`, `RALLAR_REALTIME_BINDING_IDS`
- `rallarRealtimeOntology`, `rallarRealtimeOntologyBindings`
- `rallarCrdtUpdateMessageBindingProfile`
- `RallarRealtimeOntologyIssue`, `validateRallarRealtimeOntologyVocabulary`, `validateRallarRealtimeOntologyBindings`
- `RallarPayloadValidator`, `RallarPayloadValidatorBinding`
- `createRallarPayloadValidatorRegistry`, `getRallarPayloadValidatorForMessage`
- `rallarCorePayloadValidatorBindings`

**Interfaces:**

```ts
export interface RallarRealtimeOntologyIssue {
  readonly code:
    | 'duplicate-route-id'
    | 'duplicate-wire-type-id'
    | 'duplicate-topic-wire-route'
    | 'missing-route-profile'
    | 'missing-route-authorization-owner'
    | 'validation-kind-mismatch'
    | 'invalid-validation-profile';
  readonly path: string;
  readonly message: string;
}

export type RallarPayloadValidator = (
  value: unknown,
) => Readonly<{ valid: boolean; issues: readonly unknown[] }>;

export interface RallarPayloadValidatorBinding {
  readonly bindingId: RallarOntologyBindingId;
  readonly validate: RallarPayloadValidator;
}

export function createRallarPayloadValidatorRegistry(
  bindings: readonly RallarPayloadValidatorBinding[],
): ReadonlyMap<RallarOntologyBindingId, RallarPayloadValidator>;

export function getRallarPayloadValidatorForMessage(
  messageTerm: RallarMessageOntologyTerm,
  bindingProfile: RallarMessageOntologyBindingProfile,
  registry: ReadonlyMap<RallarOntologyBindingId, RallarPayloadValidator>,
): RallarPayloadValidator | undefined;
```

`getRallarPayloadValidatorForMessage` first requires matching term/profile IDs and validation kinds, then returns a function only for `runtime-payload`; envelope-only and unvalidated terms return `undefined`. The CRDT contractual binding adapts `validateRallarCrdtUpdateEnvelope` without changing it. The semantic term remains valid and inspectable when the binding profile/registry is absent.

`validateRallarRealtimeOntologyVocabulary` never requires a binding module. `validateRallarRealtimeOntologyBindings` is called only when a realtime binding module is selected; within that selected module, every message/lane term it claims to annotate must have a complete matching profile.

**Behavioral change:** Adds an opt-in lookup API. Existing AL/CRDT send and receive paths do not call it.

**Compatibility effect:** No change to CRDT constants, payloads, topics, accepted schemas, authorization, or error timing.

- [ ] **Step 1: Write RED message and validator tests**

Require the realtime vocabulary to declare the exact domain `0.1.0` version IRI because it references GroupRef; reject a selected realtime catalog that omits that dependency. Assert the message record imports exact existing constants, contains the room/app route matrix from section 3.5, references GroupRef, identifies `$.schemaVersion` as the semantic schema-version carrier, and declares `runtime-payload` validation without any binding ID. Assert a separate matching binding profile whose binding set names the exact realtime vocabulary version and whose contractual wire/type and route/topic targets name the exact existing module exports; the term values equal the constants imported by the test, while Task 6 later proves structural resolution. Also require bindings for the OpenAPI component, version-bearing contract, existing CRDT validator, and route/transport-level owners that do not require the private `authorizeAcceptedEnvelope` symbol.

Add an unvalidated fixture term with mechanism/reason and prove that its separate profile requires a boundary binding and gap owner but no schema or validator. Prove the term is semantically valid without that profile. Assert one semantic owner per imported `wireTypeId`; a single term may declare multiple topic routes, but duplicate `(topicId, wireTypeId)` route ownership is rejected because Rallar selectors match those fields and not scope.

Pass one valid fixture from `packages/tests/shared/crdt-contracts.test.ts` and one missing-required-field value through the selected validator. Expect the same validity result as `validateRallarCrdtUpdateEnvelope`.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run packages/tests/shared/rallar-realtime-ontology.test.ts
```

Expected: FAIL because realtime ontology and validator registry modules do not exist.

- [ ] **Step 3: Implement the message record and validator registry**

Import `RALLAR_CRDT_UPDATE_TYPE_ID`, `RALLAR_CRDT_ROOM_TOPIC_ID`, and `RALLAR_CRDT_APP_TOPIC_ID`; do not write their literal values in ontology data. Keep the validator registry an explicitly constructed immutable map keyed by contractual binding ID. Reject duplicate binding IDs at construction. Validate consistency between each term and its separate binding profile beside the realtime contracts; do not put message-specific ownership rules in the generic catalog.

- [ ] **Step 4: Run focused ontology and existing CRDT protocol suites**

```bash
npx vitest run \
  packages/tests/shared/rallar-realtime-ontology.test.ts \
  packages/tests/shared/crdt-contracts.test.ts \
  packages/tests/shared-web/rallar-crdt.test.ts \
  packages/tests/shared-server/rallar-crdt-server-topic.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
```

Expected: all exit 0; existing CRDT tests require no behavior changes.

- [ ] **Step 5: Commit the protocol pilot**

```bash
git add packages/shared/ontology packages/tests/shared/rallar-realtime-ontology.test.ts
git commit -m "feat: catalog Rallar CRDT message semantics"
```

**Acceptance criteria:** `CQ-RT-001`, `CQ-RT-002`, and `CQ-RT-004` are answerable; semantic terms contain no binding IDs; CRDT validator selection through the optional binding profile reproduces existing results; unvalidated messages need no fictional schema/validator; route ownership matches actual selector keys.

**Rollback point:** Revert `feat: catalog Rallar CRDT message semantics`; domain ontology stays adoptable.

---

### Task 4: Add the browser-owned direct realtime lane extension

**Purpose:** Prove non-AL lane semantics can be described by an owning package without centralizing or altering lane configuration.

**Prerequisites:** Completed Task 3 on `codex/rallar-realtime-ontology-pilot`; implement this as the next commit on that branch. If Task 3 was already published alone, branch from the default branch containing it.

**Files:**

- Create: `packages/shared-web/browser/rallar-browser-realtime-ontology.ts`
- Create: `packages/shared-web/browser/rallar-browser-realtime-ontology-bindings.ts`
- Create: `packages/tests/shared-web/rallar-browser-realtime-ontology.test.ts`

**Production symbols:**

- `RALLAR_BROWSER_REALTIME_ONTOLOGY_ID`
- `RALLAR_BROWSER_REALTIME_ONTOLOGY_VERSION`, `RALLAR_BROWSER_REALTIME_ONTOLOGY_VERSION_IRI`
- `RALLAR_BROWSER_REALTIME_TERM_IDS`
- `RALLAR_BROWSER_REALTIME_BINDING_SET_ID`, `RALLAR_BROWSER_REALTIME_BINDING_VERSION`, `RALLAR_BROWSER_REALTIME_BINDING_VERSION_IRI`, `RALLAR_BROWSER_REALTIME_BINDING_IDS`
- `rallarBrowserRealtimeOntology`, `rallarBrowserRealtimeOntologyBindings`

**Interfaces:**

- Consumes: `DEFAULT_REALTIME_DATA_CHANNEL_LANE` and shared ontology contracts.
- Produces: one vocabulary extension and binding module containing the direct `realtime` RTC lane term from section 3.5.

**Behavioral change:** Metadata only; the facade/composer does not import this file.

**Compatibility effect:** No lane ID/config, packet, readiness, listener, or bundle-entry change.

- [ ] **Step 1: Write RED lane and isolation tests**

Assert:

```ts
expect(lane.laneId).toBe(DEFAULT_REALTIME_DATA_CHANNEL_LANE.id);
expect(lane.envelope).toBe('none');
expect(lane.roomScopeCarrier).toBe('payload-room-ref-or-unique-lane');
expect(lane.payloadKinds).toEqual(['json', 'binary']);
```

Require the browser vocabulary extension to declare exact domain/realtime pilot vocabulary dependencies. Require a separate lane binding profile whose binding set names the exact browser vocabulary version, with a contractual lane-config binding and an informational controller binding. Prove the vocabulary extension remains valid without the profile when its declared vocabulary dependencies are present. Read the existing browser entrypoint sources and assert they import neither ontology file.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run packages/tests/shared-web/rallar-browser-realtime-ontology.test.ts
```

Expected: FAIL because the extension module does not exist.

- [ ] **Step 3: Implement the extension record**

Use the existing config object's ID and contractual binding. Do not repeat `ordered`, `maxRetransmits`, watermarks, overflow, or queue size in vocabulary data; the Markdown report may render current values from the binding target. Bind `createRallarRealtimeController` as `implementation`, so a rename produces a drift warning rather than CI failure.

- [ ] **Step 4: Run direct realtime and bundle-boundary tests**

```bash
npx vitest run \
  packages/tests/shared-web/rallar-browser-realtime-ontology.test.ts \
  packages/tests/shared-web/rooms/rallar-room-realtime-channel.test.ts \
  packages/tests/shared-web/shared-web-browser-entrypoints.test.ts \
  packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
```

Expected: all exit 0; bundle output does not include the ontology extension through existing entries.

- [ ] **Step 5: Commit the lane extension**

```bash
git add packages/shared-web/browser/rallar-browser-realtime-ontology.ts \
  packages/shared-web/browser/rallar-browser-realtime-ontology-bindings.ts \
  packages/tests/shared-web/rallar-browser-realtime-ontology.test.ts
git commit -m "feat: describe browser realtime lane semantics"
```

**Acceptance criteria:** `CQ-RT-003` is answerable; the term follows the actual lane ID, explicitly distinguishes direct traffic from AL, treats controller navigation as informational, and leaves existing browser entry points isolated.

**Rollback point:** Revert `feat: describe browser realtime lane semantics`; shared domain/protocol modules remain valid independently.

---

### Task 5: Catalog checker-owned code rules without reversing dependency

**Purpose:** Link normative Markdown, checker implementations, enforcement gates, evidence, exceptions, and ownership while ensuring the checker remains fully functional without ontology files or generated artifacts.

**Prerequisites:** Published Task 1 foundation. Execute independently on `codex/rallar-code-standards-ontology`.

**Files:**

- Create: `scripts/repo-style-check/repo-style-rule-ids.mjs`
- Modify: `scripts/repo-style-check/construction-rules.mjs`
- Modify: `scripts/repo-style-check/repository-scan.mjs`
- Modify: `scripts/check-changed-repo-style.mjs`
- Create: `scripts/ontology/repository-code-standard-contracts.ts`
- Create: `scripts/ontology/repository-code-standards-ontology.ts`
- Modify: `packages/tests/repo/repo-code-style-checker-integrity.test.ts`
- Modify: `packages/tests/repo/repo-style-check.test.ts`
- Modify: `packages/tests/repo/repo-style-construction-check.test.ts`
- Create: `packages/tests/repo/repository-code-standards-ontology.test.ts`

**Production symbols:**

- checker-owned `repoStyleRuleIds`
- `RepositoryCodeStandardOntologyTerm`
- `RALLAR_CODE_STANDARDS_ONTOLOGY_ID`, `RALLAR_CODE_STANDARDS_ONTOLOGY_VERSION`, `RALLAR_CODE_STANDARDS_ONTOLOGY_VERSION_IRI`
- `RALLAR_CODE_STANDARD_TERM_IDS`, `REPOSITORY_CODE_STANDARD_BINDING_SET_ID`, `REPOSITORY_CODE_STANDARD_BINDING_VERSION`, `REPOSITORY_CODE_STANDARD_BINDING_VERSION_IRI`, `REPOSITORY_CODE_STANDARD_BINDING_IDS`
- `repositoryCodeStandardsOntology`, `repositoryCodeStandardsOntologyBindings`

**Interfaces:**

```js
export const repoStyleRuleIds = Object.freeze({
  constructionForwardCapture: 'construction.forward-capture',
  contractOptionalCommand: 'contract.optional-command',
  fileLength: 'file.length',
});
```

`construction-rules.mjs`, `repository-scan.mjs`, and `check-changed-repo-style.mjs` import this checker-owned module. The ontology imports the same module and binds its exported properties. No checker import path may reach `scripts/ontology`, `docs/rallar-ontology*`, or an ontology generator.

**Behavioral change:** The three existing literals move to a checker-owned module; checker messages, severity, defaults, magnitudes, and exit behavior remain byte-for-byte equivalent. Ontology data is a downstream catalog only.

**Compatibility effect:** Preserves all CLI rule IDs and existing `constructionRuleIds` exports. Deleting or failing ontology generation cannot affect checker execution.

- [ ] **Step 1: Write RED ownership and traceability tests**

Require exactly the three thin ontology records, no required vocabulary imports, and a binding set naming the exact code-standards vocabulary version. Require separate bindings to imported checker-owned IDs, normative anchors, stable package-script gates, checker owners, example review/test evidence, applicable exception-policy anchors, and removal conditions. Assert that no term copies severity, thresholds, applicability mechanics, checker messages, or exception-field requirements. Assert the checker dependency graph contains `repo-style-rule-ids.mjs` but no ontology or generated-document path.

Lock this initial traceability map in the RED test:

| Checker-owned ID               | Normative anchor                                                                                           | Primary owner/evidence                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `construction.forward-capture` | `.agents/skills/rallar-code-writing/references/repo-code-style.md#construction-dependencies-and-callbacks` | `scripts/repo-style-check/construction-rules.mjs`; `packages/tests/repo/repo-style-construction-check.test.ts` |
| `file.length`                  | `.agents/skills/rallar-code-writing/references/repo-code-style.md#file-size-and-complexity`                | `scripts/repo-style-check/repository-scan.mjs`; `packages/tests/repo/repo-style-check.test.ts`                 |
| `contract.optional-command`    | `.agents/skills/rallar-code-writing/references/repo-code-style.md#required-fields-and-boundary-defaults`   | `scripts/repo-style-check/repository-scan.mjs`; `packages/tests/repo/repo-style-check.test.ts`                 |

All three bind to the stable root scripts `check:repo-style` and `check:repo-style:changed`. Human review/exception traceability binds to `docs/repo-human-style-guide.md#review-outcome`; do not copy that section's disposition fields into ontology records.

Add a behavioral fixture that exercises all three findings and snapshots their IDs/messages before moving literals. This semantic output test is primary; the import-graph assertion is supplementary and records owner `https://github.com/intact-software-systems/ar-eye-hunter/ontology/owner/repo-style-check` with removal condition “retain while ontology tooling exists.”

- [ ] **Step 2: Verify RED**

```bash
npx vitest run \
  packages/tests/repo/repository-code-standards-ontology.test.ts \
  packages/tests/repo/repo-code-style-checker-integrity.test.ts
```

Expected: FAIL because the checker-owned ID module and ontology records do not exist.

- [ ] **Step 3: Create the checker-owned ID module and preserve checker behavior**

Move only the three literals into `repo-style-rule-ids.mjs`, update existing checker imports, and retain every existing public export/message. Do not add a generated-file header: this is human-authored checker source.

- [ ] **Step 4: Implement the downstream code-standard vocabulary and bindings**

Import `repoStyleRuleIds` only in the binding module. Use a contractual `export-property`/`identifier` binding for the checker ID, plus contractual normative-anchor and stable package-script bindings. Use an `owner`/`enforcement-owner` binding for the checker capability and example bindings for movable evidence. Individual internal checker functions may be informational bindings but cannot gate CI.

- [ ] **Step 5: Prove checker independence and equivalence**

```bash
npx vitest run \
  packages/tests/repo/repository-code-standards-ontology.test.ts \
  packages/tests/repo/repo-code-style-checker-integrity.test.ts \
  packages/tests/repo/repo-style-check.test.ts \
  packages/tests/repo/repo-style-changed-check.test.ts \
  packages/tests/repo/repo-style-construction-check.test.ts \
  packages/tests/repo/repo-style-construction-edge-cases.test.ts
npm run check:repo-style -- --root scripts/ontology
```

Expected: tests exit 0; checker output is unchanged; its import graph is ontology-free.

- [ ] **Step 6: Commit the independent standards pilot**

```bash
git add scripts/repo-style-check/repo-style-rule-ids.mjs \
  scripts/repo-style-check/construction-rules.mjs \
  scripts/repo-style-check/repository-scan.mjs \
  scripts/check-changed-repo-style.mjs \
  scripts/ontology/repository-code-standard-contracts.ts \
  scripts/ontology/repository-code-standards-ontology.ts \
  packages/tests/repo/repository-code-standards-ontology.test.ts \
  packages/tests/repo/repo-code-style-checker-integrity.test.ts \
  packages/tests/repo/repo-style-check.test.ts \
  packages/tests/repo/repo-style-construction-check.test.ts
git commit -m "feat: catalog checker-owned code standards"
```

**Acceptance criteria:** `CQ-STD-001` is answerable; checkers own and consume their IDs; ontology imports those IDs downstream; normative anchors resolve; checker behavior remains unchanged.

**Rollback point:** Revert `feat: catalog checker-owned code standards`; prior checker literals return with no ontology/runtime impact.

---

### Task 6: Generate deterministic JSON-LD and the human ontology report

**Purpose:** Provide linked-data interchange and a reviewable report from the same modules without a graph service.

**Prerequisites:** Published Tasks 1-5. Execute on `codex/rallar-ontology-artifacts` so the checked-in pilot artifacts include all selected pilot families; the generator API/tests must still support any subset independently.

**Files:**

- Create: `scripts/ontology/rallar-ontology-binding-resolution.ts`
- Create: `scripts/ontology/rallar-ontology-competency-questions.ts`
- Create: `scripts/ontology/rallar-ontology-artifacts.ts`
- Create: `scripts/ontology/generate-rallar-ontology.ts`
- Create: `docs/rallar-ontology.jsonld`
- Create: `docs/rallar-ontology-reference.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `packages/tests/repo/rallar-ontology-artifacts.test.ts`

**Production symbols:**

- `RallarOntologyArtifacts`
- `RallarOntologyBindingResolution`, `resolveRallarOntologyBindings`
- `RallarOntologyCompetencyQuestion`, `RallarOntologyCompetencyAnswer`, `answerRallarOntologyCompetencyQuestions`
- `toRallarOntologyJsonLd`, `toRallarOntologyMarkdown`, `toRallarOntologyArtifacts`
- CLI `main(args)` in `generate-rallar-ontology.ts`

**Interfaces:**

```ts
export interface RallarOntologyArtifacts {
  readonly jsonLd: string;
  readonly markdown: string;
}

export interface RallarOntologyCompetencyQuestion {
  readonly questionId: RallarOntologyCompetencyQuestionId;
  readonly phase: 'pilot' | 'expansion-candidate';
  readonly question: string;
  readonly minimumEvidence: string;
}

export interface RallarOntologyBindingResolution {
  readonly bindingId: RallarOntologyBindingId;
  readonly status: 'resolved' | 'warning' | 'error';
  readonly resolvedValue?: string;
  readonly message: string;
}

export interface RallarOntologyCompetencyAnswer {
  readonly questionId: RallarOntologyCompetencyQuestionId;
  readonly status: 'answered' | 'unanswered' | 'not-selected' | 'proposed-for-expansion';
  readonly evidenceTermIds: readonly RallarOntologyTermId[];
  readonly evidenceBindingIds: readonly RallarOntologyBindingId[];
  readonly explanation: string;
}

export interface RallarOntologyArtifactInput {
  readonly catalog: RallarOntologyCatalog;
  readonly bindingResolutions: readonly RallarOntologyBindingResolution[];
  readonly competencyAnswers: readonly RallarOntologyCompetencyAnswer[];
}

export function toRallarOntologyArtifacts(
  input: RallarOntologyArtifactInput,
): RallarOntologyArtifacts;

export function answerRallarOntologyCompetencyQuestions(
  catalog: RallarOntologyCatalog,
  questions: readonly RallarOntologyCompetencyQuestion[],
): readonly RallarOntologyCompetencyAnswer[];

export function resolveRallarOntologyBindings(
  catalog: RallarOntologyCatalog,
  repositoryRoot: string,
): Promise<readonly RallarOntologyBindingResolution[]>;
```

`resolveRallarOntologyBindings` is the build-time stateful shell: it receives the repository root and catalog, imports/parses declared contractual targets, checks owner paths, and returns ordered resolution records. `toRallarOntologyJsonLd`, `toRallarOntologyMarkdown`, and `toRallarOntologyArtifacts` are pure functions over explicit input and perform no filesystem or module loading.

`answerRallarOntologyCompetencyQuestions` is also pure. It evaluates the stable question catalog from section 2.4 against selected term, relation, and binding IDs. It never infers an answer from source text. An applicable accepted question with missing evidence returns `unanswered` and fails the pilot/governance test; an unselected ontology family or unapproved expansion question is reported without failing an independent slice.

Add scripts:

```json
"ontology:generate": "tsx scripts/ontology/generate-rallar-ontology.ts",
"ontology:check": "tsx scripts/ontology/generate-rallar-ontology.ts --check"
```

**Behavioral change:** Adds developer tooling and checked-in documentation only.

**Compatibility effect:** No network/package API change. Generated output is deterministic and timestamp-free.

- [ ] **Step 1: Write RED artifact and CLI tests**

Tests must prove:

- identical input gives identical exact bytes;
- module/term/relation/binding/profile ordering is stable;
- the JSON-LD context contains `@version: 1.1`, `skos`, `dcterms`, the controlled Rallar vocabulary IRI, IRI coercion for owner/relation/version/dependency links/`compatibleWith`, and explicit English language mappings for labels/definitions without applying a global language to IDs/status/version strings;
- a build-time JSON-LD processor expands the artifact to the expected full term/relation/version IRIs with a document loader that throws on every remote request;
- JSON-LD contains vocabulary terms only: each ontology is a `skos:ConceptScheme`, each term is a `skos:Concept` in that scheme, and each version IRI is a resource linked with `dcterms:hasVersion`/`dcterms:isVersionOf` plus its version identifier; labels, definitions, status, maturity, and controlled relations expand to expected IRIs; it contains no binding IDs, repository paths, or symbols;
- Markdown contains each selected ontology summary, answers for every applicable accepted competency question, `not-selected`/`proposed-for-expansion` status for the others, binding strengths, contractual resolution results, and implementation/example drift warnings; the assembled pilot answers all eight pilot questions;
- contractual TypeScript exports, export properties, wire constants, runtime validators, OpenAPI components, normative anchors, and package-script gates resolve structurally rather than by substring search;
- resolved realtime wire/type, route/topic, and lane-ID values equal their semantic term values; a mismatch is an error even when both targets exist;
- owner bindings require an existing owner path; missing implementation/example targets produce warnings, not failure;
- absolute/traversing paths, URL/package targets, unsafe property segments, and a symlink resolving outside a temporary repository root are rejected before import/read;
- `--check` exits nonzero and names stale paths without overwriting;
- write mode updates only the two declared generated files;
- generating domain-only or standards-only input succeeds independently; realtime generation succeeds with its declared domain dependency and does not require code standards; a deliberately missing declared dependency fails with its exact version IRI.

Use a temporary directory for CLI file behavior.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run packages/tests/repo/rallar-ontology-artifacts.test.ts
```

Expected: FAIL because the renderer/CLI/output files are incomplete.

- [ ] **Step 3: Implement pure rendering and narrow file I/O**

Install `jsonld` and its TypeScript declarations as build/test-only dependencies:

```bash
npm install --save-dev jsonld @types/jsonld
```

Define the local context in source with `@version: 1.1`, `skos`, `dcterms`, `rallar`, `@vocab`, and explicit `@type: '@id'` mappings. Never load a remote context. Do not type the document as `owl:Ontology`, and do not add RDF storage, OWL reasoning, SHACL, SPARQL, or runtime imports.

Render only vocabulary data into JSON-LD. Render vocabulary plus binding-resolution evidence into Markdown. The Markdown starts with a generated-file notice and identifier-scope disclaimer, then lists versions/maturity, competency answers, domain relations, message validation truth, RTC lanes, code-rule traceability, contractual failures, and non-blocking drift warnings.

The CLI resolves output paths from the repository root, not the process's arbitrary current directory. It accepts only no flag or `--check`; unknown flags fail.

- [ ] **Step 4: Generate and verify checked-in artifacts**

```bash
npm run ontology:generate
npm run ontology:check
npx vitest run packages/tests/repo/rallar-ontology-artifacts.test.ts
git diff --check
```

Expected: all exit 0; a second generation produces no diff.

- [ ] **Step 5: Commit the generated-report pipeline**

```bash
git add scripts/ontology/rallar-ontology-artifacts.ts \
  scripts/ontology/rallar-ontology-binding-resolution.ts \
  scripts/ontology/rallar-ontology-competency-questions.ts \
  scripts/ontology/generate-rallar-ontology.ts \
  docs/rallar-ontology.jsonld \
  docs/rallar-ontology-reference.md \
  packages/tests/repo/rallar-ontology-artifacts.test.ts \
  package.json package-lock.json
git commit -m "feat: generate Rallar ontology reports"
```

**Acceptance criteria:** `ontology:check` is read-only and deterministic; JSON-LD expands correctly without network access and contains no repository binding metadata or runtime observations; contractual bindings resolve; informational drift cannot block; each selected ontology set generates with only its explicit vocabulary dependencies.

**Rollback point:** Revert `feat: generate Rallar ontology reports`; ontology and checker modules remain independently usable because neither consumes generated artifacts.

---

### Task 7: Document extension usage and pass the competency-driven pilot gate

**Purpose:** Make adoption understandable to app/game owners and prove the pilot is operationally inert.

**Prerequisites:** Published Tasks 1-6. Execute on `codex/rallar-ontology-pilot-docs` after the selected pilot modules and artifacts are visible together on the default branch.

**Files:**

- Create: `examples/ontology-registry/README.md`
- Modify: `docs/README.md`
- Modify: `packages/shared/architecture.md`
- Modify: `packages/shared-web/architecture.md`
- Modify: `docs/rallar-api-reference.md`
- Create: `packages/tests/repo/rallar-ontology-docs-integrity.test.ts`
- Modify: `package.json` (`test:repo-governance` inventory only)

**Production symbols:** None; documentation and governance tests only.

**Interfaces:** The example imports `@shared/ontology/mod.ts`, creates a catalog from selected vocabulary/binding modules, gets the CRDT message term, and shows separate app-owned vocabulary and binding extensions built with `satisfies`. It explicitly states that metadata registration does not register a runtime topic, validator, lane, authorization rule, or checker rule.

**Behavioral change:** Documentation only.

**Compatibility effect:** No runtime change.

- [ ] **Step 1: Write RED documentation-integrity tests**

Require the docs to state all of these concepts:

```text
TypeScript ontology modules are the source of semantic metadata.
JSON-LD and Markdown are generated projections.
Vocabulary is independent of repository code bindings.
Contractual bindings block drift; implementation/example bindings only warn.
GroupRef remains authoritative scoped identity.
Room is a projection of Group state.
Direct realtime is not AL-enveloped.
Ontology metadata does not authorize or validate by itself.
Existing checkers never depend on ontology source or generated artifacts.
No ontology metadata is added to packets.
Pilot ontologies are experimental 0.1.0 vocabularies, not stable public standards.
```

Require the example's extension to use `/ontology/extension/<owner>/<name>` for its series and an owner-prefixed suffix for every term/route/binding/profile ID, plus a unique version IRI, controlled relations, pure `createRallarOntologyCatalog`, explicit vocabulary dependencies, and a separate binding module. Show both a real runtime-payload validator binding and an honest `unvalidated` message boundary without a fictional schema/validator.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run packages/tests/repo/rallar-ontology-docs-integrity.test.ts
```

Expected: FAIL because the documentation is not present.

- [ ] **Step 3: Write docs and example**

Add a Docs index link to the generated report and JSON-LD. Add vocabulary/binding ownership to shared/shared-web architecture notes. Add a short API-reference section after WS/RTC messages explaining metadata lookup versus runtime routing/validation. Document all eight pilot competency questions, label `CQ-DOM-003`/`CQ-DOM-004` as proposed expansion questions, and record the human go/no-go separately for Tasks 8 and 9.

- [ ] **Step 4: Run the complete pilot gate**

```bash
npx vitest run \
  packages/tests/shared/rallar-ontology-registry.test.ts \
  packages/tests/shared/rallar-domain-ontology.test.ts \
  packages/tests/shared/rallar-realtime-ontology.test.ts \
  packages/tests/shared/crdt-contracts.test.ts \
  packages/tests/shared-web/rallar-crdt.test.ts \
  packages/tests/shared-web/rallar-message-channel-compat.test.ts \
  packages/tests/shared-web/rooms/rallar-room-realtime-channel.test.ts \
  packages/tests/shared-web/rallar-browser-realtime-ontology.test.ts \
  packages/tests/shared-server/rallar-crdt-server-topic.test.ts \
  packages/tests/repo/repository-code-standards-ontology.test.ts \
  packages/tests/repo/rallar-ontology-artifacts.test.ts \
  packages/tests/repo/rallar-ontology-docs-integrity.test.ts \
  packages/tests/repo/repo-code-style-checker-integrity.test.ts
npm run ontology:check
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
npm run test:repo-governance
git diff --check
```

Expected: every command exits 0. Review `git diff` and confirm no existing wire/runtime/authorization/schema file changed. Checker modules may change only to consume their own neutral ID module; their import graph must remain ontology-free.

- [ ] **Step 5: Commit the documented pilot milestone**

```bash
git add examples/ontology-registry/README.md \
  docs/README.md \
  packages/shared/architecture.md \
  packages/shared-web/architecture.md \
  docs/rallar-api-reference.md \
  packages/tests/repo/rallar-ontology-docs-integrity.test.ts \
  package.json
git commit -m "docs: explain Rallar ontology adoption"
```

**Acceptance criteria:** Pilot criteria 1-7 in section 8 pass; all competency answers are useful to a human reviewer; an app owner can add vocabulary/binding extensions without changing core registries; documentation does not imply runtime authority. Record the human decision to approve or defer Tasks 8-9 before continuing.

**Rollback point:** Revert `docs: explain Rallar ontology adoption` for docs only. If a pilot exit criterion fails, fix or revert only the owning independently published track; do not remove a passing domain, realtime, standards, or foundation slice merely because another slice failed.

---

### Task 8: Expand the domain ontology after the pilot gate

**Purpose:** Cover the remaining requested domain concepts while keeping feature ownership and files cohesive.

**Prerequisites:** Successful Task 7 criteria 1-7 and explicit human approval of domain expansion after reviewing competency answers and maintenance cost. Run on `codex/rallar-domain-ontology-expansion` independently from realtime expansion.

**Files:**

- Create: `packages/shared/ontology/rallar-domain-state-ontology.ts`
- Create: `packages/shared/ontology/rallar-domain-collaboration-ontology.ts`
- Create: `packages/shared/ontology/rallar-domain-ai-ontology.ts`
- Modify: `packages/shared/ontology/rallar-domain-ontology.ts`
- Modify: `packages/shared/ontology/rallar-domain-ontology-bindings.ts`
- Modify: `packages/shared/ontology/mod.ts`
- Modify: `packages/tests/shared/rallar-domain-ontology.test.ts`
- Modify: `packages/tests/repo/rallar-ontology-artifacts.test.ts`
- Regenerate: `docs/rallar-ontology.jsonld`
- Regenerate: `docs/rallar-ontology-reference.md`

**Production symbols:**

- `rallarDomainStateOntologyTerms`
- `rallarDomainCollaborationOntologyTerms`
- `rallarDomainAiOntologyTerms`
- additions to `RALLAR_DOMAIN_TERM_IDS`: membership, groupPresenceSession, groupPresenceSummary, clientPresence, groupSnapshot, clientSnapshot, groupEvent, clientEvent, topology, crdtDocument, crdtSnapshot, aiResult, aiProposal.

**Interfaces:** `rallarDomainOntology` and `rallarDomainOntologyBindings` remain one independently versioned vocabulary/binding pair. The vocabulary composes the three term slices; the companion binding module appends their graded bindings. Subfiles are ownership slices, not separately versioned ontologies.

**Behavioral change:** Metadata/report expansion only.

**Compatibility effect:** Additive experimental vocabulary/binding minor version `0.2.0`; no domain runtime or serialized shape changes.

- [ ] **Step 1: Write RED coverage and relationship tests**

Require these semantic relationships and graded bindings, each justified by the human-approved `CQ-DOM-003` or `CQ-DOM-004`:

- Membership relates Principal to Group and carries role/status, without becoming identity authority.
- Presence relates Session to Group membership and is liveness materialization, not identity authority.
- Group/Client snapshots are authoritative complete observations; Room remains their browser projection.
- Events describe changes and carry causal/revision context where the existing contract does.
- Topology is derived for one GroupRef and one causal group-state revision.
- CRDT document identity uses `RallarCrdtDocumentRef`; snapshot/update terms remain collaborative data, not competitive game authority.
- AI result with lifecycle `proposed` is proposal data; accepted/rejected lifecycle is linked to a domain acceptance decision and never grants authority by itself.
- AI result schema identity/version links to the existing RallarAI schema registry; ontology version compatibility does not imply AI payload-schema compatibility.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run packages/tests/shared/rallar-domain-ontology.test.ts
```

Expected: FAIL because the expanded terms do not exist, version remains `0.1.0`, and no `0.2.0` module explicitly declares compatibility with the domain `0.1.0` version IRI.

- [ ] **Step 3: Add state, collaboration, and AI term slices**

Create contractual bindings for stable exported contracts and owner bindings for capabilities whose private implementation may move:

- `packages/shared/api/group-types.ts`: `GroupMember`, `GroupPresenceSession`, `GroupPresenceSummary`, `GroupSnapshot`, `GroupEvent`;
- `packages/shared/api/client-types.ts`: `ClientPresenceSnapshot`, `ClientSnapshot`, `ClientEvent`;
- `packages/shared/api/overlay-topology.ts`: `RallarOverlayTopologySnapshot`;
- `packages/shared/crdt/crdt-types.ts`: `RallarCrdtDocumentRef`, `RallarCrdtSnapshotEnvelope`;
- `packages/shared/rallar-ai/rallar-ai-types.ts`: `RallarAiJsonResult`, `RallarAiResultLifecycleState`;
- `packages/shared/rallar-ai/rallar-ai-proposals.ts`: accepted-result capability owner; individual helper symbols are informational only.
- `packages/shared/rallar-ai/rallar-ai-schema-registry.ts`: `RallarAiSchemaRegistry`, `toRallarAiSchemaKey`.

Set domain vocabulary/binding versions and version IRIs to `0.2.0`; each module explicitly lists its own `0.1.0` version IRI in `compatibleWith`, and the binding set names the exact domain `0.2.0` vocabulary version. Do not copy event payload unions, snapshot fields, CRDT schemas, or AI JSON schemas.

- [ ] **Step 4: Regenerate and run focused domain suites**

```bash
npm run ontology:generate
npm run ontology:check
npx vitest run \
  packages/tests/shared/rallar-domain-ontology.test.ts \
  packages/tests/shared/authoritative-state-validation.test.ts \
  packages/tests/shared/authoritative-group-causal-invariants.test.ts \
  packages/tests/shared/crdt-contracts.test.ts \
  packages/tests/shared/rallar-ai-contracts.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
```

Expected: all exit 0.

- [ ] **Step 5: Commit the domain expansion**

```bash
git add packages/shared/ontology \
  packages/tests/shared/rallar-domain-ontology.test.ts \
  packages/tests/repo/rallar-ontology-artifacts.test.ts \
  docs/rallar-ontology.jsonld \
  docs/rallar-ontology-reference.md
git commit -m "feat: expand Rallar domain ontology"
```

**Acceptance criteria:** `CQ-DOM-003` and `CQ-DOM-004` were explicitly accepted and are answerable; every approved expansion concept has a draft term, correct authority category, resolved relations, and no more binding detail than those questions require; contractual exports resolve; informational pointers cannot block; domain vocabulary/binding versions and version IRIs are `0.2.0`.

**Rollback point:** Revert `feat: expand Rallar domain ontology`; the `0.1.0` pilot remains valid.

---

### Task 9: Expand realtime concepts, signaling, fallback, and extension contracts

**Purpose:** Represent the complete requested protocol vocabulary and known validation coverage without enumerating every app message centrally.

**Prerequisites:** Successful Task 7 criteria 1-7 and explicit human approval of realtime expansion after reviewing competency answers and maintenance cost. Run on `codex/rallar-realtime-ontology-expansion` independently from Task 8.

**Files:**

- Create: `packages/shared/ontology/rallar-al-ontology.ts`
- Create: `packages/shared/ontology/rallar-al-ontology-bindings.ts`
- Create: `packages/shared/ontology/rallar-signaling-ontology.ts`
- Create: `packages/shared/ontology/rallar-signaling-ontology-bindings.ts`
- Modify: `packages/shared/ontology/rallar-realtime-ontology.ts`
- Modify: `packages/shared/ontology/rallar-realtime-ontology-bindings.ts`
- Modify: `packages/shared/ontology/mod.ts`
- Modify: `packages/tests/shared/rallar-realtime-ontology.test.ts`
- Create: `packages/tests/shared/rallar-realtime-ontology-protocol-traces.test.ts`
- Modify: `packages/tests/repo/rallar-ontology-artifacts.test.ts`
- Regenerate: `docs/rallar-ontology.jsonld`
- Regenerate: `docs/rallar-ontology-reference.md`

**Production symbols:**

- `rallarAlOntologyTerms`, `rallarAlOntologyBindings`
- `rallarSignalingOntologyTerms`, `rallarSignalingOntologyBindings`
- protocol term IDs for ALMessage v2, route, target, GroupRef target, transport, payload schema, schema version, sender kind, authorization owner, reliability, acknowledgement, ordering, deduplication, supersedence, QoS, correlation, RTC signaling, direct RTC, AL-over-RTC, AL-over-WS, and fallback.

**Interfaces:** App/game owners publish an ordinary `RallarOntologyVocabularyModule` under the controlled `/ontology/extension/<owner>/...` IRI space and a separate optional binding module using existing wire constants. The core catalog does not scan source text or mutate itself.

**Behavioral change:** Metadata/report expansion only.

**Compatibility effect:** Realtime vocabulary/binding minor version `0.2.0`; AL v2 and all runtime paths remain unchanged.

- [ ] **Step 1: Write RED protocol-concept and trace tests**

Require vocabulary terms and graded bindings for:

- `ALMessage`, `ALRoute`, `ALTargets`, `ALDelivery`, `ALOrdering`, `ALActions`, `ALQosPolicyRequest`;
- AL control IDs and payloads in `al-control.ts`;
- `ALInboundMessageRuntime` and `ALOutboundMessageRuntime` capability owners for dedup/order/supersedence/QoS effects, with private methods informational only;
- `validatePersistedALMessage` as envelope-only validation;
- `QRtcSignalingMessage` contract and signaling transport/server/connection capability owners; concrete private methods are informational only;
- direct RTC, AL RTC, AL WS, signaling over WS, and fallback exchange-pattern terms at capability-boundary detail only;
- `unvalidated` coverage with `generic-assertion` or `unknown-payload` mechanism for `decodeMessagePayload<T>` and signaling payloads, without schema/validator IDs;
- `domain-owned` correlation for fallback and an explicit note that attempts may have different AL IDs;
- sender kinds `client-session`, `peer-session`, `server-node`, and `system` rather than one overloaded meaning.

Add a synthetic app vocabulary/binding extension with one unique message type. Assert that its wire/type and route/topic profile bindings resolve to the vocabulary values, that each `wireTypeId` has one semantic owner term, that one term may contain multiple topic routes, and that duplicate `(topicId, wireTypeId)` routes are rejected independent of scope. This mirrors browser selector matching; scope remains route semantics, not an ownership-key escape hatch.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run \
  packages/tests/shared/rallar-realtime-ontology.test.ts \
  packages/tests/shared/rallar-realtime-ontology-protocol-traces.test.ts
```

Expected: FAIL because the concepts and trace metadata are absent and no realtime `0.2.0` module explicitly declares compatibility with the realtime `0.1.0` version IRI.

- [ ] **Step 3: Implement AL and signaling term slices**

Set realtime vocabulary/binding versions and version IRIs to `0.2.0`; each module explicitly lists its own `0.1.0` version IRI in `compatibleWith`, and the binding set names the exact realtime `0.2.0` vocabulary version. Import existing AL control constants. Bind stable contracts/constants contractually, capability folders/files as owners, and private runtime symbols only as informational navigation. Use the section 2.2 traces to choose stable exchange-pattern boundaries, but do not copy their helper-by-helper timelines into vocabulary or generated artifacts.

Validate that each semantic route has a transport, target mode, authorization disposition, and term-level sender/correlation semantics. Then validate each separate binding profile: wire/type and route/topic bindings equal the imported vocabulary values; every required route/transport pair has owner bindings; runtime payloads require schema/version/validator bindings; envelope-only terms require an envelope validator and gap owner; unvalidated terms require a boundary and gap owner while their vocabulary term supplies mechanism/reason.

- [ ] **Step 4: Regenerate and run protocol behavior suites**

```bash
npm run ontology:generate
npm run ontology:check
npx vitest run \
  packages/tests/shared/rallar-realtime-ontology.test.ts \
  packages/tests/shared/rallar-realtime-ontology-protocol-traces.test.ts \
  packages/tests/shared/al-message-validation.test.ts \
  packages/tests/shared/al-inbound-message-runtime.test.ts \
  packages/tests/shared/al-outbound-message-runtime.test.ts \
  packages/tests/shared/websocket-webrtc.test.ts \
  packages/tests/shared/webrtc-connection-service.test.ts \
  packages/tests/shared-web/rallar-message-channel-compat.test.ts \
  packages/tests/shared-web/rallar-message-send-compat.test.ts \
  packages/tests/shared-server/ws-server-inbound-identity.test.ts \
  packages/tests/shared-server/al-message-persistence-validation.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
```

Expected: all exit 0 with no runtime test changes required except ontology tests.

- [ ] **Step 5: Commit the realtime expansion**

```bash
git add packages/shared/ontology \
  packages/tests/shared/rallar-realtime-ontology.test.ts \
  packages/tests/shared/rallar-realtime-ontology-protocol-traces.test.ts \
  packages/tests/repo/rallar-ontology-artifacts.test.ts \
  docs/rallar-ontology.jsonld \
  docs/rallar-ontology-reference.md
git commit -m "feat: expand Rallar realtime ontology"
```

**Acceptance criteria:** Every human-approved protocol concept is represented at the level required by `CQ-RT-001` through `CQ-RT-004`; the five exchange patterns identify stable envelope, transport, validation, authority, fallback/correlation, and caller-visible result ownership without reproducing private timelines; realtime vocabulary/binding versions and version IRIs are `0.2.0`.

**Rollback point:** Revert `feat: expand Rallar realtime ontology`; the CRDT/direct-lane pilot remains valid.

---

### Task 10: Lock governance, rollout documentation, and local completion gates

**Purpose:** Make drift visible in normal repository validation and document versioning, extension, deprecation, and rollback operations.

**Prerequisites:** Published Task 7 plus the recorded human go/no-go. Execute on `codex/rallar-ontology-governance`. Include Tasks 8-9 only when approved and already published; governance must work for the pilot catalog without them.

**Files:**

- Modify: `packages/tests/repo/rallar-ontology-artifacts.test.ts`
- Modify: `packages/tests/repo/rallar-ontology-docs-integrity.test.ts`
- Modify: `package.json`
- Modify: `docs/README.md`
- Modify: `docs/rallar-ontology-reference.md` only through generation
- Modify: `examples/ontology-registry/README.md`

**Production symbols:** None beyond existing generator/test scripts.

**Interfaces:** `test:repo-governance` includes both ontology repository tests. `ontology:check` remains an explicit focused command and is also exercised by the artifact test, so `test:unit` catches stale generated files.

**Behavioral change:** CI/governance only. Stale artifacts, broken semantic references, and broken contractual bindings fail tests; informational drift remains warning-only.

**Compatibility effect:** No runtime change. This is an additive repository gate.

- [ ] **Step 1: Write RED governance tests**

Add assertions for the exact versioning/maturity rules in section 6, deprecation requirements, rollback instructions, identifier-scope disclaimer, absence of packet/runtime-authority claims, accepted competency questions, and every approved term in generated output.

Test contractual targets structurally: import TypeScript/MJS exports, parse OpenAPI components, and parse Markdown headings. Test owner paths for existence. Supply missing implementation/example fixtures and assert they appear as Markdown warnings while `ontology:check` still succeeds. Assert no checker import graph reaches ontology source or artifacts. Do not use exact source-text symbol matching as contract evidence.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run \
  packages/tests/repo/rallar-ontology-artifacts.test.ts \
  packages/tests/repo/rallar-ontology-docs-integrity.test.ts
```

Expected: FAIL until docs and full-catalog generated output are current.

- [ ] **Step 3: Complete documentation and governance inventory**

Add the two ontology tests to `test:repo-governance`. Document:

- how an owner adds a term using existing constants;
- how vocabulary differs from repository bindings;
- which binding strengths fail CI and which only warn;
- when to increment patch/minor/major versions;
- when an experimental `0.x` ontology may promote to stable `1.0.0`;
- how to add a validator binding without wiring it into runtime;
- how to record an envelope-only or unvalidated boundary without a fake validator;
- how to deprecate and supersede a term;
- how to regenerate/check artifacts;
- how to roll back ontology metadata independently from runtime behavior;
- that runtime auto-validation or wire changes require separate approval.

- [ ] **Step 4: Run focused governance and style checks**

```bash
npm run ontology:generate
npm run ontology:check
npm run test:repo-governance
npm run check:repo-style -- --root packages/shared/ontology
npm run check:repo-style -- --root packages/shared-web/browser
npm run check:repo-style -- --root scripts/ontology
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
git diff --check
```

Expected: all commands exit 0. For every construction-detail warning in changed production code, record path, rule, symbol, and disposition in the pull request. Warning-only output without a disposition is not acceptance.

- [ ] **Step 5: Commit the governance gate**

```bash
git add packages/tests/repo/rallar-ontology-artifacts.test.ts \
  packages/tests/repo/rallar-ontology-docs-integrity.test.ts \
  package.json \
  docs/README.md \
  docs/rallar-ontology-reference.md \
  examples/ontology-registry/README.md
git commit -m "test: enforce Rallar ontology integrity"
```

**Acceptance criteria:** Governance fails on stale artifacts, semantic-reference errors, duplicate semantic ownership, malformed validation unions, or broken contractual bindings. It does not fail on implementation/example drift. Checker independence and runtime/bundle isolation are proven.

**Rollback point:** Revert `test: enforce Rallar ontology integrity` to remove the new CI gate while retaining ontology data; do not delete generated outputs without also removing their documented use.

---

### Task 11: Run final gates, publish, and record remote evidence

**Purpose:** Complete the AGENTS.md validation and publication contract independently for each foundation/domain/realtime/standards/governance branch, then record the umbrella outcome.

**Prerequisites:** The tasks owned by the current track, a clean scoped diff, and no change after final gates. The umbrella plan closes only after Tasks 1-7 and 10 are published and Tasks 8-9 are either published or explicitly removed from scope by the human.

**Files:** Verification/publication only. Any required fix returns to its owning task and invalidates later evidence.

**Production symbols:** None.

**Interfaces:** Publication evidence only: final feature/default commit SHAs, local command results, remote workflow results, competency/scope decisions, and rollback notes are recorded in the current track PR and umbrella progress record.

**Behavioral change:** None.

**Compatibility effect:** None beyond publishing the current independently reviewed additive slice.

- [ ] **Step 1: Review exact scope and generated stability**

```bash
git status --short
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
npm run ontology:check
```

Expected: only planned files are present; artifacts are current; commands exit 0.

- [ ] **Step 2: Run mandatory final local gates on the unchanged tree**

```bash
npm run test:unit
npm run test:ci
npm run build
```

Expected: all exit 0. `test:ci` may repeat unit tests; both commands are required. Any edit after any successful gate invalidates all final-gate evidence and requires all three commands again.

- [ ] **Step 3: Publish the final feature-branch commit and draft PR**

Use the repository publication workflow. Push the current named track branch, open/update its draft PR, and include:

- plan link;
- pilot and expansion milestones;
- current ontology versions and term counts;
- competency questions answered by this slice;
- contractual binding results and non-blocking drift warnings;
- exact generated files;
- no-wire/no-runtime-authority/no-checker-dependency statement;
- exact passed, failed, and skipped commands;
- construction-warning dispositions;
- rollback sequence.

- [ ] **Step 4: Record remote gates by exact commit SHA**

Require **Branch Release Gate** to pass for the final feature-branch commit. After merge, require **Run Hetzner Supported Distributed Manifests** to pass for the resulting default-branch commit. Record both full SHAs and workflow results in the PR/plan progress record.

**Acceptance criteria:** For every published track, local gates pass on its final unchanged tree, its draft PR is current, and both required remote workflows are green for the exact required SHAs. The umbrella record lists every merged track, ontology/binding version, competency answer, explicit deferral/scope decision, and validated SHA. Until that evidence exists, report the relevant track and umbrella plan as incomplete.

**Rollback point:** Before merge, close the draft PR and delete only the feature branch. After merge, revert the ontology commits in reverse dependency order; runtime/wire behavior remains independently unchanged.

## 10. Validation Matrix

| Surface                          | Focused command                                                                                                                                                                                                                                 | Why                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Core catalog/domain pilot        | `npx vitest run packages/tests/shared/rallar-ontology-registry.test.ts packages/tests/shared/rallar-domain-ontology.test.ts`                                                                                                                    | Semantic IDs, version IRIs, relations, binding independence, and competency answers.       |
| Protocol/validator pilot         | `npx vitest run packages/tests/shared/rallar-realtime-ontology.test.ts packages/tests/shared/crdt-contracts.test.ts`                                                                                                                            | Honest validation classification and unchanged existing CRDT validator behavior.           |
| Direct RTC pilot                 | `npx vitest run packages/tests/shared-web/rallar-browser-realtime-ontology.test.ts packages/tests/shared-web/rooms/rallar-room-realtime-channel.test.ts`                                                                                        | Contractual lane identity, informational controller binding, and unchanged direct traffic. |
| AL RTC/WS/fallback               | `npx vitest run packages/tests/shared/al-inbound-message-runtime.test.ts packages/tests/shared/al-outbound-message-runtime.test.ts packages/tests/shared-web/rallar-message-channel-compat.test.ts`                                             | Conditional Task 9 coverage; existing delivery/control-flow families remain green.         |
| Signaling                        | `npx vitest run packages/tests/shared/websocket-webrtc.test.ts packages/tests/shared/webrtc-connection-service.test.ts`                                                                                                                         | Conditional Task 9 coverage; existing signaling-over-WS behavior remains green.            |
| Code standards                   | `npx vitest run packages/tests/repo/repository-code-standards-ontology.test.ts packages/tests/repo/repo-code-style-checker-integrity.test.ts packages/tests/repo/repo-style-check.test.ts packages/tests/repo/repo-style-changed-check.test.ts` | Checker-owned IDs, semantic traceability, dependency direction, and unchanged enforcement. |
| Artifact semantics               | `npm run ontology:check`                                                                                                                                                                                                                        | Deterministic outputs, offline JSON-LD expansion, and strength-aware binding resolution.   |
| Governance                       | `npm run test:repo-governance`                                                                                                                                                                                                                  | Docs, semantic references, competency answers, authority chain, and checker independence.  |
| Shared types                     | `npx tsc -p packages/shared/tsconfig.json --noEmit`                                                                                                                                                                                             | Cross-runtime contracts remain type-safe.                                                  |
| Browser types/bundle             | `npx tsc -p packages/shared-web/tsconfig.json --noEmit` and `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`                                                                                                               | No browser boundary or bundle regression.                                                  |
| Final local per PR               | `npm run test:unit`, `npm run test:ci`, `npm run build`                                                                                                                                                                                         | Mandatory repository completion gates on each final unchanged track.                       |
| Final remote per published track | Branch Release Gate; Run Hetzner Supported Distributed Manifests                                                                                                                                                                                | Exact feature/default commit publication evidence.                                         |

No REST behavior changes are planned, so no new API-v1 black-box recipe is required. If implementation changes REST behavior, runtime authorization, message routing, persisted contracts, or concurrency, stop and re-plan the appropriate black-box/convergence gates rather than treating this matrix as sufficient.

## 11. Rollout, Observability, Migration, Rollback, And Deprecation

### Rollout

1. Merge the Task 1 foundation PR first. Each later track branches from a default branch that already contains its declared prerequisites; do not build one long-lived combined ontology branch.
2. Publish the Task 2 domain pilot, Tasks 3-4 realtime pilot, and Task 5 code-standard catalog as separately reviewable tracks. After those selected pilot slices merge, publish Task 6 artifact tooling from the assembled pilot; its API must also prove that subset generation remains valid.
3. Publish Task 7 documentation and record the human pilot decision only after the pilot tracks and generated artifacts are available together on the default branch and all eight competency answers can be reviewed.
4. If approved, run Tasks 8 and 9 on separate domain/realtime expansion branches. If either is declined, record that explicit scope decision; governance must remain valid for the smaller catalog.
5. Before publishing the second expansion, rebase it on the default branch containing the first, regenerate the two artifacts, rerun its invalidated gates, and review only the resulting integration diff. This serializes shared `mod.ts`/artifact ownership without a permanent combined branch.
6. Publish Task 10 as its own governance track after the chosen ontology scope is present. No runtime feature flag is needed because runtime, transport, authorization, and checker entry points do not import ontology modules or artifacts.

### Observability

- The generated report shows vocabulary and binding versions, maturity, term count, term kind, authority, wire ID, actual validation classification, owner bindings, contractual resolution failures, and informational drift warnings.
- CI surfaces stale artifact paths and precise semantic/binding issue codes and paths; warnings identify non-contractual targets without failing the build.
- Pull-request diffs are the audit log for term additions, relationship changes, binding-strength changes, competency answers, and generated projections.
- No runtime metrics or logging are added in the initial `0.x` releases because ontology lookup is not on runtime paths.

### Migration

- There is no data, database, network, or packet migration.
- Existing identifiers are imported into metadata in place; they are not moved or renamed.
- Existing checker IDs move once, without value changes, into the checker-owned neutral module `scripts/repo-style-check/repo-style-rule-ids.mjs`; both checker and ontology consume that module, and the checker never consumes ontology code or artifacts.
- App/game owners adopt only when a competency question justifies it, by adding a vocabulary extension and optional graded binding module. Adoption does not require a repository-wide source scan or private-symbol inventory.

### Rollback

- Revert tasks in reverse dependency order.
- Generated JSON-LD and Markdown roll back with the owning Task 6, 8, 9, or 10 commit that produced them.
- If only artifact generation is problematic, revert Task 10 and then Task 6 while keeping unreferenced vocabulary and binding modules available for repair.
- If the checker-ID extraction in Task 5 is problematic, revert that track to restore the same literals in the checker; finding IDs and enforcement behavior remain unchanged.
- Runtime transports, auth, state, and schemas need no rollback because they were never changed.

### Deprecation

- Mark a term `deprecated`, keep it in generated output, add `removalCondition`, add `supersededBy` only when a real replacement exists, and increment that vocabulary's minor version.
- Deprecate bindings separately: keep contractual bindings until the bound public contract is migrated; informational bindings may move in a binding patch release with a recorded drift disposition.
- Remove a term only in the next major version after catalog/binding lookup confirms no selected consumer and the semantic owner approves. Repository text search may supplement this evidence but is not semantic authority.
- Never reuse any removed ontology, term, route, owner, binding-set, binding, binding-profile, wire, or code-rule ID.

## 12. Risks And Rejected Alternatives

| Risk/alternative                                        | Decision or mitigation                                                                                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Ontology becomes a second schema source                 | Store semantic relations and bindings only; schemas, validators, wire constants, and checker IDs remain owned by existing code.               |
| Metadata implies authorization                          | Use owner bindings and explicit non-authority docs; never expose an authorize function or decision from ontology.                             |
| Runtime validation timing changes                       | Validator lookup is opt-in and tested separately; no existing receive path calls it in the initial releases.                                  |
| Private code is held hostage by ontology                | Bind stable contracts as `contractual`; bind capabilities as `owner`; make implementation/example pointers warning-only and removable.        |
| A stable contract is moved or re-exported               | Update its contractual binding in the same PR and bump the binding patch version; vocabulary/runtime behavior need not change.                |
| Browser bundle growth                                   | No default facade/barrel import; enforce existing entrypoint and bundle checks.                                                               |
| Central registry becomes an ownership bottleneck        | Owner modules compose through immutable selected modules; no global mutable registration or requirement that all ontology families be loaded. |
| IDs drift between checker and ontology                  | Checker owns a neutral ID module consumed downstream by both checker and ontology; import-graph tests prevent dependency reversal.            |
| JSON-LD suggests a graph service                        | It is a static, offline-expandable vocabulary projection with no code paths, dereference requirement, or triple-store dependency.             |
| Repository HTTPS IRIs imply a public standard           | Document repository governance and non-dereferenceability for `0.x`; external publication and persistence guarantees require approval.        |
| The GitHub repository is renamed or moved               | Treat already emitted IRIs as opaque stable IDs and do not bulk-rewrite them; any redirect/dereference policy is separately approved.         |
| OWL/open-world inference contradicts runtime invariants | Do not use OWL in the initial releases; runtime validation remains closed-world and explicit.                                                 |
| SHACL duplicates runtime schemas                        | Defer; if later justified, generate it from authoritative contracts and treat it as external-consumer validation only.                        |
| Automatic source scanning creates false authority       | Reject as the primary design. Structural resolution verifies declared bindings; source inventories remain supplementary.                      |
| Ontology grows into a code mirror                       | Admit only concepts needed by competency questions, stable identity, or authority boundaries; require a human detail-ceiling review.          |
| Embedding JSON-LD in packets increases latency/size     | Explicitly prohibited. Wire IDs stay compact and map to local metadata.                                                                       |
| Fallback attempts look correlated when they are not     | Record `domain-owned` correlation and current separate-ID behavior; wire correlation needs separate approval.                                 |

## 13. Decisions Requiring Separate Human Approval

The plan makes no existing public/wire compatibility change. Stop and request approval before any implementation expands into one of these decisions:

- add/rename/remove an AL field, `typeId`, topic, lane ID, GroupRef field, or Room/Group public surface;
- import ontology metadata into default runtime entry points;
- automatically validate existing inbound payloads and thereby change rejection/error timing;
- define one canonical `senderId` kind and migrate current callers;
- add cross-transport correlation fields or fallback deduplication semantics;
- make an ontology decision authorize, persist, transact, converge, or own game state;
- promote any vocabulary/binding series from experimental `0.x` to stable `1.0.0` or claim compatibility for external consumers;
- make the repository HTTPS IRI namespace publicly dereferenceable, externally governed, or subject to long-term web-standard persistence guarantees;
- add SHACL/OWL/triple-store/network infrastructure;
- retain a compatibility fallback beyond the existing behavior without an owner and removal condition.

## 14. Estimates And Parallel Work

| Task                        | Estimated size | Dependency               | Independent work                                                                      |
| --------------------------- | -------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| 1. Metamodel/catalog        | M              | none                     | Foundation PR; must merge first.                                                      |
| 2. Domain pilot             | M              | 1                        | Separate domain PR.                                                                   |
| 3. Protocol/validator pilot | M              | 1-2                      | Separate realtime PR; needs the published GroupRef term.                              |
| 4. Browser lane extension   | S              | 3                        | Same realtime track as 3, as a separate commit.                                       |
| 5. Code standards/rule IDs  | M              | 1                        | Separate standards PR; may proceed alongside 2-4 because it owns disjoint files.      |
| 6. Artifacts                | M              | 1-5 merged               | Separate tooling PR; generated pilot includes all slices, while API supports subsets. |
| 7. Docs/pilot gate          | M              | 1-6 merged               | Serial human checkpoint across the assembled pilot.                                   |
| 8. Domain expansion         | M              | 7 plus explicit approval | Optional separate domain PR; may proceed alongside 9.                                 |
| 9. Protocol expansion       | L              | 7 plus explicit approval | Optional separate realtime PR; may proceed alongside 8.                               |
| 10. Governance              | M              | 7 and chosen 8-9 scope   | Separate final governance PR; valid for pilot-only scope.                             |
| 11. Completion/publication  | M elapsed time | each track               | Repeated per PR; remote gates may dominate.                                           |

Overall implementation is large but deliberately divisible: approximately 8-12 focused engineering intervals plus full CI/remote gate time. Tasks 2-5 are the safe pilot parallel window after Task 1 merges; Tasks 8 and 9 are the optional post-pilot parallel window. Keep `mod.ts`, generated artifacts, package scripts, and artifact tests owned by their named track or integrate them serially; do not resolve parallel conflicts by creating a permanent combined branch.

## 15. Completion Definition

The implementation is complete only when:

- the Task 1 foundation, all approved pilot modules, Task 7 documentation, and Task 10 governance are published; Tasks 8-9 are either published or explicitly declined/removed from scope by the human pilot decision;
- every included vocabulary and binding module has a controlled owner IRI, independent version, repository-governed version IRI, declared maturity, and useful answers to its applicable competency questions;
- every selected vocabulary dependency is satisfied by the exact required version or an explicit `compatibleWith` entry, and every binding set names the exact selected vocabulary version it annotates;
- semantic references are valid, route ownership is unique by the actual dispatch keys, and every validation record is honestly classified as runtime-payload, envelope-only, or unvalidated;
- all contractual bindings resolve structurally, owner paths exist, and implementation/example drift is reported without blocking completion;
- checker rule IDs remain checker-owned and checker/runtime import-graph tests prove that ontology modules and artifacts are downstream only;
- generated JSON-LD and Markdown are current, deterministic, offline-expandable, and JSON-LD contains no repository code bindings;
- no existing wire, runtime authority, schema, auth, state, transport, or checker-enforcement behavior changed;
- all focused commands and mandatory local gates pass on the final unchanged tree for every published track;
- each draft PR is current, Branch Release Gate is green for its exact final feature commit, and Run Hetzner Supported Distributed Manifests is green for the exact resulting default-branch commit;
- exact passed, failed, and skipped evidence, construction-warning dispositions, scope decisions, and both classes of validated SHA are recorded in the umbrella progress record.

An instruction not to commit, push, or publish postpones the last conditions; it does not waive them or permit the plan to be marked complete.
