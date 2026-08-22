# CompareJson

`CompareJson` is a JSON compatibility and equality helper for tests.

It can compare JSON structures in four modes:

| Mode                  | Compares values | Requires exact structure |
| --------------------- | --------------: | -----------------------: |
| `compatibleStructure` |              No |                       No |
| `compatible`          |             Yes |                       No |
| `exactStructure`      |              No |                      Yes |
| `exact`               |             Yes |                      Yes |

## Import

```ts
import { CompareJson } from './CompareJson.ts';
```

## Basic usage

```ts
const expected = {
    id: 'integer',
    name: 'string',
    status: 'ACTIVE|PENDING'
};

const actual = {
    id: 123,
    name: 'Alice',
    status: 'ACTIVE',
    createdAt: '2026-05-11T18:00:00Z'
};

const result = CompareJson.compatible(expected, actual);

if (!result.isEqual) {
    console.log(result.message);
}
```

## Assertion usage

The assertion helpers throw an error if the comparison fails.

```ts
CompareJson.assertCompatible(expected, actual);
CompareJson.assertExact(expected, actual);
```

This is convenient in tests:

```ts
Deno.test('response matches contract', () => {
    CompareJson.assertCompatible(expectedResponse, actualResponse);
});
```

## Wildcards

The expected JSON can use special string values.

### `any`

Matches any actual value.

```ts
{
    id: 'any';
}
```

### `integer`

Matches an integer number or integer string.

```ts
{
    id: 'integer';
}
```

Matches:

```ts
{
    id: 123;
}
```

Also matches:

```ts
{
    id: '123';
}
```

### `float`

Matches a non-integer finite number or float string.

```ts
{
    amount: 'float';
}
```

Matches:

```ts
{
    amount: 42.75;
}
```

### `string`

Matches any string.

```ts
{
    name: 'string';
}
```

### Alternatives with `|`

A string containing `|` is treated as a list of allowed values.

```ts
{
    status: 'ACTIVE|PENDING|DISABLED';
}
```

Matches:

```ts
{
    status: 'ACTIVE';
}
```

## Compatible comparison

Compatible comparison checks that the actual JSON contains at least the expected structure and values.

Extra fields in actual are allowed.

```ts
const expected = {
    id: 'integer',
    name: 'string'
};

const actual = {
    id: 123,
    name: 'Alice',
    createdAt: '2026-05-11T18:00:00Z'
};

CompareJson.assertCompatible(expected, actual);
```

## Exact comparison

Exact comparison requires the same structure and matching values.

```ts
const expected = {
    id: 'integer',
    name: 'string'
};

const actual = {
    id: 123,
    name: 'Alice',
    createdAt: '2026-05-11T18:00:00Z'
};

const result = CompareJson.exact(expected, actual);
```

This fails because `actual.createdAt` is not present in `expected`.

## Structure-only comparison

Structure-only comparison ignores values.

```ts
const expected = {
    id: 1,
    name: 'Alice'
};

const actual = {
    id: 999,
    name: 'Bob'
};

CompareJson.assertCompatibleStructure(expected, actual);
```

This passes because both objects have the same compatible shape.

## Ignoring keys

Use `ignoreJsonKeys` to ignore fields by name anywhere in the JSON tree.

```ts
CompareJson.assertCompatible(expected, actual, {
    ignoreJsonKeys: ['traceId', 'timestamp']
});
```

## Ignoring paths

Use `ignoreJsonPaths` to ignore a field at a specific path.

```ts
CompareJson.assertCompatible(expected, actual, {
    ignoreJsonPaths: ['metadata.createdAt']
});
```

## WebSocket event example

```ts
const expected = {
    type: 'room.joined',
    roomId: 'string',
    clientId: 'string',
    timestamp: 'any'
};

const actual = {
    type: 'room.joined',
    roomId: 'room-1',
    clientId: 'client-123',
    timestamp: '2026-05-11T18:00:00Z',
    serverInstanceId: 'api-1'
};

CompareJson.assertCompatible(expected, actual);
```

## API response example

```ts
const expected = {
    id: 'integer',
    displayName: 'string',
    role: 'ADMIN|USER'
};

const actual = await response.json();

CompareJson.assertCompatible(expected, actual, {
    ignoreJsonKeys: ['traceId']
});
```

## ALMessage example

```ts
const expected = {
    id: 'string',
    overlayId: 'string',
    senderId: 'string',
    kind: 'chat.message|game.move|presence.update',
    payload: 'any'
};

CompareJson.assertCompatible(expected, actualMessage, {
    ignoreJsonPaths: ['runtime.receivedAt']
});
```
