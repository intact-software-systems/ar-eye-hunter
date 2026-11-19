# Shared deadline poll

Run the example from the repository root with Chromium installed. Add
`--headed` to watch both participants.

```sh
npm run test:rallar:full-stack:memory -- --grep 'delayed ballot' --workers=1
```

The journey starts the Rallar memory API, signs in two room participants and
opens a Yes/No poll with device clocks two minutes ahead and behind. The pages
display the same UTC opening and closing times. The fixture's poll authority runs
two seconds behind the calibration API. The app mounts the poll with
`authority: { maxAuthorityOffsetMs: 2_000 }`, the maintained absolute bound
for this fixture. At both boundaries the journey checks that voting is disabled
during uncertainty even when comparing against the sampled node alone would
allow voting. Configure this value from the deployment's clock guarantee.
Omitting it uses the sampled node's window directly.

The question preview gives way to voting once the clock bounds place the client inside the voting window. An uncertain boundary disables voting until the client can resolve the phase. The first Yes request is dropped before receipt. The browser reads the participant’s snapshot, offers Retry Yes, and the participant retries. The authority accepts that ballot, but its response is lost. A second snapshot read confirms one Yes without another submission. The other participant
clicks No while open, but the journey holds that HTTP request until voting
closes. A fresh browser first opens the poll after closing and reads the results directly. Reloading the delayed voter’s page shows the original cutoff, one Yes, zero No and
the authority's late disposition.

[PollAuthority](./poll-authority.ts) owns one room's closing instant, tally and
first decision for each participant. Its synchronous receipt check counts a
first ballot from the opening instant up to, and excluding, the cutoff. An attempt during preview leaves the participant free to vote later. A retry returns the retained decision and
the latest tally. This example keeps the poll in one server process. Restarting
that process ends the poll.

[showPoll](./show-poll.ts) connects the authenticated Rallar client, enters the
scoped room, fetches its poll record and renders the deadline using
`rallar.compareDeadline`. Call it again on page load. Each vote response refreshes the displayed tally. At closure a mounted spectator reads again until the authority confirms the final tally, retrying a failed read after two seconds. The browser journey interrupts this read once. A snapshot already marked closed can display results immediately. The cleanup function cancels pending requests and releases the display timer
when the host unmounts the view.

The [Playwright journey](../../tests/playwright/rallar-black-box/full-stack-shared-deadline-poll.spec.ts)
supplies a loopback HTTP endpoint and a separate poll-specific grant for each
fixture member. In a deployed application, the poll route owns participant
authorization. A durable implementation can use the [server AppInbox
example](../server-app-inbox/README.md) to commit ballots and retain replay
results. RTC fallback, a server restart, and suspension on a physical phone
have separate qualification requirements.
