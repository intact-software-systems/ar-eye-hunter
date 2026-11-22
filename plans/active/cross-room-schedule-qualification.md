## Goal

An authorized member follows court A's program while using court B. Operators can qualify a deadline across two independently hosted Rallar nodes.

## Changes and acceptance

1. Exercise the existing watchSchedule API in two browsers. Keep B selected while the director pauses A. Miss a resume while disconnected and recover its shifted boundary. Remove access and clear the last observation. Observe authorized WebSocket updates and count room reads while idle. Reuse the shared observation path and remove superseded logic.
2. Use two direct API origins with verified distinct peer identities and independent hosts. Sample the clock offset interval under load and check it against an explicit budget. Submit real seat claims around the offer deadline, with expiry on the other host. Check the durable outcome across both nodes and recovery after worker restart. Report inconclusive clock measurements separately from conflicting seat allocations.

## Validation

Start each change with a failing behavioral test. Run the two-browser journey, focused package checks and the qualification fixture. Record topology, load and evidence for any independent-host run. A one-host run verifies the fixture only.

## Risk and rollback

Room access can change while a read or reconnect is pending. Scope and fence observations so old reads cannot restore revoked data. Use disposable qualification rooms and workers for interruption tests.
