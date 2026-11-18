# Calibrated room presence and reconnect

A player who has selected a room should recover that selection after a socket interruption. The restored presence must belong to the current session and connection generation, and the latest plausible server time must still precede its expiry. This is the next transport slice in the [shared-time product plan](rallar-shared-time.md). [Recovery qualification](https://github.com/intact-software-systems/ar-eye-hunter/issues/836)

## 1. Stamp and renew a bounded room lease

Trace create, join, quick join, invite acceptance, move and heartbeat through the shared browser room workflows. Use the acquired connection’s earliest server epoch for the existing absolute lease request. Keep each retry of the same mutation bound to its original expiry. Use the latest bound when evaluating a returned lease. Cache retention and retry delays belong to their local timer domains.

The existing HTTP mutation, idempotent replay and persisted presence contracts carry absolute expiry. Retain that contract for this slice. A duration-based server grant would require specifying which instant binds a retried request and how existing clients interoperate. Compare the returned authoritative row and its generations before declaring arrival.

## 2. Restore the selected room after authority loss

Use the live connection window for snapshot observation, point reads, reconnect writes and their confirmations. Refuse expired or unavailable authority and fence work against socket and session replacement after awaits. Keep the selection as user intent. Trace checkpoint flush and reservation release after closure and exercise the existing cleanup path independently of new-work authorization.

## Qualification

Exercise browser time ahead and behind with a lease that straddles the device and server clocks. Check equality at expiry, a lost write receipt, a changed generation and unavailable calibration. Run affected room, heartbeat and checkpoint suites, workspace type checks and the browser bundle boundary. Overlay the candidate on the Grumpy Town consumer and run its clock-skew, normal room, host-loss and round/rematch cases. Record the first observable failing boundary. Physical-device background return and cluster clock accuracy require separate deployment evidence.
