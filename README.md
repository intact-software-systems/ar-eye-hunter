# Rallar Kit

## Common Commands

Daily local confidence:

```sh
npm run test:ci
```

That runs unit tests, Deno-native tests, app-local Playwright, and the
self-contained Rallar full-stack memory gate.

Focused test gates:

```sh
npm run test:unit
npm run test:deno
npm run test:e2e
npm run test:full-stack
```

Rallar app development:

```sh
npm run dev:rallar
npm run dev:rallar:servers
npm run dev:rallar:all
```

Real integration runs:

```sh
npm run test:integration:postgres
npm run test:integration:rallar
npm run test:integration:rallar:live
```

The integration commands start Docker Postgres and run API-v1 migrations via
`db:test:up`. Stop the compose database explicitly with:

```sh
npm run db:down
```

Older `test:e2e:rallar-black-box:*` and `dev:rallar-black-box:*` command names
remain as compatibility aliases, but new docs prefer the shorter `test:rallar:*`
and `dev:rallar:*` names.
