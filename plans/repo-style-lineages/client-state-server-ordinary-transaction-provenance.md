# Client-State Ordinary Transaction Provenance

Task 4B starts from the accepted PR B base
`2fdba024bb347622727d337eb06fc13d2fe129fc`. The accompanying machine manifest
maps each canonical owner to exactly one predecessor and forbids duplicate
targets. It supplies navigation provenance only: new composition glue, named
ports, and private after-commit projection code receive no inherited style
allowance.

## Source owners

- `services/client-state-service.ts@aa6c2483db49bfc2c819e14c37d64197a51064c7`
  moved public service contracts, composition, timing, stable mutation reads,
  and ordered mutation writes into their named canonical owners.
- `services/AppClientInboxService.ts@8f5d371f3693e135e17beeeef4781aba19c93a23`
  moved the exact payload contracts, authenticated ingress checks, callback
  registration/public shell, and transaction-selection control flow.
- `services/authorised-ws-client-app-inbox.ts@490c3d4c3050ee3adf21a2b680aa4376357c3989`
  moved the WebSocket enqueue translation unchanged.

The Task 4B lineage test checks the exact base blobs, ordered target inventory,
file existence, and target uniqueness. It is supplementary to the semantic
transaction, routing, constructor-identity, and navigation tests.

The authorised-WS helper is a direct Git-detected move from
`packages/shared-server/rallar-system/services/authorised-ws-client-app-inbox.ts`
to
`packages/shared-server/rallar-system/client-state/inbox/authorised-ws-client-app-inbox.ts`.
Its exact source blob is `490c3d4c3050ee3adf21a2b680aa4376357c3989` at Task
4A base. It is intentionally outside the structural-lineage manifest because
the changed-style gate already owns its move capacity through Git rename
detection.
