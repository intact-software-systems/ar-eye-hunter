# AI Recipe Prompt Guide

This guide shows how to prompt an AI to generate recipes for Rallar
black-box testing.

There are two related recipe contracts:

- `RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA` for distributed tests in
  `apps/rallar-black-box`. This is the best target when the output should be
  staged and started across live browser control agents.
- `BLACK_BOX_RUNNER_SCENARIO_RECIPE_SCHEMA` for provider-neutral
  `black-box-runner` scenarios. This is the best target when the output should
  describe HTTP, WS, RTC, assertions, and variables without depending on the
  Rallar browser-agent command surface.

For distributed tests in the SPA today, ask the AI for a distributed run
manifest with inline `rallar-bb-test` recipes. A future bridge can make
black-box-runner scenarios a first-class distributed recipe type, but that is
not the primary manifest shape today.

The `apps/rallar-black-box` Distributed Recipes tab now includes a
`Generate With AI` panel that renders these schema-aware prompt patterns with
redacted Global Context variables, copyable schema context, generated-JSON
validation, distributed recipe preflight, and copyable feedback for prompt
repair.

Schema compatibility rules for generated recipes live in
`packages/shared-test/rallar-bb-test/docs/schema-compatibility-guide.md`.

## Prompt Rules

Give the AI the schema, a short goal, and hard constraints.

Useful constraints:

- Output JSON only. No Markdown.
- Use `schemaVersion: 1` on distributed manifests and every inline
  `rallar-bb-test` recipe.
- Use stable, descriptive `distributedRunId`, `recipeId`, and `commandId`
  values.
- Use `browser-rallar` assumptions only when the target is live browsers.
- Use `room.*` or `app.*` WS topics. Do not use `rallar.*`, which is reserved
  for system traffic.
- Include `applicationId`, `workspaceId`, `groupId`, and `roomRef` where RTC or
  WS delivery is group-scoped.
- Prefer `targetPolicy.mode: "all-online-group-members"` for whole-group runs,
  or `role-map` when only selected senders should execute a send recipe.
- Include timeouts that match live signaling realities. RTC connect/send
  commands often need longer timeouts than simple health checks.
- Do not put credentials, bearer tokens, or long-lived secrets in generated
  recipes. Use variables or environment setup instead.

After generation, validate the JSON with:

- `validateJsonSchema(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA, value)`
- `validateDistributedRunManifestContract(value)`

For black-box-runner scenarios, validate with:

- `validateBlackBoxRunnerScenarioRecipe(value)`

## Prompt: Distributed RTC Smoke

Use this when you want all online browsers in the same group to connect RTC,
then have one browser send a realtime payload.

```text
You are generating a Rallar black-box distributed run manifest.

Use this schema:
- RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA
- Inline recipes must use RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA commands.

Goal:
- Run against live browser control agents using the browser-rallar provider.
- Target all online members of group bb-group.
- First stage an RTC connect recipe for every online group member.
- Then run an RTC send recipe only from the sender role.
- The send payload should contain messageId, transport, groupId, and sentAtLabel.

Constants:
- applicationId: rallar-server
- workspaceId: default
- groupId: bb-group
- sender agent role: sender

Constraints:
- Output JSON only.
- Use schemaVersion 1.
- Use targetPolicy mode all-online-group-members for the connect manifest.
- For the sender manifest use role-map with role sender.
- Use transport realtime.
- Use connection distributed-rtc.
- Include roomRef on RTC commands.
- Do not include credentials or access tokens.
- Use command timeoutMs 60000 for rtc.connect and rtc.send.
```

## Prompt: Distributed WS And RTC Parity

Use this when you want to compare whether the same JSON payload can move over
WS and RTC in the same group.

```text
Generate two Rallar black-box distributed run manifests as a JSON array.

Use:
- RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA
- Inline rallar-bb-test recipes

Goal:
- Manifest 1 sends a room-scoped WS message from one sender browser.
- Manifest 2 connects RTC for all online group members and sends the same JSON
  payload over realtime RTC from the same sender.
- The payload must include messageId, channel, groupId, and expectedReceivers.

Constants:
- applicationId: rallar-server
- workspaceId: default
- groupId: bb-group
- sender agent id placeholder: agent-alice
- expectedParticipantCount: 3

Constraints:
- Output JSON only.
- Do not use rallar.* topics. Use room.black-box.parity.
- WS recipe command kind must be ws.send.
- WS send data must include typeId, topicId, contextId, roomId, roomRef, and
  payload.
- RTC recipe command kinds must be rtc.connect and rtc.send.
- Use targetPolicy role-map for sender-only send recipes.
- Use targetPolicy all-online-group-members for the RTC connect recipe.
- Add ackTimeoutMs 30000.
```

## Prompt: Distributed Negative Case

Use this when you want the generated test to prove failures are visible and
roll up correctly.

```text
Generate one Rallar black-box distributed run manifest.

Use:
- RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA

Goal:
- Create a negative distributed recipe that should fail when one selected agent
  cannot be matched or does not ACK staging.
- The run should be useful for testing missing target and ACK timeout reporting.

Constants:
- applicationId: rallar-server
- workspaceId: default
- groupId: bb-group
- selected agent ids: agent-alice, agent-missing

Constraints:
- Output JSON only.
- Use targetPolicy mode selected-agents.
- Set expectedParticipantCount to 2.
- Set ackTimeoutMs to 5000.
- Inline recipe should only contain a health command.
- Use required: true.
- Include artifactPolicy that keeps event JSONL, result JSONL, failure bundle,
  and distributed metadata.
```

## Prompt: Looped RTC Realtime

Use this when you want a compact distributed recipe that sends game-style
position updates without generating one command per frame.

```text
Generate one Rallar black-box distributed run manifest.

Use:
- RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA
- Inline recipes must use RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA commands.

Goal:
- Target all online members of group bb-group.
- Connect RTC for each browser agent.
- Run a looped realtime send at 20 Hz for 5 seconds.
- Include frame number, elapsed milliseconds, actor, groupId, and position in
  every payload.

Constants:
- applicationId: rallar-server
- workspaceId: default
- groupId: bb-group
- connection: distributed-rtc
- transport: realtime
- frameCount: 100
- intervalMs: 50

Constraints:
- Output JSON only.
- Use schemaVersion 1.
- Use targetPolicy mode all-online-group-members.
- Use a recipe with rtc.connect, loop, and stats commands.
- The loop command must contain exactly one rtc.send child command.
- Use loop placeholders {loop.index}, {loop.iteration}, and {loop.elapsedMs}.
- Put rateHz, intervalMs, frameCount, and durationSeconds in metadata, not as
  unknown top-level loop fields.
- Optional loop thresholds may use minAchievedRateHz, maxStartDriftMs,
  maxAverageStartDriftMs, maxJitterMs, minSendSuccessRatio, and
  failOnBackpressure.
- Include roomRef on RTC commands.
- Use timeoutMs 60000 for rtc.connect and rtc.send.
- Do not include credentials or access tokens.
```

## Prompt: Parallel WS And RTC Groups

Use this when one browser agent should run bounded concurrent branches, for
example to compare WS and RTC send behavior from the same local runtime.

```text
Generate one rallar-bb-test recipe JSON object.

Use:
- RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA

Goal:
- Run two bounded parallel groups.
- The ws branch sends one group-scoped WebSocket JSON message.
- The rtc branch sends one realtime RTC JSON message.
- After both branches complete, capture stats.

Constants:
- applicationId: rallar-server
- workspaceId: default
- groupId: bb-group
- ws connection: rallarApi
- rtc connection: distributed-rtc
- topic: room.black-box.parallel

Constraints:
- Output JSON only.
- Use recipeId parallel-ws-rtc-smoke.
- Use one top-level parallel command with maxConcurrency 2.
- Inside each group, commands must remain sequential.
- The WS send data must include typeId, topicId, contextId, roomRef, and
  payload.messageId.
- The RTC send must include transport realtime, roomRef, and payload.messageId.
- Do not add Rallar facade method names such as messages.rtc.send or
  realtime.sendJson.
```

## Prompt: Wait And Assert Evidence

Use this when a recipe should prove that local browser-agent evidence was
observed, not merely that a send command returned.

```text
Generate one rallar-bb-test recipe JSON object.

Use:
- RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA

Goal:
- Send one RTC realtime payload.
- Wait until a browser-agent message event is observed for the payload topic.
- Assert that at least one message is present in runtime state.
- Capture stats after the assertion.

Constants:
- connection: distributed-rtc
- groupId: bb-group
- topic: room.black-box.wait-assert

Constraints:
- Output JSON only.
- Use command kinds rtc.send, wait, assert, and stats.
- The wait command must match kind message, transport realtime, payloadPath
  data.topic, equals room.black-box.wait-assert, timeoutMs 15000.
- The assert command must use source state.messages.length, operator gte, and
  expected 1.
- Do not use JavaScript expressions in assert.source.
- Do not embed credentials or tokens.
```

## Prompt: Black-box-runner RTC Scenario

Use this when you want a provider-neutral black-box-runner scenario instead of
a distributed-run manifest.

```text
Generate a black-box-runner scenario recipe.

Use this schema:
- BLACK_BOX_RUNNER_SCENARIO_RECIPE_SCHEMA

Goal:
- Connect two RTC actors to the same room.
- Send one JSON payload from actor A to actor B.
- Assert that actor B receives the same messageId and body.

Constants:
- roomId: bb-group
- messageId: bb-runner-rtc-1

Constraints:
- Output JSON only.
- Use variables for roomId and messageId.
- Define connections for aliceRtc and bobRtc.
- Use provider-neutral steps only.
- Do not use Rallar facade implementation details.
- Include clear step names.
```

## Prompt: Black-box-runner Inline Loop And Pacing

Use this when the output should be a provider-neutral runner scenario with
replayable traffic artifacts.

```text
Generate a black-box-runner scenario recipe.

Use:
- BLACK_BOX_RUNNER_SCENARIO_RECIPE_SCHEMA

Goal:
- Connect two rallar-memory RTC actors in one room.
- Send 20 Hz position frames from Alice to Bob for 2 seconds.
- Assert Bob receives each frame.
- Make the recipe deterministic and runnable without live services.

Constants:
- roomId: bb-memory-loop-room
- frameCount: 40
- rateHz: 20

Constraints:
- Output JSON only.
- Use provider-neutral steps only.
- Use an inline type "loop" step for the repeated sends.
- Use {loop.index}, {loop.iteration}, and {loop.elapsedMs} placeholders.
- Use rateHz on the loop, or intervalMs 50 if rateHz is not accepted by the
  target runner version.
- Include rtc.connect before the loop and rtc.close after it.
- Do not add Rallar facade implementation details.
```

## Prompt: Repair A Generated Recipe

Use this after schema validation fails.

```text
The JSON below failed validation.

Schema:
- RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA

Validation errors:
<paste validation errors here>

JSON:
<paste generated JSON here>

Task:
- Return a corrected JSON document only.
- Preserve the test intent.
- Do not add credentials or secrets.
- Do not use rallar.* WS topics.
- Keep command IDs stable unless the invalid field requires a rename.
```

## Prompt: Add Observability

Use this when the recipe works but lacks useful evidence for a human operator.

```text
Improve this Rallar black-box distributed run manifest for observability.

Schema:
- RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA

JSON:
<paste manifest here>

Task:
- Return JSON only.
- Add labels and descriptions where supported by the schema.
- Add artifactPolicy for event JSONL, result JSONL, failure bundle, and
  distributed metadata.
- Add command metadata that explains role, transport, and expected delivery.
- Do not change the behavior of the test.
```

## Review Checklist

Before running AI-generated JSON against live browsers:

- Validate with JSON Schema.
- Validate distributed-run contract rules.
- Check that target policy matches the intended browser set.
- Check that all live WS topics are `room.*` or `app.*`.
- Check that RTC commands include the intended `roomId`, `roomRef`,
  `applicationId`, and `workspaceId`.
- Check that sends are role-scoped when only one browser should send.
- Check that no secrets are embedded in the JSON.
- Keep the first run small, then scale participant count or payload volume.
