# RTC Performance Observation Stream Design

Date: 2026-08-27

## Goal

Turn RTC performance measurement from a one-time, frozen-main baseline exercise
into an append-only stream of independently valid observations. Begin with
`RTC-B05` native Chromium lifecycle evidence, run it nightly on GitHub Actions,
allow manual dispatches, and publish one timestamped ZIP per workflow run to
`main` through an automatically merged observation-only pull request.

The stream answers “what did this workload do in this environment at this
time?” It does not claim that any observation is the final or permanently
latest representation of `main`.

## Design Principles

1. **Observe; do not pin.** A workflow records the source commit and tree it
   checked out. Movement on `main` before, during, or after the run neither
   cancels nor invalidates the observation.
2. **Append; do not replace.** Every scheduled or manual run receives a unique
   observation identity. Successful, failed, and incomplete captures remain
   distinguishable immutable entries in the stream.
3. **Reuse the existing owner.** Extend the package-owned RTC baseline
   controller, evidence contracts, browser producer, validation, and current
   GitHub validation/publication patterns. Do not create a second capture,
   evidence, gate-selection, or pull-request delivery subsystem.
4. **Correctness precedes metrics.** A successful observation still requires
   every existing `RTC-B05` lifecycle assertion. A failed correctness or
   producer result is archived as a failed observation and contributes no
   accepted performance conclusion.
5. **Observation publication is not a product release.** An archive-only pull
   request runs a small integrity gate. Product builds, tests, deployments, and
   default-branch release work do not run for changes confined to the approved
   observation paths.

## Observation Identity

The existing baseline identity embeds only a UTC date, twelve-character source
SHA, and environment, with a controlled `-repeat-01` suffix. That grammar
cannot represent multiple independent observations of the same commit on the
same day. Waiting for another commit or date is incompatible with a stream.

Evolve the existing identity contract instead of wrapping it in a parallel
identifier. A primary observation uses:

```text
YYYYMMDDTHHMMSSZ-<source-sha12>-e2-browser-gh<run-id>-a<run-attempt>
```

The controlled statistical repeat retains the existing relationship by
appending `-repeat-01` to that exact primary identity. The GitHub run ID and run
attempt make reruns distinct without treating them as statistical repeats.
Existing accepted legacy identities remain readable so historical evidence
does not require migration. New stream publication always uses the timestamped
form.

The environment record remains authoritative for the full source commit/tree,
branch/ref, cleanliness, runtime/browser versions, host characteristics,
configuration hashes, command projection, and timing. The source SHA in the
identity is a compact locator, not a freshness gate.

## Scheduled Capture Flow

Add one RTC performance observation workflow with:

- one nightly UTC cron;
- `workflow_dispatch` for an additional operator-requested observation;
- a concurrency policy that permits no overlapping `RTC-B05` captures but does
  not cancel an already running observation when a new event arrives; and
- read-only repository permissions during measurement, with publication
  permission limited to the later pull-request step.

Measurement and publication are separate jobs. The measurement job cannot
write repository or pull-request state. The publication job receives only the
completed ZIP and canonical index row and holds the narrow credential needed
to create/update its observation branch and pull request.

The job checks out the `main` snapshot selected by GitHub when the workflow
starts. It does not fetch a newer `main` or compare the checked-out commit with
the remote after capture begins.

The job extends the existing package-owned command flow:

1. install the repository dependencies and supported Chromium runtime;
2. run the focused non-capture checks needed to reject broken measurement
   tooling;
3. initialize an `E2-browser` primary observation for `RTC-B05`;
4. enumerate the manifest-owned external attempts;
5. run one warmup and five retained fresh Chromium processes using the exact
   lowercase, zero-padded raw paths accepted by the existing validator;
6. record each producer result through the existing `record-browser` command;
7. finalize and validate the complete evidence;
8. run the existing `repeat-required` decision and, only when selected, capture
   the one-warmup/ten-retained `-repeat-01` observation; and
9. package the complete primary, optional repeat, and stream entry into one
   timestamped ZIP.

Capture or validation failure does not cause replacement. The job finishes the
fail-closed accounting already owned by the baseline controller and packages
the failed result. The stream entry states whether the primary was `passed`,
`failed`, or `incomplete`, whether a repeat was selected and completed, and why
no metrics are accepted when correctness failed.

## Repository Archive Layout

Observation pull requests modify only:

```text
performance-observations/rtc-b05/YYYY/MM/DD/<observation-id>.zip
performance-observations/rtc-b05/index.jsonl
```

Each ZIP is create-new and contains:

- the finalized primary evidence directory;
- the finalized repeat evidence directory when a repeat was selected;
- one canonical observation entry; and
- checksums covering every archived file.

`index.jsonl` is append-only. Each canonical row contains the observation ID,
start/end timestamps, source commit/tree, GitHub workflow run/attempt/URL,
capture and validation outcomes, repeat decision, archive relative path,
archive byte length, and archive SHA-256. The row contains no secret values.

Archive generation and verification belong to the existing RTC baseline
package because that package owns the evidence schemas and validity rules. The
workflow orchestrates those package commands; it does not reproduce the
contract in shell or YAML.

## Pull-Request Publication

After packaging, the workflow creates a short-lived branch from the current
`main`, adds exactly one new ZIP and one new index row, and opens an
observation-only pull request. If `main` advanced after measurement, the pull
request still publishes the recorded observation of its earlier source state.
The publication branch may be refreshed for a real merge conflict, but the
evidence is never recaptured or relabeled.

The pull request automatically merges after its observation integrity gate
passes. Publication failure also uploads the ZIP through the repository's
existing GitHub artifact pattern so the result can be recovered without
altering or regenerating evidence.

Publication must use the repository's existing authenticated automation path
that causes ordinary pull-request checks to run. It may not rely on a token
whose events suppress the integrity workflow, bypass branch protection, or
push the archive directly to `main`.

The publisher must be idempotent for one GitHub run attempt. Re-execution finds
the same archive/index identity and either resumes its existing pull request or
reports that it is already present; it never adds a duplicate row or overwrites
another archive.

## Observation-Only Validation And Build Suppression

Extend the existing changed-path validation selection rather than introduce a
side-by-side classifier. An observation-only change is one in which every
changed path is under `performance-observations/rtc-b05/**` and the change
contains exactly one create-new ZIP plus one appended canonical index row.

The lightweight gate verifies:

- only the allowed paths changed;
- the ZIP filename, contained observation entry, and index row identify the
  same observation;
- the ZIP is create-new and the index change is append-only;
- byte length and SHA-256 match the index;
- all contained checksums pass;
- the contained finalized evidence is structurally readable; and
- the declared capture/validation outcome agrees with the evidence. A failed
  performance observation can pass this publication-integrity gate.

For an observation-only pull request, required umbrella checks complete through
that integrity gate while product test/build/deploy jobs are explicitly not
selected. Workflows triggered by pushes to `main` ignore changes confined to
`performance-observations/**`, so merging an observation never launches a
product build or deployment. Changes to the observation tooling, workflow,
validator, plan, or any other repository path continue to run normal affected
validation.

## Error Handling

- **Tooling precheck failure:** publish a diagnostic workflow artifact but do
  not create a stream ZIP, because no trustworthy observation was initialized.
- **Initialized capture failure:** finalize fail-closed accounting and publish
  a failed stream ZIP.
- **Repeat failure:** preserve the valid primary and failed repeat together;
  the stream entry reports the repeat as failed and does not silently fall back
  to the primary for a comparison that required the repeat.
- **Archive integrity failure:** do not open or merge a publication pull
  request; upload recoverable diagnostics.
- **Publication conflict or transient GitHub failure:** retry publication from
  current `main` without rerunning the measurement.
- **Duplicate workflow delivery:** resume or report the existing identity;
  never create another archive for the same run attempt.

## Plan Semantics

Update the active RTC performance plan so Task 9 no longer waits for a frozen
Task 7 anchor, an exact-main deploy envelope, a new commit, or a later date.
Task 9 becomes delivery of the scheduled observation stream plus the first
valid archived `RTC-B05` observation. The first observation proves that the
stream works; it is not the final performance measurement.

Later B06 activation and optimization decisions consume explicitly selected
valid observations or a declared time window. A newer `main` commit does not
invalidate older evidence; it only supplies context for later observations.

## Validation

Implementation requires:

- focused red/green tests for the evolved identity grammar, legacy identity
  readability, run-attempt uniqueness, repeat linkage, archive/index creation,
  append-only enforcement, checksum verification, and failed-observation
  publication;
- focused `RTC-B05` producer/bridge tests using the canonical raw paths;
- workflow and changed-path selection tests proving archive-only changes choose
  the integrity gate and do not choose product builds or deployments;
- the complete `@ar-eye-hunter/shared-rtc-bench` package check;
- repository style and changed-file checks for every touched human-authored
  file;
- one local browser observation proving the exact capture command reaches
  Chromium and produces valid finalized evidence; and
- pull-request CI proving ordinary tooling changes still receive the normal
  affected gates. The scheduled workflow is then manually dispatched from
  `main` after merge to create the first repository observation PR.

## Scope Boundaries

This slice implements the `RTC-B05` stream only. It does not add a dashboard,
external time-series database, alerting thresholds, retention pruning, Git LFS,
or automatic optimization selection. It does not activate `RTC-B06` or
`RTC-B07`. Those capabilities may consume the observation stream later without
changing its append-only identity and publication contract.
