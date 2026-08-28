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
  `RALLAR_LOGIN_USER_RATE_LIMIT`.
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
  `RALLAR_RTC_TOPOLOGY_RTT_REBUILD_DEBOUNCE_MS`,
  `RALLAR_RTC_TOPOLOGY_RECOMPUTE_DEBOUNCE_MS`,
  `RALLAR_RTC_TOPOLOGY_GLOBAL_GRAPH_RECOMPUTE_WINDOW_MS`,
  `RALLAR_RTC_TOPOLOGY_GLOBAL_GRAPH_RECOMPUTES_PER_WINDOW`,
  `RALLAR_RTC_TOPOLOGY_RTT_REFINEMENT_MIN_INTERVAL_MS`,
  `RALLAR_RTC_TOPOLOGY_RTT_VIVALDI_DELTA_MS`, `RALLAR_RTC_TOPOLOGY_REPLAY`,
  `RALLAR_API_QUEUE_WORKERS`.
- AppInbox and observability: `RALLAR_APP_INBOX_PHASE_TIMING`,
  `RALLAR_APP_INBOX_WAIT_MAX_ELAPSED_MS`, `RALLAR_APP_INBOX_WAIT_RETRY_INTERVAL_MS`,
  `RALLAR_APP_INBOX_WAIT_MAX_RETRY_INTERVAL_MS`, `RALLAR_APP_INBOX_WAIT_JITTER_RATIO`,
  `RALLAR_TIMING_LOGS`.
- ICE: `RALLAR_ICE_MODE`, `METERED_APP_NAME`, `METERED_REGION`.
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
