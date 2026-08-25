# Browser RallarAI navigation

`../rallar-ai.ts` is the public browser contract and entrypoint. Runtime control
flow continues through these owners:

- `create-rallar-browser-ai.ts` composes the three facade operations.
- `create-browser-rallar-ai-generation.ts` owns one provider request from the
  policy check through timeout/cancellation cleanup and completion.
- `browser-rallar-ai-generation-policy.ts` owns browser provider eligibility
  and stale-result rejection.
- `browser-rallar-ai-diagnostics.ts` owns safe diagnostic metadata; prompts and
  context never enter diagnostic events.
- `browser-rallar-ai-result-delivery.ts` owns room broadcast and Rallar Data
  persistence of result envelopes.
- `providers/webllm-rallar-ai-provider.ts` is the explicit lazy live-provider
  entrypoint. It owns one cached runtime lifecycle and cancellation.
- `providers/create-web-llm-json-result.ts` normalizes a live response, rejects
  malformed JSON, and creates the shared schema-validation envelope.

Shared schemas, validation, result lifecycle transitions, proposal acceptance,
and provider contracts remain in `packages/shared/rallar-ai`.
