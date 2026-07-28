# Hetzner Preparation And Human Diagnostics

Status: Implementation in progress on
`codex/hetzner-preparation-diagnostics`. Local focused verification is current;
the full repository, branch, and default-branch Hetzner gates remain required.

## Goal

Prepare and verify the Hetzner controller once per supported commit, reuse that
deployment for the serial manifest suite, isolate unrelated apt repositories,
preserve the active browser until a candidate passes launch verification, and
publish deterministic diagnostics that a human can interpret without AI.

## Implementation

- [x] Split the supported workflow into one preparation job and a run-only
      serial manifest matrix.
- [x] Add exact deployment-readiness stamping and run-only validation.
- [x] Check Playwright dependencies before apt and isolate missing dependency
      installation to official Ubuntu sources.
- [x] Install browsers into a versioned candidate and switch the active path
      only after a real headless launch.
- [x] Add mandatory JSON operation reports, human-readable summaries, sanitized
      evidence, GitHub annotations, and always-uploaded diagnostics artifacts.
- [x] Update the controller runbook and Hetzner agent guidance.
- [ ] Pass final `npm run test:unit`, `npm run test:ci`, and `npm run build` on
      the unchanged final working tree.
- [ ] Publish the final feature commit and pass Branch Release Gate on its exact
      SHA.
- [ ] Integrate through review and pass Run Hetzner Supported Distributed
      Manifests on the resulting exact default-branch SHA.

## Current Verification

- Starting baseline: focused Hetzner workflow suite, 66 tests passed.
- TDD red run: seven expected failures proved prepare-once, diagnostics,
  dependency isolation, and readiness behavior were absent.
- Current focused Hetzner workflow run: 78 tests passed.
- Additional red/green cases cover operation classification, complete readiness
  mismatches, replacement of a pre-existing invalid browser version, and
  rejection of topology-specific manifests from the shared preparation cohort.
