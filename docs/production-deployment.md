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

Apply these settings to the `rallar-kit` and `relic-hunters-v1` Workers
projects:

- Production branch: `main`
- Builds for non-production branches: disabled

For the `ar-eye-hunter` Pages project, keep `main` as the production branch and
set Preview branch to `None` when all Cloudflare checks must be main-only.

Verify the next feature-branch push has no `Workers Builds:*` or `Cloudflare
Pages` check. Do not use commit-message skip directives as a permanent branch
policy.

## Deno Deploy cutover

The Deno GitHub integration creates branch timelines and corresponding GitHub
status contexts. The repository-controlled workflow avoids that behavior by
deploying only from the main-only GitHub Actions workflow.

Before any database migration, the workflow verifies the token and access to
all three applications. Each deployment uploads the repository root so
monorepo imports under `packages/**` are present, then selects the app-specific
`deno.json`. The checked-in `deploy.runtime` configuration fixes the entrypoint
and working directory for each service.

Complete the cutover in this order:

1. Create a least-privilege Deno organization token allowed to deploy the three
   existing applications.
2. Store it as the repository Actions secret `DENO_DEPLOY_TOKEN`. Never put the
   value in a command argument, workflow file, issue, pull request, or log.
3. Disconnect the Deno GitHub integration for:
   - `rallar-server`, sourced from `apps/api-v1`;
   - `rallar-bb-server`, sourced from
     `apps/rallar-black-box-control-server`;
   - `relic-hunters`, sourced from `apps/relic-hunter-server-v1`.
4. Set the repository Actions variable `DENO_DEPLOY_ACTIONS_ENABLED=true`.
5. Manually run **Deploy Web + API** with release-gate skipping disabled.
6. Confirm the preflight recognizes all three applications before any migration
   begins.
7. Verify all three Deno jobs deploy the exact default-branch commit and the
   production health endpoints remain healthy.

If the token is not ready, do not disconnect the integration and do not enable
the variable. If the cutover fails, set `DENO_DEPLOY_ACTIONS_ENABLED=false`
before deciding whether to reconnect the provider integration.

The GitHub-side commands are intentionally interactive for the secret value:

```sh
gh secret set DENO_DEPLOY_TOKEN
gh variable set DENO_DEPLOY_ACTIONS_ENABLED --body true
gh workflow run deploy.yml --ref main -f skip_release_gate=false
```

For rollback, keep the token but disable execution with
`gh variable set DENO_DEPLOY_ACTIONS_ENABLED --body false`.

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
