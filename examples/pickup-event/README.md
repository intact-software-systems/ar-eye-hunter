# Pickup court

Installable guest client for a Rallar room event. An organizer creates an invite-only lobby, issues a guest invitation, creates courts and controls court releases through the room event SDK. Participants can wait with the app closed and explicitly opt in to a court-ready notification on each device.

Run `node examples/pickup-event/build.mjs tmp/pickup-event` and serve the output directory over HTTPS. Place a private `event.json` beside the assets containing `lobby` (applicationId, workspaceId and groupId), `invitationSecret`, and optionally `apiBaseUrl`. Everyone with this invitation can redeem a guest seat. The example stores the issued guest credential in the browser's credential store.

## Configure delivery

Configure all API worker replicas with the same secret environment variable `RALLAR_WEB_PUSH_VAPID_JSON`, containing a JSON object with `subject` (operator contact mailto or HTTPS URL), `publicKey` and `privateKey`. Generate the P-256 key pair once with the web-push library and keep the private key in deployment secret storage. The public capability route returns the public key or null. Apple Push Notification service, Firefox's Mozilla push service and Google's FCM endpoint are supported. Provider redirects are rejected.

On iPhone, open the invitation in Safari, use Share → Add to Home Screen, then launch the installed app. Tap Join event, then Notify me when my court is ready, and allow notifications. Join the queue and close the app. When a court is offered, tapping its notification reads the current event. A live offer can be claimed. An expired offer leaves the player free to join the queue again.

Turn off court alerts from the event to remove that device's event consent. Event closure and participant removal also revoke consent. Browser push service delivery is best effort. Each notification identifies its original offer, and assignment is always verified with the server when opened.
