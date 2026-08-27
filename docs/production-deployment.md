# Production Deployment and Branch Controls

Production deployments run from `main`. Feature branches use **Branch Release
Gate** for repository validation and must not create Cloudflare or Deno Deploy
contexts. A provider deployment context on a feature branch is configuration
drift, not an additional application release gate.

## Repository workflow

`.github/workflows/deploy.yml` accepts pushes to `main` and explicit manual
dispatches. It never listens to `pull_request` or non-main push events. Every
deployment job also checks that its ref is `refs/heads/main`, so dispatching the
workflow from another ref cannot publish. Deno deployments and the repository's
Cloudflare build checks wait for the shared release gate unless an operator
explicitly uses the manual `skip_release_gate` break-glass input from `main`.

The three Cloudflare-named jobs in this workflow are repository build checks;
they do not publish to Cloudflare. Until a separate authenticated Actions
cutover is implemented, Cloudflare's Git integration publishes `main`
independently and therefore does not wait for this workflow's release gate.
The provider branch controls below enforce branch scope, not release-gate
ordering.

Deno deployment through GitHub Actions is staged behind the repository variable
`DENO_DEPLOY_ACTIONS_ENABLED=true`. Leaving the variable unset or false keeps
the three Deno jobs disabled while the provider Git integration remains in
control. This prevents an incomplete credential migration from breaking a
normal main-branch workflow. Production workflow runs are serialized, and each
Deno job refuses to proceed when its checked-out commit is no longer the remote
`main` tip.

## Cloudflare branch controls

The main-only `cloudflare-branch-controls` job applies and verifies these
settings on every **Deploy Web + API** workflow run. It uses the repository's
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` secrets without printing
their values. The token must be user-scoped and have **Workers Builds
Configuration: Edit**, **Workers Scripts: Read**, and the Pages project edit
permission.

The job reads every expected project before its first mutation. It then removes
the non-production trigger from the `rallar-kit` and `relic-hunters-v1`
Workers, preserves one production trigger restricted to `main`, and configures
the `ar-eye-hunter` Pages project with preview deployments disabled. A missing,
renamed, ambiguous, or unverifiable project fails the job instead of partially
applying a guessed configuration.

The resulting settings for both Workers projects are:

- Production branch: `main`
- Builds for non-production branches: disabled

For the `ar-eye-hunter` Pages project, the production branch is `main` and the
Preview branch setting is `None`.

Verify the next feature-branch push has no `Workers Builds:*` or `Cloudflare
Pages` check. Do not use commit-message skip directives as a permanent branch
policy.

If the enforcement job reports an authorization failure, replace
`CLOUDFLARE_API_TOKEN` with a user-scoped token carrying the permissions above;
do not broaden the workflow or expose the token in diagnostic output.

## Deno Deploy cutover

Every push to a linked GitHub repository starts a Deno build, and each branch
receives its own timeline. The documented application settings do not provide a
global switch that ignores every non-default branch. `[skip deploy]` is useful
for an exceptional commit, but it is not a durable branch policy. Disconnect the
Deno GitHub integration from all three applications to make the main-only
GitHub Actions workflow the only deployment owner. See Deno's documentation for
[applications](https://docs.deno.com/deploy/reference/apps/),
[timelines](https://docs.deno.com/deploy/reference/timelines/), and
[`[skip deploy]`](https://docs.deno.com/deploy/changelog/).

Before any database migration, the workflow verifies the token and access to
all three applications. It then reads redacted Deno Deploy environment metadata
for `rallar-server` and `relic-hunters`. Both production contexts must contain:

- visible `RALLAR_API_CONFIGURATION_PROFILE=prod`;
- visible non-demo `AUTH_ADMIN_CLIENT_IDS` and
  `RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS`;
- visible non-empty `METERED_APP_NAME`;
- platform-secret `RALLAR_AUTH_CREDENTIAL_SECRET`, `METERED_API_KEY`, and
  `RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET`.

The applications still require `DATABASE_URL` at runtime. Deno Deploy
guarantees that value, so the preflight intentionally does not require it to
appear in redacted environment metadata.

The Relic production context must also contain visible
`RELIC_REST_AUTH_MODE=group-policy`. The verifier reports names and policy
failures only; it never prints or uploads the environment listing. Configure
these values in Deno Deploy before enabling Actions deployment.

Each deployment uploads the repository root with this command shape:

```sh
deno deploy . --config deno.json \
  --org intact-software-systems \
  --app <app-name> \
  --prod --json --non-interactive
```

An explicit `--config` controls upload-manifest collection, so source discovery
at the repository-root `deno.json` is required to include workspace members and
imports under `packages/**`. The `--app` argument selects the existing target;
the shared root config deliberately has no `deploy` target. This relies on the
[Deno workspace upload fix](https://github.com/denoland/deno/pull/33562), which
is present in the configured Deno v2 toolchain.

App-level `deno.json` files remain authoritative for local checks and retain
their app names and runtime metadata. Because Actions uploads use the shared
root config, the Deno dashboard provides the runtime configuration for those
uploads. Configure every application as a **Dynamic App** with **No Preset**,
blank install, build, and pre-deploy commands, a five-minute build timeout, and
3 GiB of build memory. Use these path settings:

| App                | App directory | Entrypoint                                         | Runtime working directory |
| ------------------ | ------------- | -------------------------------------------------- | ------------------------- |
| `rallar-server`    | `(root)`      | `apps/api-v1/src/main.ts`                          | Blank                     |
| `rallar-bb-server` | `(root)`      | `apps/rallar-black-box-control-server/src/main.ts` | Blank                     |
| `relic-hunters`    | `(root)`      | `apps/relic-hunter-server-v1/src/main.ts`          | Blank                     |

Complete the cutover in this order:

1. Create a least-privilege Deno organization token allowed to deploy the three
   existing applications.
2. Store it as the repository Actions secret `DENO_DEPLOY_TOKEN`. Never put the
   value in a command argument, workflow file, issue, pull request, or log.
3. Apply the dashboard settings above to all three applications.
4. Record each application's currently active production revision and verify
   its production endpoint.
5. Disconnect the Deno GitHub integration from all three applications. Confirm
   that disconnecting does not remove or replace the recorded active revisions.
6. Set the repository Actions variable `DENO_DEPLOY_ACTIONS_ENABLED=true`.
7. Manually run **Deploy Web + API** with release-gate skipping disabled.
8. Confirm the preflight recognizes all three applications before any migration
   begins.
9. Verify all three Deno jobs deploy the exact default-branch commit and the
   production health endpoints remain healthy.

The GitHub-side commands are intentionally interactive for the secret value:

```sh
gh secret set DENO_DEPLOY_TOKEN
gh variable set DENO_DEPLOY_ACTIONS_ENABLED --body true
gh workflow run deploy.yml --ref main -f skip_release_gate=false
```

If a corrected CLI deployment fails, immediately set
`DENO_DEPLOY_ACTIONS_ENABLED=false`; the previously active production revisions
remain available. Keep the token, and disable execution with:

```sh
gh variable set DENO_DEPLOY_ACTIONS_ENABLED --body false
```

Reconnect the affected application's GitHub repository and use **Deploy Default
Branch** only when a provider-managed replacement deployment is required.

## Human verification

After changing provider settings:

1. Push a feature-branch commit and inspect its pull request checks. It should
   have **Branch Release Gate** but no Cloudflare Worker, Cloudflare Pages, or
   `deploy/intact-software-systems/*` context.
2. Merge only after Branch Release Gate passes.
3. Confirm the resulting `main` commit runs **Deploy Web + API** and that all
   enabled production deployments refer to that exact commit SHA.

Absent provider contexts on a feature branch are expected. Provider contexts
on a feature branch mean the branch controls have regressed.
