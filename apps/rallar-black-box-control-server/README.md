# Rallar black-box control server

The Deno service that queues commands for browser black-box agents, dispatches them over WebSocket, keeps each
run's results, events, stats, reports and heartbeats, judges distributed runs and exports their artifacts. Its HTTP
surface is documented by the server itself at `/swagger-ui`; the agent protocol lives in
`packages/shared-test/rallar-bb-test/control-protocol.ts`.

```sh
cd apps/rallar-black-box-control-server
deno task check    # src/main.ts and test/
deno task test
```

The hosted controller's deployment, environment and operating runbook are in
`scripts/hosted-rallar/controller/README.md`.

## Control Server Memory

The server keeps its live runs in the heap and persists them to `control-snapshot.json` under
`RALLAR_BLACK_BOX_STORAGE_DIR` on a bounded cadence (`RALLAR_BLACK_BOX_SNAPSHOT_FLUSH_INTERVAL_MS`, two seconds by
default, ten on the hosted controller), at once when a distributed run changes state, and on stop. Revision-based
change detection skips a flush whose content did not move; the write streams in one-megabyte slices so agent frames
are handled between slices. Each flush logs a `rallar.timing` line with `operation` `snapshot.flush` (`bytes`,
`serializeMs`, `writeMs`).

## Snapshot startup and recovery

When storage is configured, the server restores `control-snapshot.json` before starting HTTP,
completion work or deadline sweeps. A genuinely absent snapshot starts a new store. An existing
snapshot that cannot be read, parsed, decoded or applied refuses startup with a non-zero exit and
`Could not restore control snapshot from <path>: <cause>`. A dangling snapshot symlink is an error,
not an absent snapshot. The failed process does not rewrite the snapshot, run retention, or remove
its artifact files. Deployment health checks consequently fail instead of accepting an empty history.

For recovery:

1. Stop the control service and preserve a copy of the entire storage directory, including the
   rejected snapshot and `runs/`. Diagnose the reported cause before modifying anything.
2. Repair access or restore a known valid snapshot and its corresponding artifacts from backup.
   Keep the rejected bytes separately for investigation. The server does not strip fields, skip
   rejected rows, convert older formats, or reconstruct the index from loose artifacts.
3. Restart, verify the expected runs and their artifact exports, then verify that new activity
   persists and survives another restart. A healthy new run alone does not prove historical recovery.

Starting with a new empty storage directory is an explicit operator decision, not automatic recovery;
it does not restore the retained history. Keep the original directory intact. Restoring a backup
may omit activity newer than that backup; inventory that gap before declaring recovery complete.

## Completed run storage

A run's rows leave the live snapshot once the run is **completed**: every distributed run it hosts is terminal,
every agent has disconnected, and nothing changed it for `quietMs` (five seconds). The completion sweep
(`control-run-completion.ts`, one pass per second) then:

1. writes the run's every row, unbounded, as a `ControlRunSnapshot` to
   `runs/<run directory>/control-run.json` beside the recorder's `results.jsonl` and `events.jsonl`, through a
   temporary file and a rename, logging `operation` `run.completion` (`runId`, `bytes`, `serializeMs`, `writeMs`);
2. replaces the run's rows in memory by its index entry: the run id, timestamps, the agents with their counters, and
   `completion` (`completedAtEpochMs`, the `retentionRevision` the file was written from, per-collection `counts`,
   and the `file` reference with its `state`);
3. asks for a snapshot flush, so the persisted snapshot carries the index entry and not the rows.

Only the active runs are serialised on every flush after that. Reads do not change: `GET /runs` lists every run,
completed runs with empty collections and their `completion` entry; `GET /runs/{runId}`, the artifact bundle, the
per-file artifacts, the failure bundle, the JSONL fallbacks and the distributed-run bundle serve a completed run from
its file, bounded like a live read. A completed run refuses new envelopes (a register for it closes the socket with
code 1008), commands (`409`, `run-completed`) and distributed runs; use a new run id.

Failure modes, each covered by `test/control-run-completion.test.ts`:

- **The process dies between the terminal transition and the file write, or before the index is flushed.** The
  snapshot on disk still holds the run live with its rows; restore brings it back live and the next sweep writes
  the file again. A run is never lost.
- **An export during the hand-over.** The route reads the run from memory until the moment the rows are replaced,
  and from the file after it; the file is complete before the rows are replaced.
- **The file write fails.** The run stays live and in every flush; the sweep retries after a backoff (five seconds,
  doubling to one minute) and warns on each failure.
- **The file is missing for an indexed run** (after a restart or while the server runs). The index entry reports
  `file.state: "missing"` in `GET /runs`, the run's reads answer `410`, and every other run is served.

Retention (`RALLAR_BLACK_BOX_RETENTION_MAX_RUNS`, the admin cleanup routes, `DELETE /runs/{runId}`) deletes a run's
directory with its index entry, the completed file included; `POST /runs/{runId}/reset` makes a completed run live
and empty again and deletes its directory.

When the service stops answering, confirm whether it ran out of memory before changing code: look for
`Reached heap limit` or `JavaScript heap out of memory` in its log, and read the `snapshot.flush` lines. A flush of
tens of megabytes every few seconds means a large active run, not retained history; the retained runs cost one
`run.completion` write each.
