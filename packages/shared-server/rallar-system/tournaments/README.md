# Tournament authority and view delivery

`register-tournament-inbox.ts` binds incoming commands to `TournamentService`.
The service captures storage and issued-session authority, computes with
`compute-tournament-mutation.ts`, validates the complete computed projection,
and commits bracket, private attempts, room admissions and outbox together.
`TournamentRepository` owns the bracket CAS and attempt persistence.

Native games publish immutable results through `tournament-result.ts` and
`tournament-result-repository.ts`. Durable signals in `tournament-signals.ts`
feed reconciliation back through the same mutation service. A result or deadline
therefore uses the same bracket guards and view publication as a user command.

`compute-tournament-view-publication.ts` compares canonical before/after views.
Bracket hints reach participants and authenticated selected-view watchers.
Private catalog hints reach the union of previous and current participants,
including removed entrants. Public catalog hints are emitted only when a listed,
discoverable projection changes. Public hints use opaque change and trace IDs;
none of these hints carry a tournament ID or private bracket state.

`TournamentReader` serves an authenticated point view, including a null bracket
for a missing ID. `catalog/tournament-catalog-reader.ts` owns public discovery
and private account history; opening a point view adds neither registration nor
history.

`TournamentViewWatch` plugs into the shared `view-watch` owner. Existing brackets
fence registration with their bracket revision. A missing bracket instead uses
`tournament-watch-fence.ts`: the row expires with captured authentication and
contains a command-derived incarnation. Exact predecessor value plus revision
prevents a delayed registration or creation from matching a physically collected
and recreated fence. Creation promotes this fence atomically with the bracket
before publishing to its captured watchers. Completed and cancelled brackets
remain readable and never expire, so their created fences share that lifetime;
there is currently no tournament retirement/deletion owner. A future retirement
owner must remove the fence in the same lifecycle as its bracket.

Watch slots and resource lookups are separate from tournament membership. They
are scoped by authenticated session and closed watch family, expire with auth,
and are cleaned by the existing generation-fenced session lifecycle. The watch
owner compares exact persisted auth/client authority when committing, so a
reissued session key cannot authorize a delayed release from a prior incarnation.
