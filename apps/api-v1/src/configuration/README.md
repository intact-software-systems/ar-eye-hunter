# API-v1 operational configuration

This directory is the only owner of API-v1 operational configuration. The process boundary reads
the committed defaults and one exact profile, translates the documented environment allowlist,
loads environment-only secrets, decodes the effective object, and returns one deeply frozen
snapshot. Every runtime consumer receives its required section directly. Consumers do not read the
process environment or add operational defaults.

Configuration is restart-only. Changing a resource or environment variable does not mutate a
running process. The precedence is:

```text
defaults-config.json
  -> selected profile JSON
  -> explicit environment overrides
  -> environment-only secrets
  -> exact decoding and cross-field validation
  -> immutable snapshot
```

The selector is `RALLAR_API_CONFIGURATION_PROFILE`. Absence selects `dev`; the only accepted values
are the exact, case-sensitive strings `dev`, `prod`, `prod-hardened`, and `prod-in-memory`. `prod`
uses production infrastructure with public registration and bundled ordinary users.
`prod-hardened` always enables production hardening, admin-only registration, and disabled static
clients. Hardening is owned only by the selected profile.

## Environment allowlist

The configuration reader recognizes only these operational overrides:

- Profile: `RALLAR_API_CONFIGURATION_PROFILE`.
- HTTP and public URLs: `PORT`, `CORS_ORIGINS`, `RALLAR_API_BASE_URL`,
  `RALLAR_WS_BASE_URL`.
- Database: `RALLAR_SQL_BACKEND`, `RALLAR_PGLITE_DATA_DIR`,
  `RALLAR_PGLITE_SCHEMA_INIT`, `RALLAR_DB_PUBSUB`,
  `RALLAR_BLACK_BOX_PGLITE_SNAPSHOT_DIR`.
- Authentication: `AUTH_REGISTRATION_MODE`, `AUTH_ADMIN_CLIENT_IDS`,
  `AUTH_STATIC_CLIENTS_MODE`, `RALLAR_LOGIN_IP_RATE_LIMIT`,
  `RALLAR_LOGIN_USER_RATE_LIMIT`, `RALLAR_REGISTRATION_IP_RATE_LIMIT`,
  `RALLAR_REGISTRATION_USER_RATE_LIMIT`.
- State API: `RALLAR_STATE_STRICT_READ_AUTH`.
- Group admission: `RALLAR_GROUP_DEFAULT_MAX_MEMBERS`,
  `RALLAR_GROUP_JOIN_ADMISSION_PRINCIPAL_RATE_LIMIT`,
  `RALLAR_GROUP_JOIN_ADMISSION_GROUP_RATE_LIMIT`,
  `RALLAR_GROUP_PRESENCE_CONNECT_PRINCIPAL_RATE_LIMIT`,
  `RALLAR_GROUP_PRESENCE_CONNECT_GROUP_RATE_LIMIT`.
- Topology: `RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT`,
  `RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT`, `RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE`,
  `RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE`, `RALLAR_RTC_TOPOLOGY_MESH_PARAM_K`,
  `RALLAR_RTC_TOPOLOGY_MESH_EXIT_WIDTH`, `RALLAR_RTC_TOPOLOGY_TREE_EXIT_WIDTH`,
  `RALLAR_RTC_TOPOLOGY_RECOMPUTE_DEBOUNCE_MS`,
  `RALLAR_RTC_TOPOLOGY_RTT_REFINEMENT_MIN_INTERVAL_MS`,
  `RALLAR_RTC_TOPOLOGY_RTT_VIVALDI_DELTA_MS`, `RALLAR_RTC_TOPOLOGY_REPLAY`,
  `RALLAR_API_QUEUE_WORKERS`.
- AppInbox and observability: `RALLAR_APP_INBOX_PHASE_TIMING`,
  `RALLAR_APP_INBOX_WAIT_MAX_ELAPSED_MS`, `RALLAR_APP_INBOX_WAIT_RETRY_INTERVAL_MS`,
  `RALLAR_APP_INBOX_WAIT_MAX_RETRY_INTERVAL_MS`, `RALLAR_APP_INBOX_WAIT_JITTER_RATIO`,
  `RALLAR_TIMING_LOGS`.
- ICE: `RALLAR_ICE_MODE`, `RALLAR_ICE_RATE_LIMIT_REQUESTS`, `METERED_APP_NAME`, `METERED_REGION`.
  The request allowance must be a positive integer and overrides `ice.rateLimit.requests`.
  All committed profiles retain 20 requests per 60000ms; cache lifetime remains 300000ms.
- CRDT: `RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON`.
- Black-box token issue: `RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS`,
  `RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS`.

These secrets are read separately and never belong in committed JSON:

- `DATABASE_URL`
- `RALLAR_AUTH_CREDENTIAL_SECRET`
- `METERED_API_KEY`
- `RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET`

Errors and startup summaries report only safe source names, paths, modes, URLs, origins, and applied
override names. They never contain secret values, credential-bearing database URLs, secret lengths,
or derived fingerprints.

Import the specific owner directly. There is deliberately no configuration barrel, fallback
reader, compatibility alias, or legacy profile selector.

The owned memory RTC fixture sets a finite per-principal allowance: standalone governed
retention uses 101 (initial connect plus 100 reconnects), while governed default/all-scenarios
use 20. The supported combined three-case diagnostic uses 106 for Charlie (2 default,
3 all-scenarios, 101 retention); default plus retention uses 103. The fixture rejects
inherited operational overrides without a governed case locator, mismatched budgets and
contradictory case selectors before launching, and requires its own fresh API process.
These fixture values are fingerprinted in B06's existing configuration/source observation.
They do not change the product defaults or make earlier failed artifacts accepted evidence.
