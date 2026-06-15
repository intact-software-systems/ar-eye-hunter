# RallarAI Game Event Example

This example shows the intended shape for a game that treats AI output as a
proposal before applying it to domain state.

```ts
import {
  createRallarAiAcceptedResultTracker,
  createRallarAiMockProvider,
  transitionRallarAiResultLifecycle,
} from '@shared/rallar-ai/mod.ts';
import { createRallarBrowserAi } from '@shared-web/browser/rallar-ai.ts';

const gameEventSchema = {
  type: 'object',
  required: ['kind', 'amount'],
  properties: {
    kind: { type: 'string', enum: ['spawn', 'reward'] },
    amount: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
} as const;

const ai = createRallarBrowserAi({
  rallar,
  provider: createRallarAiMockProvider({
    value: { kind: 'spawn', amount: 1 },
  }),
  policy: { mode: 'browser-only', staleResultMode: 'reject' },
});

const tracker = createRallarAiAcceptedResultTracker();
const draft = await ai.generateJson({
  schemaId: 'game-event',
  schemaVersion: '1',
  schema: gameEventSchema,
  prompt: 'Generate the next room event.',
  baseStateRevision: currentRevision,
  dedupeKey: `room:${roomId}:turn:${turnId}`,
});

const proposed = transitionRallarAiResultLifecycle(draft, 'proposed');
await ai.broadcastJson({
  result: proposed,
  transport: 'messages.rtc',
  roomId,
  topicId: 'room.ai.proposals',
  typeId: 'rallar.ai.proposed',
});

const accepted = transitionRallarAiResultLifecycle(proposed, 'accepted');
await tracker.acceptOnce(accepted, (result) => {
  applyGameEvent(result.value);
});
```

In production, replace the mock provider with either:

- a browser provider imported from
  `@shared-web/browser/rallar-ai-providers/webllm.ts`, or
- a Rallar Server route/topic backed by a private server-side sidecar such as
  Ollama.

The generated envelope remains proposal data. The game still owns domain
validation, authorization, host approval, and final state mutation.

`ai.broadcastJson(...)` is the RallarAI-specific proposal broadcast helper. For
ordinary validated room traffic, prefer `room.message<T>(...)` or
`room.realtime<T>(...)` depending on reliability and latency needs.
