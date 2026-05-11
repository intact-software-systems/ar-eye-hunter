# Tasks to do

## IndexedDB: ar-eye-hunter-al-runtime.entries

It looks like this table grows indefinitely. Investigate if evictions are being done.

Is there a risk that we read expired data or data belonging to a different login session?


## Web RTC signaling and connection phase

Rallar should expose API to wait for RTC connections to be established before proceeding with further operations.

Also, Rallar should expose APIs with status of the connections, disconnections, etc.

WS connection API should be symmetric with RTC connection API, if possible.

We need to speed up RTC connection establishment.

We need to investigate if there are any potential issues with the signaling phase, such as timeouts or retries.

We should also consider implementing a mechanism to handle connection failures and retries to ensure a smooth user experience.

We should also explore the possibility of implementing a connection timeout mechanism to prevent indefinite waiting for connections.

We should also investigate the impact of network conditions on RTC connection establishment and consider implementing adaptive strategies to handle varying network conditions.



