# Durable room deadlines

A host can publish a named UTC deadline for an active room. Another authorized
editor can extend the same deadline if the revision still matches. A participant
can leave and read the winning revision after the API restarts.

1. Extend the scoped group update through its existing AppInbox transaction.
   Active owners and admins can create at expected revision zero or extend a
   future deadline. Group writes preserve deadlines through other changes.
   Test stale and competing writes, unauthorized edits, request replay, room
   isolation and recovery from PostgreSQL after restarting the writer.
2. Expose explicit-room reads and writes in the browser SDK. Make the poll host
   publish its closing time through the SDK and make ballot acceptance use the
   persisted deadline. The poll continues to own opening time, ballots and results.

The acceptance proof combines a real PostgreSQL restart and two competing API
writers with SDK tests and the two-browser poll journey. No timer or scheduled
side effect is required to store an instant.
