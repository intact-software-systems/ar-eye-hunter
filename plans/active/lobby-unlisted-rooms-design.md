# Unlisted rooms — slice 5 design

## Intent and constraints

After merged PR #700, hosts need rooms that can be entered by a scoped link but do not appear in discovery. Unlisted means hidden from discovery, not access restricted. The authorized lobby roadmap owns this product decision. Existing public rooms must retain their visibility; this slice adds no migration or compatibility reader. Existing private entry, admission, AppInbox, optimistic writes, directory caching and game participation remain the owners of their respective behavior.

## Approach

Use the existing create/update group operations with an optional `directoryListing: 'listed' | 'unlisted'` intent field. The server computes this setting into `Group.metadata.rallarDirectoryListing`; this extensible metadata map is already canonical persisted state. Absence means the default `listed` setting for all groups, including new groups created without the option. A present value must be `listed` or `unlisted`; malformed values are hidden by discovery, and invalid writes are rejected. This is a default of the current feature, not a version-dependent decoder or migration.

The internal create/update command inputs are sparse intents for this additive option: omission at create keeps the metadata/default value; omission at update preserves the current listing setting. Keep omission absent in normalization so existing request hashes and durable commands remain valid. The complete `Group` output schema is unchanged. A shared pure listing reader owns interpretation; browser and server use it.

A new mandatory group field would invalidate existing persisted groups or require a migration. A separate storage record would introduce an unnecessary read and transactional guard for a fact owned by the existing group aggregate. A separate mutation operation would duplicate the existing governed group update path. These are implementation alternatives considered by the agent, not choices attributed to the maintainer.

Create may carry the valid metadata setting directly, because metadata remains an extensible public construction input. An explicit `directoryListing` takes precedence. For update, reserve the listing key from generic metadata replacement: preserve the current stored key (or its absence) while applying the ordinary replacement to other metadata. Only the explicit intent changes listing. A returned snapshot's complete metadata may still be submitted unchanged by existing metadata workflows. Document this ownership rule. The listing intent is computed from the fresh server read, so concurrent code rotation, director updates and metadata changes are retained after CAS conflict/redelivery. No browser read/merge workflow owns this setting.

## Observable behavior

- Discovery and Quick Join both exclude an unlisted group, including when an already-read Quick Join candidate becomes unlisted before its commit. The group revision guard forces a fresh read on conflict.
- Public groups with no setting retain their current visibility. Private `code` and `invite-only` groups remain hidden regardless of listing, so listing never grants admission or publishes private rooms.
- A scoped reference or link to an open unlisted group enters through normal join admission. Capacity, bans, lifecycle windows, auth and workspace/application identity remain binding. Full snapshots remain member-only under strict authorization.
- An owner/admin may toggle listing through update; other members cannot. Matching request replay returns the durable original result without a second event. A reused request ID with different listing conflicts. Hiding does not remove membership, presence or application participation.
- The next directory read with an old ETag returns a changed body without the hidden room. No workspace push stream or automatic polling is introduced in this slice.
- AR Eye Hunter and Relic Hunters expose `New unlisted arena/room`, share the existing scoped no-code link, and let current open-room hosts choose `List room` or `Unlist room`. The control explains that anyone with the link can enter. Successful changes use the server snapshot; failures retain the visible setting and offer retry. Existing entry controls accept these links without a second entry owner.

## Two delivery increments

1. Shared/server/API behavior: listing contract and interpretation, create/update normalization and validation, pure compute, directory and Quick Join filtering, OpenAPI, real AppInbox tests and a black-box recipe. Red/green tests cover hidden discovery, existing defaults, authorization, replay, semantic conflict, concurrent rebase, corruption and hiding without membership changes.
2. Browser and both games: pass the optional setting through the room translation boundary, add host creation/toggle/share controls, update examples and product docs, run visible-control browser acceptance in both games, package/API checks and required mutation performance gates. Reuse existing entry and gameplay owners.

## Review focus

Check generic metadata writes after hiding; old request hashes/queued command decoding; Quick Join hiding between read and write; stale directory ETags across toggles; obsolete account/room UI responses. Exact file decomposition and UI layout within the current panels are left to the implementer. Reconnect/recent rooms remain the next outcome after this slice; retention and pushed freshness remain later work.
