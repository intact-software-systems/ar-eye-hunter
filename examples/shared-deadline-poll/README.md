# Shared deadline poll

Run the example from the repository root with Chromium installed. Add
`--headed` to watch both participants.

```sh
npm run test:rallar:full-stack:memory -- --grep 'delayed ballot' --workers=1
```

The journey starts the Rallar memory API, signs in two room participants and
opens a Yes/No poll with device clocks two minutes ahead and behind. The pages
display the same UTC cutoff. One Yes arrives in time. The other participant
clicks No while open, but the journey holds that HTTP request until voting
closes. Reloading their page shows the original cutoff, one Yes, zero No and
the authority's late disposition.

[PollAuthority](./poll-authority.ts) owns one room's closing instant, tally and
first decision for each participant. Its synchronous receipt check counts a
first ballot only before the cutoff. A retry returns the retained decision and
the latest tally. This example keeps the poll in one server process. Restarting
that process ends the poll.

[showPoll](./poll-view.ts) connects the authenticated Rallar client, enters the
scoped room, fetches its poll record and renders the deadline using
`rallar.compareDeadline`. Call it again on page load. Each vote response
refreshes the displayed tally. Its returned function releases the display timer
when the host unmounts the view.

The [Playwright journey](../../tests/playwright/rallar-black-box/full-stack-shared-deadline-poll.spec.ts)
supplies a loopback HTTP endpoint and a separate poll-specific grant for each
fixture member. In a deployed application, the poll route owns participant
authorization. A durable implementation can use the [server AppInbox
example](../server-app-inbox/README.md) to commit ballots and retain replay
results. RTC fallback, a server restart, and suspension on a physical phone
have separate qualification requirements.
