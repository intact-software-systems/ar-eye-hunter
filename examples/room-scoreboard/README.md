# Room scoreboard

Start the local Rallar API with `npm run start:rallar:api:memory`. In another terminal run
`VITE_RALLAR_API_BASE_URL=http://localhost:8080 npx vite --config apps/rallar-black-box/vite.config.ts --host localhost` from the repository root,
using the API origin printed by your server. Open `/examples/room-scoreboard/` on the Vite origin.

Sign in with a local test account and create a room. In a separate browser profile, sign in as a second
participant and enter the same room. Choose **Take clock control** in the first browser and start the
ten-minute period. Pause it and reload either browser. Entering the room again restores the same balance.
Only the appointed director may change the clock. Choose **Advance to halftime** to start a three-minute phase. A participant can choose **Switch court**, enter another court, and return to recover the current phase and its countdown. The court they visit must already have an owner if they want to leave it.

The scoreboard uses the public room SDK. Its display refreshes locally. Clock changes arrive through
the room WebSocket, and the SDK reconciles them with durable room state.

The Court program displays the named `program` schedule when a director publishes it through
`rooms.publishSchedule`. It shows the current phase and the next UTC start, recovers the latest
revision when switching back to the court, and updates locally as the calibrated clock crosses a boundary.
