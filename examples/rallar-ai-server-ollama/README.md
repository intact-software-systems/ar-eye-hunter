# RallarAI Server With Ollama

This is a deployment template for running Rallar Server with an Ollama sidecar
kept private on the Compose network.

The important boundary is that browsers and external clients call Rallar Server
REST or WebSocket helpers. They should not call the raw Ollama endpoint.

## Services

- `rallar-server`: replace the placeholder image with your app's Rallar Server
  image. Configure the RallarAI Ollama provider with
  `RALLAR_AI_OLLAMA_BASE_URL=http://ollama:11434`.
- `ollama`: local model sidecar. The compose file uses `expose`, not host
  `ports`, so the endpoint is private to the Compose network by default.

## Local Use

1. Build or publish a Rallar Server image that mounts the RallarAI server
   helpers and configures authorization.
2. Replace `your-registry/rallar-server:latest` in `docker-compose.yml`.
3. Set `RALLAR_AI_OLLAMA_MODEL` to a model available in the Ollama volume.
4. Start the stack:

```sh
docker compose up
```

For live evaluation outside the container, use:

```sh
RALLAR_AI_LIVE_OLLAMA=1 \
RALLAR_AI_OLLAMA_BASE_URL=http://127.0.0.1:11434 \
RALLAR_AI_OLLAMA_MODEL=llama-test \
npx vitest run packages/tests/shared-server/rallar-ai/rallar-ai-ollama-live-evaluation.test.ts
```

When running the evaluation from inside the Compose network, use
`http://ollama:11434` as the base URL and include it in the provider allowlist.
