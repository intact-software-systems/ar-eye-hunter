# Rallar WebRTC Product Safety And Operations Plan

Date: 2026-06-03

## Purpose

This companion plan captures WebRTC product, safety, operational, and testing
concerns that sit around the core RTC connection and topology plans.

The main RTC connection plan covers transport intent, calls, targeted channels,
room multicast, media/data patterns, diagnostics, and recovery. This document
adds the surrounding product and platform concerns that make those features
usable in real applications:

- call invite and consent flows
- roles and moderation
- multi-tab and multi-device targeting
- TURN credential lifecycle and relay cost controls
- recording/captions/transcription boundaries
- advanced media quality capabilities
- protocol/version compatibility
- abuse and privacy controls
- deterministic WebRTC test harnesses

## Relationship To Existing Plans

This plan should be implemented after, or alongside, the product facades in:

- `plans/rallar-rtc-connection-product-and-implementation-plan.md`
- `plans/rallar-rtc-topology-tree-mesh-plan.md`

It does not replace those plans. It adds guardrails and future-facing product
requirements so the first WebRTC API surface does not paint Rallar into a
corner.

Local references checked for alignment:

- `docs/rallar-api-reference.md`
- `docs/rallar-quickstart-and-recipes.md`
- `packages/shared-web/browser/rallar.ts`
- `packages/shared-web/browser/middleware.ts`
- `packages/shared/api/api-config.ts`
- `packages/shared/api/client-types.ts`
- `packages/shared/api/group-types.ts`
- `packages/shared/services/WebRtcConnectionService.ts`
- `packages/shared/services/WebRtcGroupManager.ts`
- `packages/shared/services/WebRtcRxStreamerService.ts`
- `packages/shared/webrtc/QRtcDataChannel.ts`
- `packages/shared/webrtc/QRtcPeerConnection.ts`

## Current Repo Alignment

This document uses a few product terms that should be mapped carefully to the
current codebase:

- Low-level RTC peer identity is currently session-based. `AuthSession`,
  `ClientInfo`, group active sessions, RTC peer IDs, and overlay next hops all
  use session IDs for active runtime peers.
- The richer state model already has `PrincipalId`, `ClientInstanceId`, and
  `SessionId` types in the shared client model. Product-level call APIs can use
  those concepts, but the current public browser facade mostly exposes people,
  rooms, and sessions rather than a first-class device picker.
- Group roles currently mean room membership roles: `owner`, `admin`, and
  `member`. Stage-room roles such as `speaker`, `listener`, and `presenter` are
  proposed call/session roles, not replacements for group membership roles.
- Group state already has invitation and membership statuses such as `invited`,
  `active`, `left`, `removed`, and `banned`. Call invitation state should build
  on that model but remain separate from durable group membership.
- Current ICE configuration includes `iceServers` and an
  `expiresAtEpochMs` timestamp. TURN credential refresh, relay quotas, and
  relay cost controls are proposed operational additions.
- Current media policy supports bitrate/framerate/resolution scaling and codec
  preferences. Simulcast, SVC, active speaker detection, audio-level UX,
  recording, captions, and transcription are future boundaries.
- Current data channels already support `RTCDataChannelInit`, binary type,
  flow-control policy, backpressure handling, and send results. The lane-profile
  work should expose this through stable product presets rather than making most
  apps choose raw channel options.

## Findings And Direction

### Invite And Consent UX

Incoming calls should not behave like raw RTC connection attempts. Rallar should
model a call invitation lifecycle:

- invite sent
- incoming invite received
- accepted
- rejected
- canceled
- timed out
- missed
- ended

The API should support do-not-disturb, caller allow/deny decisions, blocked
peers, and app-owned notification UX.

Recommended first behavior:

- Add invite, accept, reject, cancel, timeout, and missed states.
- Keep notification rendering outside Rallar.
- Expose enough metadata for apps to show who is calling, what media is
  requested, and what room/call context applies.

### Roles And Moderation

Group calls and stage-room patterns need role vocabulary before they need a full
media-server implementation.

Suggested roles:

- host
- co-host
- speaker
- listener
- presenter
- viewer

Suggested moderation actions:

- mute self
- request unmute
- mute participant
- remove participant
- allow or deny screen share
- promote speaker
- demote speaker
- transfer host

Rallar should treat these as product-level call/session state changes, not as
raw media track operations.

### Multi-Tab And Multi-Device Targeting

Rallar currently works heavily with session IDs. For calls, that is not enough
as the only product concept.

The plan should define target levels:

- `session`: one browser tab or runtime session
- `device`: one user device, potentially with one active session selected
- `user`: a person/principal across active sessions
- `room`: live room membership

Recommended first behavior:

- Keep low-level RTC peer targeting session-based.
- Add product APIs that can target `user` or `room`, resolving to active
  sessions internally.
- Define what happens when the same user has multiple active sessions:
  deterministic preferred session, all sessions, or app-selected session.

### TURN Credential Lifecycle And Cost Controls

TURN relay usage can become expensive and is often invisible to application
developers.

Rallar should support:

- expiring TURN credentials
- proactive credential refresh
- relay-only, prefer-relay, and direct-preferred policies
- relay usage diagnostics
- relay quotas or budget hooks
- app-visible degraded state when TURN is required but unavailable

Recommended first behavior:

- Surface whether a connection is direct or relayed.
- Track TURN credential expiry and refresh failures.
- Add a guardrail that relay-only mode must be explicit.

### Recording, Captions, And Transcription Boundaries

Recording and transcription are product-sensitive and often regulated. They
should not be accidental side effects of a call API.

Rallar should leave explicit extension points for:

- local recording
- server/SFU recording
- captions
- transcription
- recording consent state
- recording indicators

Recommended first behavior:

- Do not implement recording in the first RTC product slice.
- Reserve call metadata fields for recording/caption/transcription capability
  and consent state.
- Document that recording/transcription integrations must be explicit.

### Advanced Media Quality

The current media policy direction covers codec and bitrate/framerate style
controls. Future call APIs should leave room for richer media controls:

- simulcast
- SVC
- active speaker detection
- voice activity detection
- audio level indicators
- echo cancellation controls
- noise suppression controls
- auto gain control controls
- screen-share quality presets

Recommended first behavior:

- Add user-facing quality presets, not raw sender parameters, as the main API.
- Keep advanced sender/codec details available for expert integrations.
- Do not promise scalable large-room media without an SFU/relay layer.

### Protocol And Version Compatibility

Call signaling, data-channel RPC, lane profiles, and room topology updates need
versioned payloads so old and new clients can coexist.

Rallar should define:

- protocol version fields on call control messages
- feature negotiation for call/media/channel capabilities
- compatibility behavior for unsupported lane profiles or media features
- downgrade/fallback results that are visible to apps

Recommended first behavior:

- Add version and capability metadata to new call/channel control messages.
- Treat unknown features as negotiated unsupported, not generic failure.

### Abuse And Privacy Controls

Calls and media introduce user-facing abuse risks beyond ordinary messaging.

Rallar should support:

- blocked callers
- call invite rate limits
- room-level call permission policy
- "who can call me" policy
- user-visible camera/microphone/screen active state
- reporting hooks
- audit-friendly call lifecycle events

Recommended first behavior:

- Add hooks for apps to deny incoming calls before RTC/media starts.
- Expose active media state in call status.
- Add rate-limit and block-list extension points, even if app/server policy owns
  the first implementation.

### WebRTC Test Harness

Rallar needs deterministic WebRTC tests that do not depend only on live browsers
and real networks.

The test harness should support:

- fake peers
- fake media streams
- fake device permission states
- simulated ICE failure
- simulated TURN relay path
- simulated network handoff
- deterministic data-channel open/close/error
- deterministic backpressure and queue overflow
- simulated browser sleep/background recovery

Recommended first behavior:

- Add black-box browser tests for public product behavior.
- Add lower-level fake WebRTC unit/integration tests for failure and recovery
  states that are hard to reproduce reliably in real browsers.

## Implementation Priority

### First Product Slice

Implement these with the first call/channel product APIs:

- call invite lifecycle: invite, accept, reject, cancel, timeout, missed, ended
- session/user/room targeting rules
- basic role vocabulary: host, participant, speaker, listener
- protocol version and feature capability metadata
- direct versus relay diagnostics
- active media state in call status
- deterministic cleanup tests

### Second Slice

Add deeper operational and safety behavior:

- do-not-disturb and block-list integration
- call invite rate limiting
- TURN credential refresh and relay budget hooks
- device change handling
- richer role/moderation actions
- fake WebRTC test harness improvements

### Future Boundary

Keep these as explicit roadmap or integration boundaries:

- SFU-backed large media rooms
- server-side recording
- transcription and captions
- E2EE/insertable-streams
- simulcast/SVC tuning
- active speaker and audio-level driven stage UX

## Test Plan

Product behavior tests:

- Incoming call can be accepted, rejected, canceled, timed out, and marked
  missed.
- Call starts no RTC/media before acceptance unless explicitly configured.
- Blocked or policy-denied caller never opens RTC/media.
- Same user with multiple sessions resolves according to the selected targeting
  rule.
- Role changes produce observable call/session state.
- Media active state reflects microphone, camera, and screen share separately.

Operational tests:

- TURN relay path is reported in diagnostics.
- Expired TURN credentials produce a clear degraded or failed state.
- Relay-only policy is never used unless explicitly configured.
- Cleanup releases tracks, data channels, peer connections, and call handles.
- Protocol version mismatch returns unsupported/downgraded results.

Harness tests:

- Fake permission denial does not look like RTC transport failure.
- Fake ICE failure can recover through ICE restart.
- Fake network handoff transitions through recovering/degraded/open or failed.
- Fake data-channel backpressure triggers the configured lane policy.
- Fake browser sleep does not leave stale open status.

## Documentation Updates

Add or update:

- API reference: call invitation lifecycle, target levels, roles, and active
  media status.
- Troubleshooting checklist: relay usage, TURN credentials, permission/device
  states, cleanup, protocol mismatch, and denied calls.
- Product recipes: one-to-one call, one-to-many call, stage-room vocabulary,
  targeted data channel, and live room multicast.
- Testing docs: fake WebRTC harness, browser black-box scenarios, and failure
  simulation recipes.

## Assumptions

- Rallar's low-level RTC peer identity remains session-based.
- Product-level call APIs may target users or rooms and resolve those targets to
  sessions internally.
- Large-room audio/video scaling requires SFU/relay integration and is not
  solved by browser mesh or the tree/mesh data overlay plan.
- Recording, transcription, E2EE, and advanced media tuning should be explicit
  opt-in capabilities, not default behavior.
