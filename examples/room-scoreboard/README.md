# Room scoreboard

Start the local Rallar API with `npm run start:rallar:api:memory`. In another terminal run
`VITE_RALLAR_API_BASE_URL=http://localhost:8080 npx vite --config apps/rallar-black-box/vite.config.ts --host localhost` from the repository root,
using the API origin printed by your server. Open `/examples/room-scoreboard/` on the Vite origin.

Sign in with a local test account and create a room. In a separate browser profile, sign in as a second
participant and enter the same room. Choose **Take clock control** in the first browser and start the
ten-minute period. Pause it and reload either browser. Entering the room again restores the same balance.
Only the appointed director may change the clock. An expired period can start again.

The scoreboard uses the public room SDK. Its display refreshes locally. Clock changes arrive through
the room WebSocket, and the SDK reconciles them with durable room state.
