# RallarAI Governance And Evaluation

Date: 2026-06-06

RallarAI exposes provider metadata, policy hooks, and evaluation helpers. It
does not decide whether a model is legally or operationally suitable for a
product. Applications own that decision.

## Provider Governance

Keep a small application-owned registry for every provider/model combination
that can run in production:

```ts
import {
  defineRallarAiProviderGovernanceMetadata,
  isRallarAiProviderAllowedInProduction,
} from '@shared/rallar-ai/mod.ts';

const ollamaLlama = defineRallarAiProviderGovernanceMetadata({
  providerId: 'ollama',
  adapterVersion: 'rallar-ai-v1',
  modelId: 'llama-prod',
  modelDigest: 'sha256:...',
  target: 'server',
  structuredOutput: true,
  productionAllowed: true,
  licenseNotes: 'Reviewed by the application team on 2026-06-06.',
  knownLimits: {
    recommendedTimeoutMs: 15_000,
  },
});

if (!isRallarAiProviderAllowedInProduction(ollamaLlama, 'server')) {
  throw new Error('Provider is not approved for server-side RallarAI.');
}
```

Production review should record:

- Provider ID and adapter version.
- Model ID plus version or digest when available.
- Runtime target: browser, server, shared test provider, or sidecar.
- License notes supplied by the application or deployment owner.
- Whether structured JSON output is supported natively or through prompting.
- Known context/output limits and recommended timeout.
- Whether the provider is allowed in production for the selected target.

## Deployment Rules

- Keep sidecar model endpoints private to the server network.
- Mount public RallarAI access through Rallar Server REST or WS helpers.
- Configure the server authorization hook before exposing public generation,
  broadcast, or persistence helpers.
- Keep browser providers behind explicit imports so normal browser bundles do
  not include model runtime code.
- Treat browser-side generation as advisory. Peers can run local code, so
  authoritative acceptance still belongs to the application, host, or server.

## Evaluation

Run deterministic mock-provider evaluation in normal CI:

```ts
import {
  createRallarAiMockProvider,
  runRallarAiEvaluationSuite,
} from '@shared/rallar-ai/mod.ts';

const report = await runRallarAiEvaluationSuite({
  suiteId: 'game-event-smoke',
  provider: createRallarAiMockProvider({
    value: { kind: 'spawn', amount: 1 },
  }),
  cases: [
    {
      caseId: 'spawn-event',
      request: {
        schemaId: 'game-event',
        schemaVersion: '1',
        schema: gameEventSchema,
        prompt: 'Generate a spawn event.',
      },
      expectedValue: { kind: 'spawn', amount: 1 },
    },
  ],
});
```

Live provider checks should be opt-in:

```ts
import {
  runRallarAiEvaluationSuiteIfEnabled,
} from '@shared/rallar-ai/mod.ts';

const result = await runRallarAiEvaluationSuiteIfEnabled({
  suiteId: 'ollama-live-game-event-smoke',
  provider: ollamaProvider,
  cases,
  env: process.env,
  gate: 'RALLAR_AI_LIVE_OLLAMA',
  providerLabel: 'Ollama',
});
```

The result is `skipped` unless the gate is explicitly enabled. This keeps
normal CI deterministic while still giving teams a standard local/scheduled
quality check.

## Live Gates

- `RALLAR_AI_LIVE_OLLAMA=1`: enables the live Ollama evaluation harness.
- `RALLAR_AI_OLLAMA_BASE_URL`: optional Ollama base URL, default
  `http://127.0.0.1:11434`.
- `RALLAR_AI_OLLAMA_MODEL`: optional Ollama model ID for live evaluation.
- `RALLAR_AI_LIVE_WEBLLM=1`: reserved for browser-run WebLLM live evaluation.
  The repository keeps the provider adapter type-checkable, but real WebLLM
  evaluation requires a browser model runtime supplied by the application.

## Quality Bar

Schema validity is necessary, but not sufficient. Evaluation cases should also
check domain constraints:

- Generated action is legal for the current game state.
- Output can be deduplicated and replayed.
- Provider metadata and validation status are present in the report.
- Unexpected but schema-valid output is visible to human review.
- Failure output does not leak prompt or context into diagnostics.
