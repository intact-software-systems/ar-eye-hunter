# Production Deployment and Branch Controls

Production deployments run from `main`. Feature branches use **Branch Release
Gate** for repository validation and must not create Cloudflare contexts. A
provider deployment context on a feature branch is configuration drift, not an
additional application release gate.

Server hosting is on Hetzner across three controller VMs; the API, control, and
game servers are rolled out with the **Deploy Hetzner Controller** workflow.
Frontends are published by Cloudflare's Git integration.

## Repository workflow

`.github/workflows/deploy.yml` accepts pushes to `main` and explicit manual
dispatches. It never listens to `pull_request` or non-main push events. Every
main push is validated by the shared release gate unless an operator explicitly
uses the manual `skip_release_gate` break-glass input from `main`.

This workflow has no Cloudflare job. The release gate's "Build deployable apps"
step builds the three Cloudflare web apps as the repository build check.
Cloudflare's Git integration publishes them when `main` moves: Pages for
`ar-eye-hunter`, Workers Builds for `rallar-kit` and `relic-hunters-v1`. Until a
separate authenticated Actions cutover is implemented, those publishes do not
wait for the release gate. The provider branch controls below enforce branch
scope, not release-gate ordering.

The API, control, and game servers are hosted on Hetzner. The
**Deploy Hetzner Controller** workflow rolls each server out over SSH from a
reviewed commit; see
[`scripts/hosted-rallar/controller/README.md`](../scripts/hosted-rallar/controller/README.md).

## Cloudflare branch controls

The `cloudflare-branch-controls` job in **Deploy Web + API** is disabled
(`if: ${{ false }}`) while Cloudflare is configured by hand for `main` only.
Apply and verify the settings below in the Cloudflare dashboard. The job and
`scripts/deploy/configure-cloudflare-main-only.mjs --apply` remain the automated
path once the job is re-enabled. The script reads `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` without printing their values. The token must be
user-scoped and have **Workers Builds Configuration: Edit**, **Workers Scripts:
Read**, and the Pages project edit permission.

The script reads every expected project before its first mutation. It then
removes the non-production trigger from the `rallar-kit` and `relic-hunters-v1`
Workers, preserves one production trigger restricted to `main`, and configures
the `ar-eye-hunter` Pages project with preview deployments disabled. A missing,
renamed, ambiguous, or unverifiable project fails the run instead of partially
applying a guessed configuration.

The resulting settings for both Workers projects are:

- Production branch: `main`
- Builds for non-production branches: disabled

For the `ar-eye-hunter` Pages project, the production branch is `main` and the
Preview branch setting is `None`.

Verify the next feature-branch push has no `Workers Builds:*` or `Cloudflare
Pages` check. Do not use commit-message skip directives as a permanent branch
policy.

If the script reports an authorization failure, replace
`CLOUDFLARE_API_TOKEN` with a user-scoped token carrying the permissions above;
do not broaden the workflow or expose the token in diagnostic output.

## Human verification

After changing provider settings:

1. Push a feature-branch commit and inspect its pull request checks. It should
   have **Branch Release Gate** but no Cloudflare Worker or Cloudflare Pages
   context.
2. Merge only after Branch Release Gate passes.
3. Confirm the resulting `main` commit runs **Deploy Web + API** and its release
   gate, and roll the servers out on Hetzner from that exact commit SHA.

Absent provider contexts on a feature branch are expected. Provider contexts
on a feature branch mean the branch controls have regressed.
