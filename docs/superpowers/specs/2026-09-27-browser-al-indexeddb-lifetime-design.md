# Browser AL IndexedDB lifetime design

## Purpose and evidence boundary

Repeated RTC-B06 reconnects must not leave one browser middleware generation's IndexedDB connections alive after that generation ends. The correction must preserve committed AL work, current QueueBox admission and recovery, room authority, and the existing durable database schema. It must not add a queue, retry owner, lock, timer, persistence fence, library, migration, or legacy path.

A bounded, opt-in local diagnostic completed 20 reconnect cycles. Its C page had 3 `IndexedDbConnection`, `IndexedDbAdmissionBackend`, and `IndexedDbQueueBox` objects at cycle 0 and 63 of each at cycle 20; A and B remained at 3. Sampled native `IDBDatabase` listener paths retain those owners. This is measured object-count evidence and a strong connection-lifetime lead, not an attribution of every retained byte, a controlled performance comparison, or a valid 100-cycle RTC-B06 result. Repeated E3 warmups still fail readiness around cycles 42–43, so a connection fix alone must not be presented as the whole RTC correction.

## Current ownership and failure

`initialiseMiddleware` configures three scoped AL store factories, then resolves session inbound stores. WebSocket and RTC construction resolve their outbound stores. `ALRuntimeStoreRegistry` stores factories, not store instances: every later resolve creates another backend, including black-box replay and RTC NACK diagnostic reads while the browser runtime is active. Consequently, closing only the first inbound, WS, and RTC backends would leave additional same-generation connections behind.

Each `IndexedDbAdmissionBackend` owns one `IndexedDbConnection` shared with its `IndexedDbQueueBox`. `IndexedDbConnection.open()` caches an open promise and installs an `onversionchange` listener capturing the connection. Browser shutdown stops transport and QueueBox consumers but never closes that native database. A rejected initializer can escape before it returns a middleware for the existing stale-generation cleanup; a successful initializer can also return after a newer generation has started.

The existing `browser-al-runtime-cleanup.ts` closes the temporary database handle
used for row eviction; it does not own or close the backends created by runtime
store factories. The black-box replay and RTC NACK diagnostic paths each call
the registered outbound-store resolvers during an active browser generation,
confirming that tracking only the three initial resolutions would be incomplete.

## Selected architecture

Give each middleware initialization one internal browser AL persistence lifetime. Its registry factories create stores through the existing AL store implementation and synchronously register **every newly constructed, owned IndexedDB backend** with that exact lifetime before returning the stores. This includes later resolver calls in the same generation. In-memory stores require no native close. An explicitly injected backend is borrowed and is never closed by this lifetime.

The lifetime owns a terminal, idempotent `dispose` operation. It stops accepting backend creations when disposed and closes precisely the backends it registered; it does not scan a global registry or close by session ID. A factory retained after disposal must reject creation instead of silently making an untracked connection. A newer initialization, even for the same session, owns a distinct lifetime. Reconfiguring a scope may replace the registry's factory registration but does not transfer ownership of the old factory's already-created resources.

Keep this lifecycle handle internal to the browser composition. `RallarBrowserMiddleware`, `ApiMiddleware`, AL admission/work-store interfaces, package barrels, and the public browser facade retain their current contracts. The internal initializer may return the middleware together with its owned lifetime to `BrowserTransportRuntime`; its sole production caller is that runtime. Existing independent factory calls retain their behavior and remain outside the middleware generation. Do not add an optional public `dispose` member or a compatibility adapter to hide ownership.

Store construction must expose the concrete newly created backend at the internal construction seam, alongside the existing store pair, so the lifetime can register the exact owner before the stores escape. Reuse one canonical AL store assembly path and the current defaults; do not duplicate admission policy or QueueBox construction in browser code. A backend passed into a store factory stays borrowed. The implementation plan will name the smallest concrete seam after checking current callers and TypeScript/public-surface snapshots.

## Connection and shutdown semantics

`IndexedDbConnection` gains a terminal, idempotent close. Before any open, close does not open the database. If an open is pending, close marks the owner terminal immediately; a late successful open detaches its owner-capturing listener and closes that exact handle before it can be returned to waiting operations. A failed open remains a normal failure, with no unhandled rejection. An open after close fails rather than resurrecting the connection.

For an already open handle, close removes the owner-capturing `onversionchange` listener and closes the handle without deleting data or changing schema. A live connection retains existing version-change reopening behavior; a disposed connection never reopens. An old version-change callback must not clear a newer opening promise. Explicit close must not abort an already-started readwrite transaction merely to accelerate cleanup: committed work remains readable by the replacement generation.

`BrowserTransportRuntime` first stops the existing heartbeat, RTC/WS consumers, and QueueBox engine, then disposes its exact generation's AL lifetime. The current synchronous stop calls do not prove that all in-flight multi-transaction operations have quiesced. The implementation must test shutdown between read and write: it may surface an operation failure, but it must never report admitted success for an uncommitted write, erase previously committed work, or let stale work restart after disposal. Recovery belongs to the existing durable QueueBox and next runtime, with no new retry mechanism. If actual owner contracts require waiting for an in-flight phase, use their existing completion/cancellation semantics and prove the wait; do not claim graceful drain from a synchronous `stop()`.

Partial initialization owns cleanup at the point of construction. If WebSocket connection, RTC creation, state hydration, or heartbeat setup fails, close all successfully constructed consumers and the persistence lifetime, while preserving the original error and retaining cleanup failures as diagnostics. The WebSocket adapter must clean a service it constructed when its initial asynchronous connect rejects, because that service cannot otherwise reach the outer owner. A late successful initializer rejected by the existing runtime generation check is torn down with its own lifetime, never the newer generation's resources. Repeated shutdown/late completion is safe and has one observable close per concrete native handle.

## Rejected alternatives

- Closing only the three initially resolved stores misses factory-created backends from later replay and diagnostics.
- Closing from an individual inbound or outbound runtime can invalidate the shared inbound store while another consumer still uses it.
- Caching one backend per scope or globally changes store-sharing and overlapping-generation semantics; it creates a different long-lived owner instead of fixing the current lifetime.
- Closing after each operation adds connection churn and leaves multi-transaction operations without one coherent owner.
- Merely breaking the native event-listener reference hides one retaining path while leaving database handles open.
- A new queue, retry loop, lock, timer, generation counter, schema rewrite, or migration is unnecessary and outside the approved correction.

## Acceptance and proof

The implementation starts test-first. Focused semantic tests must show close before open, pending-open success and failure, shared concurrent open, version change versus disposal, double close, native listener/handle release, and no reopen after retirement. Browser tests must cover all three initial store families plus later factory resolutions, borrowed backends, partial startup failure at each meaningful stage, stale-old/new initialization overlap, and same-session durable work surviving replacement. An in-flight shutdown test must exercise the real read/write boundary and prove no false admitted success or lost committed row.

The direct behavior gate is the focused IndexedDB/backend/browser-lifecycle and durable-work suites. The affected package gate is shared and shared-web TypeScript checks, public-surface/bundle checks if the internal seam changes an entry point, and a browser consumer build. Review every changed human-authored file in full; support files changed during remediation join that review recursively, while independent untouched code remains outside it. Remove affected unused or legacy code rather than retaining a parallel path. Any public API, persisted format, protocol, or verified-consumer change requires a separate explicit compatibility decision before implementation.

After a reviewed correction, run source-labelled browser reconnect/retention evidence without concurrent heavy validation. Compare object counts and retaining paths over repeated generations, then attempt the unchanged E3-memory 100-cycle workload. Stable connection ownership is necessary evidence but not sufficient for RTC-B06: the primary must complete and pass its existing correctness, sample, checksum, redaction, and repeat rules. A failed warmup or a 20-cycle probe remains diagnostic only.

## Scope and next gate

This spec authorizes no production edit by itself. After written-spec review, write a two-slice implementation plan: (1) exact backend/connection lifetime and its focused tests; (2) browser construction, partial-failure and overlapping-generation cleanup with package/browser proof. No new public lifecycle contract or migration is selected. The next gate is human review of this written spec before the implementation plan or code work begins.
