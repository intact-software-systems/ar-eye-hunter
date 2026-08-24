# Rallar Custom Data

`rallar.data` stores app-owned browser data separately from Rallar middleware
state. It uses the shared repository layer for in-memory caching and IndexedDB
for persistence.

```ts
type Todo = {
    title: string;
    done: boolean;
};

const todos = await rallar.data.open<Todo>('todos');

await todos.set('1', { title: 'Persist custom data', done: false });

const cached = todos.read('1'); // RAM only
const loaded = await todos.get('1'); // RAM, then IndexedDB
const all = await todos.getEntries();
```

## Scopes

The default scope is `app`. Rallar also supports auth-aware scopes:

```ts
await rallar.data.open<Todo>('todos', { scope: 'principal' });
await rallar.data.open<Todo>('drafts', { scope: 'session' });
```

`principal` and `session` stores require an auth session. They are closed during
login/logout so another user does not inherit the previous user's live in-memory
repositories. Closing a scoped repository does not delete its IndexedDB data.

Custom string scopes are also allowed:

```ts
await rallar.data.open<Todo>('todos', { scope: 'workspace:alpha' });
```

## Durability

`write-through` is the default. A resolved `set()` means the value has reached
IndexedDB and then memory observers are notified.

```ts
await rallar.data.open<Todo>('todos', { durability: 'write-through' });
```

`write-behind` updates memory first and mirrors changes to IndexedDB in the
background. Use `flush()` or `whenIdle()` before unload-sensitive work.

```ts
const drafts = await rallar.data.open<Todo>('drafts', {
    durability: 'write-behind'
});

await drafts.set('1', { title: 'Fast local write', done: false });
await drafts.flush();
```

Destructive operations such as `delete()` and `clearAll()` also touch
IndexedDB directly, so lazy write-behind stores can remove disk-only data.

## Schema Versions

Values are persisted in a small Rallar data envelope:

```ts
const todos = await rallar.data.open<Todo>('todos', {
    schemaVersion: 2,
    migrate: (persisted, context) => {
        if (context.fromVersion === 1) {
            const old = persisted as { text: string; };
            return { title: old.text, done: false };
        }

        return persisted as Todo;
    }
});
```

Legacy raw values written before the envelope existed are read as version `0`.
Without a migration function, persisted values are returned as-is.

## Cross-Tab Sync

Stores use `BroadcastChannel` when available. A write, delete, or clear in one
tab updates matching open stores in other same-origin tabs.

Disable it for unusual cases:

```ts
await rallar.data.open<Todo>('todos', { sync: false });
```

## Lookup And Lifecycle

Opened stores are registered in `RepositoryManager` and can be looked up by the
same store definition.

```ts
const definition = rallar.data.define<Todo>('todos');
const todos = await rallar.data.open(definition);

const sameStore = rallar.data.lookup(definition);
await todos.close();
```

Opening the same store identity with incompatible options throws. Store identity
is based on `dbName`, `storeName`, and `keyPrefix`; options such as durability
and schema version must match the first open.

Maintenance helpers:

```ts
await todos.clear();
await todos.deleteExpired();
await todos.destroy();

await rallar.data.closeScope('principal');
await rallar.data.clearScope('workspace:alpha');
await rallar.data.destroy(definition);

const usage = await rallar.data.estimateUsage();
```

`destroy()` clears IndexedDB data and closes the live repository. `close()`
only disposes the in-memory repository.
