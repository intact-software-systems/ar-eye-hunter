# Server Middleware

Server applications compose the canonical
`rallar-system/middleware/create-rallar-middleware.ts` entry after constructing
their repositories and domain services. API-v1 is the executable reference:

```text
apps/api-v1/src/composition/create-api-v1-mutation-runtime.ts
  -> constructs persistence, caches, domain services, and AppInbox factories
apps/api-v1/src/composition/create-api-v1-runtime.ts
  -> constructs topology/RTC owners
  -> calls createRallarMiddleware(...)
packages/shared-server/rallar-system/middleware/create-rallar-middleware.ts
  -> creates QueueBox/WebSocket infrastructure
  -> constructs every configured inbox service synchronously
  -> registers all four QueueBox task families
  -> exposes the queue worker only from the final runtime
apps/api-v1/src/main.ts
  -> installs feature topics and WebSocket lifecycle
  -> mounts HTTP/WebSocket routes
  -> starts the final runtime
```

Import each factory, service, and repository from its owning feature. Do not
reintroduce a generic service bucket or a forwarding middleware path. Keep
durable mutations behind the owning AppInbox service so WebSocket publication
or wake-up failure cannot become a lost state mutation.
