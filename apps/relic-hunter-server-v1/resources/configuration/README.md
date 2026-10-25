# Relic server deployment configuration

Before rolling out the consumer-owned composition, set
`RALLAR_ROOM_OWNED_APP_DATA_BINDINGS_JSON` on **every API and Relic process sharing
the database** to the same complete JSON array. The checked-in
[room-owned-app-data-bindings.json](./room-owned-app-data-bindings.json) contains
the existing Relic save identity. Include any other applications’ room-owned
stores in that same array; it is not a per-process supplement.

Omitted catalogs fail startup before opening database resources or starting
retention. `[]` explicitly asserts that a database contains no room-owned stores;
Relic rejects it and any catalog without its exact binding. This configuration
contract does not provide runtime consensus or detect mismatched processes.
Stored save namespace, store and room keys remain unchanged, with no migration
or backfill. Seven-day retention commits room retirement and observed save CAS
deletes in one transaction.

Set `CORS_ORIGINS` to the complete allowed browser-origin list for the deployment.
The production Relic browser origin is
`https://relic-hunters-v1.intact-software-systems.workers.dev`; local browser tests
use `http://localhost:5175`. API-v1’s generic profile no longer includes the
Relic production origin. Relic deployment must supply it explicitly along with
other verified allowed origins. No live configuration was changed by this work.
