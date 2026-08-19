# Shared-server CRDT ownership

The package public entry is [`packages/shared-server/mod.ts`](../../mod.ts). Internal consumers
import the direct capability owner described below.

## Owner map

- Realtime entry: `realtime/install-rallar-crdt-ws-topics.ts`
- Durable inbox entry: `inbox/app-crdt-inbox-service.ts`
- Mutation phases: `mutation/create-crdt-mutation-service.ts`
- PostgreSQL conditional write: `persistence/psql-crdt-mutation-repository.ts`
- Read and administration repositories: `persistence/*-crdt-log-repository.ts`
- Final effects: `mutation/create-crdt-mutation-outbox.ts` and
  `inbox/register-crdt-audit-delivery.ts`
- API administration routes: `apps/api-v1/src/crdt/register-crdt-admin-routes.ts`
- API durable-inbox construction: `apps/api-v1/src/crdt/create-api-crdt-inbox-service.ts`

## Runtime paths

- WebSocket append: the realtime installer validates and authorizes the envelope, then invokes the
  required durable mutation ingress exactly once. The inbox enqueues the canonical command and
  returns transport acceptance without a live-only mutation or fanout path.
- AppInbox retry: `app-crdt-inbox-service.ts` decodes and authenticates the command, then calls the
  mutation service's read, compute, validate, and transaction-bound write phases. AppInbox owns the
  transaction and repeats the complete attempt after an optimistic conflict.
- Admin mutation: API CRDT routes translate the administrator request in
  `apps/api-v1/src/crdt/create-crdt-admin-mutations.ts`, then submit the same canonical command path
  through the durable inbox.
- Read-only catch-up: the realtime installer authorizes the request, reads the page and optional
  snapshot from the configured log repository, and sends the existing catch-up response directly.
- Erasure audit: the mutation commits its final APP outbox intent atomically. Optional external
  delivery is registered after construction by `register-crdt-audit-delivery.ts` and never runs in
  the mutation transaction.
