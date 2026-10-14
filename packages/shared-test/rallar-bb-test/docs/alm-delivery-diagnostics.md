# ALM delivery with recording On or Off

`createAlmDeliveryDiagnosticsRecipes(input, almDiagnostics)` in
`conformance/alm/create-alm-conformance-recipes.ts` returns an independent sender/receiver pair.
Pass `true` for On or `false` for Off. Each variant has its own scenario key, recipe IDs, command IDs,
message type and send handle. Run each role on a freshly initialized runtime with its normal
configuration and authenticated session. Do not combine these pairs into the diagnostic conformance
matrix or reuse an earlier connection's event history. Keep the normal retained event history for the
whole run; the pair checks that no earlier ALM or connection-phase evidence is present.

Both pairs assert admitted delivery, acknowledged state, receipt mode, expected/confirmed/unconfirmed
recipient counts and the actual received payload, then hold the existing receiver window to exclude a
second arrival. Receipt role metadata names the receiver for the existing session-identity assessment.
On also requires outbound publication on the sender and inbound publication on the receiver. Off
checks all four ALM topics (outbound, inbound, storage and storage_reset) in the retained interval from
connection through completed delivery checks and stats. These final scans add no delay. The applied
boolean must appear on the same scoped connection's `rallar.browser.connect.phase_completed` event
with `data.phase` equal to `rallar-connect`; preparation intent or absence of events cannot certify Off.

Use the existing Manual Command JSON editor for operator selection. After normal authentication and
room setup, a configure command selects the next scoped connection's default:

```json
{
  "kind": "configure",
  "config": {
    "rallar": {
      "almDiagnostics": false
    }
  }
}
```

Connect to that room with installed harness ports (Off is inherited from configure):

```json
{
  "kind": "rtc.connect",
  "connection": "almDelivery",
  "actor": "{auth.clientId}",
  "roomRef": {
    "applicationId": "rallar-server",
    "workspaceId": "default",
    "groupId": "alm-delivery-room"
  },
  "transport": "messages.ws",
  "rallar": {
    "typeId": "alm.delivery",
    "topicId": "room.alm-delivery"
  }
}
```

For On, explicitly override the configured value in the same scoped connect:

```json
{
  "kind": "rtc.connect",
  "connection": "almDelivery",
  "actor": "{auth.clientId}",
  "roomRef": {
    "applicationId": "rallar-server",
    "workspaceId": "default",
    "groupId": "alm-delivery-room"
  },
  "transport": "messages.ws",
  "rallar": {
    "almDiagnostics": true,
    "typeId": "alm.delivery",
    "topicId": "room.alm-delivery"
  }
}
```

Explicitly close and reinitialize an active connection before changing its policy. Configure does not
replace installed recording ports retroactively. Unscoped connections without installed harness ports
have no applied boolean and cannot certify On or Off. Omission defaults to recording On. Configure
continues to replace operational options according to its existing semantics; include the boolean in
later configure commands that need it.

ALM recording controls diagnostic evidence only. RTC capture (`rtcCaptureMode`) is independent.
Delivery, trackers, faults, formation and other diagnostics remain available with recording Off. Full
ALM diagnostic conformance recipes require On and author it explicitly, including generated Hetzner
manifests 18–22. Off removes evidence; absent ALM diagnostics do not prove zero work or cost.
