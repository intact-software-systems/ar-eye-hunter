# Signing receipted ordinary RTC room sends

Status: design approved by the maintainer on 2026-11-22; the publication side is being built, the downgrade rule
waits for #869.

## Intent

An ordinary room send over RTC names its origin, and nothing proves it. A recipient signs a true
`delivered` for whatever arrived under that name, and the origin reads `acknowledged`. On 2026-11-22
the maintainer ruled how to close it (D756, recorded in #884): an ordinary RTC room send that tracks
a `receiver` or `leader` receipt is signed at its origin with the session publication key and
verified at every hop with the verifier granted publications already use. A send that asks no
receipt stays unsigned.

## What the reproduction found

`packages/tests/shared/multicast/publication/rtc-ordinary-receipted-send-forgery.test.ts` runs the
real RTC origin, recipients and receipt proofs, each session with its own key, in a star layout.
Five tests assert the wanted behaviour and are red today; two guards are green.

| Case                                                                   | Today                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A member forges a `receiver` send under the origin's id                | The recipient delivers the forged payload to its application and signs `delivered`.                    |
| The forger re-addresses that ACK to the origin                         | The origin counts it: the ACK's proof does not cover who carried it.                                   |
| The origin's own copy then arrives                                     | It is a duplicate and is never delivered, and the recipient answers `delivered` again, to the origin.  |
| The forged copy asks no receipt, the origin's own copy asks `receiver` | The forged copy is delivered; the origin's copy is a duplicate, is answered `delivered`, and confirms. |
| The same forgery under a `leader` receipt                              | The director delivers it, signs `delivered`, and the receipt ends.                                     |
| Guard: an RTC unicast whose channel peer is not its origin             | Refused.                                                                                               |
| Guard: a granted publication another member alters or re-signs         | Refused, or held under an unknown key; the origin's own copy is delivered.                             |

Three findings go beyond the backlog line:

- The forger does not have to carry any ACK. The origin's own copy is answered `delivered` as a
  duplicate of the forged one, so the origin reads `acknowledged` for content its recipient never
  got.
- It is reachable in the games' rooms today. In a star every session is a next hop of every other,
  and the only check on the channel peer is the layout-edge rule, which a room member passes. No
  relay is needed.
- **The downgrade.** A forged copy that asks no receipt is unsigned and, under the ruling, stays
  admissible. The origin's signed copy then meets it as a duplicate and is answered `delivered`.
  Signing receipted sends does not close that on its own.

Facts the design rests on, each with its source in
`lane-b-sign-receipted-sends-findings.md` (the sessions' shared notes):

- A frame is classified granted or ordinary by its topic alone, at the origin, at a relay and at a
  recipient. An unsigned frame on a topic that is not granted goes straight to the room plan.
- The receipt mode a frame asks (`delivery.ack`, `qos.ack`) is inside the signed input, so a signed
  frame cannot be stripped of it.
- An origin can sign once its own cached snapshot names its key. A granted send that cannot sign is
  refused `unsupported` before admission and the fallback carrier takes it. The same rule already
  sends a `receiver` or `leader` leg to WS when a counted recipient has no key (D585).
- A relay rewrites two signed fields of an ordinary frame, `qos.expiry` and `expiresAtMs`. The
  proof-preserving path exists and is chosen by topic at one place, the relay's forward.
- A recipient's owner row holds the message id, the sender, the first copy's channel peer and
  whether it was delivered. It holds no content and no word on whether the copy was verified.
- An older build refuses a proof on a topic that is not granted (`proof-on-ungranted-topic`),
  silently.

## Goals

- A recipient never hands its application an ordinary RTC room send that asks `receiver` or
  `leader` unless its origin's signature verifies, and never signs `delivered` for one.
- A relay forwards such a send only if it verifies, and forwards it with its proof intact.
- An origin's `acknowledged` under `receiver` or `leader` means the recipient holds the origin's
  content, the downgrade included.
- One classification, used at the origin, at every hop and at the relay's forward.
- No IndexedDB operation is added to a send.

## Non-goals

- Signing a send that asks no receipt. Its origin and content stay unauthenticated over RTC; the
  backlog line is restated to say exactly that.
- `hop` and `subtree` receipts, which stay unsigned (D582).
- WS, RTC unicast and granted publications, which are not exposed.
- `rallar.realtime.room`, which does not use ALM.
- Publication keys for native hosts (its own backlog line).

## Approaches

**A. One classification: a frame that must carry a proof.** A frame must carry a publisher proof
when its topic is granted or it asks a `receiver` or `leader` receipt on a room multicast. The
granted path then applies unchanged to the second class: the origin signs at first admission, every
hop verifies before it plans, delivers or forwards, a relay keeps the proof, and an origin that
cannot sign yet is refused `unsupported` so the fallback carrier takes the leg. An unsigned frame
that asks `receiver` or `leader` is refused as a granted frame without a proof is. Cost: one sign
per receipted send (63 to 74 µs on a desktop), one verify per hop (146 to 204 µs), 179 B per frame;
nothing on a send that asks no receipt. It closes the forged receipted send and leaves the
downgrade.

**B. A, and the downgrade closed at the recipient.** The owner row records that its admission was
origin-authenticated: a verified proof, or a copy the WS server delivered. An authenticated copy
that meets an admission that was not is admitted as new: it is delivered and answered as a first
copy, and the row then reads authenticated. Every other second copy is a duplicate as today. The
application can therefore see two deliveries under one id, the forged unreceipted one and then the
origin's; the receipt is true. Cost: one optional field on a persisted row, absent meaning not
authenticated, as `ended` is written; one rule in the duplicate decision; both in files #869
rewrites.

**C. A, and the downgrade closed by signing every ordinary RTC room send.** No unsigned admission
exists, so there is nothing to downgrade to, and no inbound change. Cost: the sign, the verify and
the 179 B fall on every ordinary RTC room frame, `live` channels included; the window before an
origin's key is named applies to every send; the mixed-build window covers all room traffic. The
maintainer passed over this when ruling D756, before the downgrade was known.

## Pick: B

It keeps the ruling as made and closes what the reproduction added. The downgrade then reduces to
the limit the ruling already accepted: a member can deliver unreceipted content under another's
name, and it can no longer make a receipted send read `acknowledged`.

The shape:

- One predicate in `packages/shared/multicast/publication/` says whether a frame must carry a
  proof. The origin's signing gate, the admission at each hop and the relay's forward use it; the
  relay keeps any frame's proof that is present.
- The origin signs a receipted room multicast where it signs a granted one (`signAdmittedMessage`),
  so the stored canonical row carries the proof and a retry resends it. A leg it cannot sign yet is
  refused `unsupported`, as `computeRtcReceiptKeyRefusal` refuses a leg whose recipient has no key.
- A hop refuses an unsigned frame that asks `receiver` or `leader`, an altered one and one signed
  by another key, exactly as the granted admission does today: nothing is delivered, forwarded or
  answered, and an unknown key is held `not-yet-in-sync`.
- The inbound owner row gains the authenticated mark, and the duplicate decision admits an
  authenticated copy over an admission without it.

## Rulings (2026-11-22)

1. The downgrade closes at the recipient (approach B): the owner row records an origin-authenticated
   admission, and an authenticated copy is admitted over an admission without that mark.
2. The mixed-build window is accepted with no migration code, as D589 accepted it for receipt proofs.
3. The publication side is built now: the classification, the signing, the verification at every hop,
   the relay's proof-preserving forward and the key-window fallback. The downgrade rule stays unbuilt,
   its test red, until #869 lands; this pull request stays a draft until both halves are in.

## Lane proof

No lane command lets one agent send a frame under another's id, so the forgery itself is proven in
unit tests over the real RTC stack. The lane proves the other half: with signing on, every cell
over `rtc` that asks `receiver` or `leader` must still pass, which shows the origin's key is named
in time and that relays keep the proof. If an existing cell's diagnostics expose publication
verifications, as the `granted-rtc` cells read them, one receipted cell asserts that its frames
were verified.

## Tests

Unit, red first: the five reproductions; an unsigned frame that asks `receiver` is refused at a
relay and never forwarded; a relayed signed frame verifies at the leaf after the relay's expiry
rewrite is gone; an origin whose key is not yet named hands the leg to WS; an authenticated copy
over an unauthenticated admission is delivered and answered once; an unauthenticated copy over an
authenticated admission stays a duplicate; a send that asks no receipt is unsigned and costs no
sign and no verify; the sign and verify counts of a direct and a relayed `receiver` room, pinned as
D591 pinned the receipt counts.

## Documents in the same pull request

The backlog line is restated to the limit that stays. Decision rows continue from D757. The inbound
and outbound READMEs and the publication QoS addendum gain the second class of signed frame. This
file is deleted before the pull request is marked ready.
