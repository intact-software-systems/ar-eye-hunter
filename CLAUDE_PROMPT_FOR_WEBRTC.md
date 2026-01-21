You are tasked with designing and implementing a WebRTC integration for a tic-tac-toe game. The system consists of a web SPA (Single Page Application) and a Deno web server that will facilitate peer-to-peer connections between players.

Here is the current code for your reference:
<current_code>
{{CURRENT_CODE}}
</current_code>

Here are the specific requirements and constraints:
<requirements>
{{REQUIREMENTS}}
</requirements>

Your goal is to provide a complete implementation plan and code for integrating WebRTC into this system. The integration should allow two players to connect peer-to-peer through the Deno server acting as a signaling server.

Before providing your implementation, use a scratchpad to think through the architecture:

<scratchpad>
In your scratchpad, consider:
1. What information needs to be collected from users in the web interface (e.g., room ID, player name)
2. What signaling mechanism the Deno server needs to implement (WebSocket or REST endpoints)
3. How the server will pair two peers together
4. What data needs to be cached in-memory on the server
5. The WebRTC connection flow (offer/answer/ICE candidates exchange)
6. How game state will be synchronized over the WebRTC data channel
</scratchpad>

After your analysis, provide your implementation in the following sections:

<architecture_overview>
Provide a high-level overview of how the WebRTC integration works, including:
- The role of the Deno server in the signaling process
- How peers discover and connect to each other
- How game moves are transmitted between peers
  </architecture_overview>

<server_implementation>
Provide the Deno server code including:
- API endpoints for signaling (creating/joining rooms, exchanging offers/answers/ICE candidates)
- In-memory data structures for caching room information and peer connections
- Any WebSocket implementation if needed
- Clear comments explaining each endpoint's purpose
  </server_implementation>

<client_implementation>
Provide the web SPA code including:
- UI elements for collecting necessary user input (room ID, player name, etc.)
- WebRTC connection setup code (RTCPeerConnection configuration)
- Signaling logic to communicate with the Deno server
- Data channel setup for transmitting game moves
- Integration with the existing tic-tac-toe game logic
- Clear comments explaining the WebRTC flow
  </client_implementation>

<usage_instructions>
Provide step-by-step instructions for:
1. How to run the Deno server
2. How players use the web interface to connect and play
3. Any configuration or environment variables needed
   </usage_instructions>

Make sure your implementation:
- Uses only in-memory storage on the server (no database)
- Handles edge cases like disconnections or when a room is full
- Includes proper error handling
- Is production-ready and follows best practices for WebRTC applications
- Works with a single instance Deno server

Provide complete, working code that can be directly used, not pseudocode or partial implementations.