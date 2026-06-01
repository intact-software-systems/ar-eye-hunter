# Client Discovery

When SPA boots up in the browser, automatically connect to the server and retrieve all available clients.

Then, click a button to init RTC connections with all clients.

```text
1. Login with username and password
2. Redirect to rooms page to see all available rooms, create or join an existing room.
3. Click on a room to join it.
4. Initiate RTC connections with all clients in the room.
    - Connection state to members should be visible in the UI
5. Explore room apps that uses the RTC connections.
    - Chat
    - Video Call
    - Audio Call
    - Games
```

## Detect client online presence

Each SPA periodically sends a ping to the server to notify it is alive.

Server updates client online status in the database.

Each server instance keeps a list of all clients.

Whenever a client requests a WebSocket connection, this client is added to the local in memory
list and broadcasted to the other server instances, which in
turn updates their local in-memory list and sends updates to its connected clients.



