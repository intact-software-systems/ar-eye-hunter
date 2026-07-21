# RTC Topology Fallback Precedence Remediation Plan

> Approved by the user's instruction to apply the proposed topology-precedence
> fix and rerun iteratively on the same PR.

## Task 1: Lock the causal ordering with tests

Add repository tests covering:

- a newer group-revision fallback replacing an older authoritative topology;
- an authoritative topology replacing a same-revision fallback even when its
  own version is numerically lower;
- a delayed same-revision fallback remaining stale;
- normal version ordering within one provenance.

Run the focused test before implementation and confirm the new assertion fails
for the version-domain collision.

## Task 2: Implement explicit provenance ordering

Add `OverlayInfo.provenance`, set it in both production constructors, and order
the repository tuple by group revision, provenance rank, then overlay version.
Update affected fixtures and assertions. Run focused repository and browser
cache tests, then the relevant shared/shared-web regression set and typechecks.

## Task 3: Publish the iteration

Commit and push to `codex/rtc-signaling-boundary-diagnostics`. Because no PR
currently exists for the branch, create a draft PR and keep all later commits
and reruns on that PR.

## Task 4: Unchanged remote rerun and analysis

Dispatch `github-free-distributed-recipe.yml` with the same 15-agent manifest
and settings as diagnostic run `29677707780`. Download artifacts, run the RTC
trace analyzer, and compare:

- accepted/rejected topology sequences and final topology;
- peer creations, cleanup, establishment timeout, and lane-open counts;
- recipe/fleet outcome;
- create-to-send, websocket/server, dispatch, and end-to-end signaling timing.

## Task 5: Conditional next iteration

If the first fix is insufficient, select only the next bottleneck demonstrated
by the new artifacts, add a failing test, implement the smallest correction,
validate, push to the same PR, and rerun the unchanged recipe. Use no more than
five new remote reruns in total.
