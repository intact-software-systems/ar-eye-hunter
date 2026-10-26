# Browser console API origin

Before rolling out the generic API profiles, explicitly include
`https://blackbox.rallar.intactss.com` in the API deployment's comma-separated
`CORS_ORIGINS` allowlist when that console is authorized to use the API. Include
all other verified browser origins in the same deployment value. Production API
profiles no longer contain deployed application origins; an empty allowlist
permits no cross-origin access, and hardened startup requires a nonempty HTTPS
allowlist. No live configuration change is performed by updating this document.
