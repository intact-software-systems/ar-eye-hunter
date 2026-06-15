# App Inbox Completion Notifications

Status: proposal, not current runtime behavior. The durable result table
(`resource_inbox_results`) remains the source of truth; completion
notifications are only a possible future optimization for waking waiters faster.

The current app-inbox waiter is deliberately durable: it enqueues an inbox entry, polls `resource_inbox` until the entry
is `COMPLETED` or `FAILED`, then reads the durable result from `resource_inbox_results`. This works across processes,
but slow storage or queue scheduling makes synchronous HTTP operations wait for retry intervals.

Completion notifications can reduce that wait time, but they should wake waiters only. The durable result table should
remain the source of truth.

## Same-Process Shape

For one process, an in-memory notifier is enough:

```ts
export type AppInboxCompletion = Readonly<{
  key: Key;
  status: EntityStatus.COMPLETED | EntityStatus.FAILED;
}>;

export interface AppInboxCompletionNotifier {
  waitFor(key: Key, timeoutMs: number): Promise<AppInboxCompletion | undefined>;
  notify(completion: AppInboxCompletion): void;
}
```

`AppInboxService.processEntryUntilCompletionInternal(...)` would register a waiter before or immediately after enqueue,
then race the notification with the existing timeout. When the notification arrives, it should still call
`resourceInboxResults.findByKey(key)` before returning to the HTTP route.

`AppInboxService.writeAppInboxResult(...)` would call `notifier.notify({ key: entry.key, status })` after
`resourceInboxResults.replace(...)` succeeds.

## Multi-Instance Shape

Production can run more than one server isolate or process, so an in-memory notifier is not sufficient by itself. The
multi-instance version needs a pub/sub adapter:

```ts
export interface AppInboxCompletionPubSub {
  publish(completion: AppInboxCompletion): Promise<void>;
  subscribe(handler: (completion: AppInboxCompletion) => void): Promise<() => Promise<void> | void>;
}
```

The Postgres implementation can use `LISTEN/NOTIFY` with a small JSON payload containing
`topicId`, `contextId`, `resourceId`, and `status`. The waiter subscribes, checks the durable result table, enqueues the
entry, then waits for either a notification or the existing polling fallback. The fallback stays required because
notifications can be missed, delayed, or delivered before a waiter is attached.

## Implementation Iterations

### Iteration 1: Completion Contracts And Local Notifier

Add shared-server contracts for completion notifications without changing app-inbox behavior yet.

Scope:

- Add `AppInboxCompletion`, `AppInboxCompletionNotifier`, and `NoopAppInboxCompletionNotifier`.
- Add an in-memory notifier implementation for unit tests and single-process deployments.
- Extend `AppInboxServiceOptions` with optional notification settings, but keep them disabled by default.
- Define the expected failure semantics: notification failures must not fail the mutation, and durable result reads remain
  authoritative.

Tests:

- Unit-test in-memory waiter resolution.
- Unit-test timeout cleanup so abandoned waiters do not leak.
- Unit-test duplicate notifications for the same key.

### Iteration 2: Notification-Assisted AppInbox Wait

Integrate notifications into `AppInboxService.processEntryUntilCompletionInternal(...)` while retaining polling fallback.

Scope:

- Register the notification waiter before enqueueing or immediately after a preflight result check.
- After enqueue, wait for either a completion notification or the existing polling path.
- On notification wake-up, read `resource_inbox_results` and return only that durable result.
- Keep the current polling timeout as the overall safety budget.
- Add phase timing for `wait-notification`, `wait-polling-fallback`, and `read-result-after-notification`.

Tests:

- Waiter returns quickly when a notification is delivered.
- Waiter still succeeds when notification is missed but polling observes completion.
- Waiter returns the durable failed result when the handler writes `FAILED`.
- Waiter does not return data from the notification payload.

### Iteration 3: Publish Completion After Durable Result Write

Emit completion notifications from the handler side after result persistence succeeds.

Scope:

- Call the notifier only after `resourceInboxResults.replace(...)` has completed.
- Include only key and status in the notification payload.
- Record notification publish timing and errors.
- Swallow notification publish failures after logging/timing, because the durable result is already written and polling
  must still work.

Tests:

- Completion is published after `COMPLETED` result write.
- Completion is published after `FAILED` result write.
- Publish failure does not fail the app-inbox handler.
- Publish is not attempted before the durable result exists.

### Iteration 4: Postgres Completion Pub/Sub Adapter

Add a production adapter for multi-process wakeups using Postgres `LISTEN/NOTIFY`.

Scope:

- Add a typed `AppInboxCompletionPubSub` or notifier adapter backed by `LISTEN/NOTIFY`.
- Reuse the existing `db-listen.ts` and `db-notify.ts` pattern where practical, but keep completion notifications
  separate from queuebox pub/sub.
- Do not hard-code the queuebox bridge self-filter. Completion notifications should be delivered to any waiter,
  including a waiter in the same server process when it is using the DB-backed path.
- Return an unsubscribe/stop handle so listeners can be shut down cleanly.
- Validate notification payloads and ignore malformed messages without crashing the listener.

Tests:

- Unit-test payload serialization and validation.
- Unit-test that same-publisher messages can be delivered when requested.
- Unit-test listener cleanup/unsubscribe behavior.
- Add an integration test when a test Postgres URL is available.

### Iteration 5: API-v1 Wiring And Configuration

Wire the Postgres completion notifier into `apps/api-v1`.

Scope:

- Add environment variables:
  - `RALLAR_APP_INBOX_COMPLETION_NOTIFICATIONS`: enable DB-backed completion notifications.
  - `RALLAR_APP_INBOX_COMPLETION_CHANNEL`: Postgres notification channel name.
  - `RALLAR_APP_INBOX_COMPLETION_WAIT_MS`: per-notification wait slice before falling back to polling.
- Construct the notifier during middleware initialization and pass it into both `AppGroupInboxService` and
  `AppClientInboxService`.
- Expose timing for notification wait/publish and listener failures.
- Document recommended production defaults.

Tests:

- Unit-test env parsing.
- Startup test with notifications disabled.
- Startup test with a fake notifier enabled.

### Iteration 6: Multi-Process Behavior Tests

Prove the actual production use case: one process waits while another process handles and publishes completion.

Scope:

- Build a shared fake pub/sub test that simulates two app-inbox service instances.
- Add a Postgres-backed integration test gated by a real test database environment variable.
- Ensure the waiter in process A does not depend on in-memory state from process B.
- Verify fallback polling still succeeds when the notification is dropped.

Tests:

- Process A enqueues and waits; process B dequeues, writes result, publishes completion; process A returns quickly.
- Dropped notification falls back to polling.
- Delayed notification arriving after polling completion is harmless.
- Duplicate notifications are harmless.

### Iteration 7: Operational Hardening

Make the feature safe to run continuously in production.

Scope:

- Add listener reconnect behavior if the Postgres listen connection drops.
- Add bounded waiter maps and cleanup on timeout, cancellation, and service shutdown.
- Add counters/timing for notification published, received, ignored, malformed, timed out, and fallback-used.
- Add channel-name validation so deployment configuration cannot create invalid Postgres channels.
- Add shutdown hooks for api-v1 to stop completion listeners when the server exits.

Tests:

- Listener reconnect test with a fake pub/sub backend.
- Waiter cleanup test under timeout and duplicate notification load.
- Malformed payload test.

### Iteration 8: Tune Polling After Notifications Are Proven

Only after live multi-process tests are green, reduce synchronous polling pressure.

Scope:

- Increase polling intervals or use notification-first waits to reduce DB polling load.
- Keep a durable polling fallback for missed notifications.
- Compare timing logs before and after rollout.
- Document the rollback path: disable `RALLAR_APP_INBOX_COMPLETION_NOTIFICATIONS`.

Tests:

- Regression tests for notification disabled mode.
- Regression tests for notification enabled mode.
- Load-oriented smoke test showing fewer completion-status reads under notification-enabled operation.
