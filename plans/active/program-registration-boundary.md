## Goal

Let an organizer close a managed room's registration when a named phase starts in an existing room program. A program pause suspends the pending cutoff. Resume moves it with the program. An already issued seat offer keeps its own deadline.

## Changes

1. Write a failing public API journey using three PostgreSQL-backed Rallar nodes. Issue an offer, keep another player waiting, bind a future phase, pause across its original start, resume, and disconnect everyone. Observe the waiting commitment released by the worker and the original offer still claimable. Exercise retry and restart to verify one effective closure.
2. Add the shared binding and browser SDK operation, then connect schedule publication, pause and resume to the existing registration authority. Use the current registration and program revisions when binding. Resolve the named phase uniquely. Reject edits that would silently orphan an open binding. Persist the room update, effective cutoff and durable deadline in the existing mutation transaction. Reuse the existing WebSocket notifications and deadline worker. Exercise authorization, stale deliveries, revisions, elapsed phases, fixed UTC cutoffs, and browser recovery in focused tests. Verify the three-node journey and package contracts before handoff.

## Acceptance

A returned participant can read which program and phase control registration. A future bound phase in a paused program has no effective UTC cutoff. At the shifted instant the server closes registration with nobody in the room. A duplicate or obsolete wake has no second effect. New applicants are refused, while previously offered players retain their original claim deadline.

## Validation

Use failing tests followed by focused shared, server and browser SDK tests, OpenAPI validation, the PostgreSQL black-box proof, type checks and browser bundle budgets. Record results here.

## Risk and rollback

The highest risk is a race between an old timer and a schedule change. The same room and lobby predecessors must fence both. Keep the organizer's choice of a fixed UTC cutoff available independently.

## Follow-up

Built on #881. Additional kinds of program-triggered actions need separate product decisions.
