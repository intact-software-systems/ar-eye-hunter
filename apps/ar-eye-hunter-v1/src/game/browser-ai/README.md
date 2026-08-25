# AR Eye browser AI navigation

This folder owns AR Eye policy around the shared browser RallarAI runtime:

- `arena-browser-ai-config.ts` reads the explicit build-time mode and model.
- `arena-browser-ai-provider.ts` selects exactly that configured provider.
  WebLLM unavailability or generation failure stays visible to the caller; it
  never changes provider mode implicitly.
- `arena-webllm-provider.ts` adapts AR Eye's WebGPU check and lazy
  `@mlc-ai/web-llm` engine loader to the canonical shared-web WebLLM provider.
- `arena-webllm-evaluation.ts` owns deterministic and explicitly gated live
  evaluation suites.

Provider execution, cancellation, JSON parsing, and shared schema validation
remain owned by `packages/shared-web/browser/ai/providers`.
