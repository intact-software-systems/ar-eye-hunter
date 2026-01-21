import { handleDisconnect, handleWebSocketMessage, RoomManager } from './tictactoe-webrtc-rooms.ts';

const roomManager = new RoomManager();

// Cleanup expired rooms every 5 minutes
setInterval(
  () => {
    roomManager.cleanupExpiredRooms();
  },
  5 * 60 * 1000,
);

export function tictactoeWebRtcWebSocketHandler(req: Request): Response {
  // Handle WebSocket upgrade for signaling
  if (req.headers.get('upgrade') !== 'websocket') {
    return new Response('Expected WebSocket', { status: 400 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.onopen = () => {
    console.log('WebSocket connection opened');
  };

  socket.onmessage = (event) => {
    handleWebSocketMessage(roomManager, socket, event.data);
  };

  socket.onclose = () => {
    handleDisconnect(roomManager, socket);
    console.log('WebSocket connection closed');
  };

  socket.onerror = (error) => {
    console.error('WebSocket error:', error);
  };

  return response;
}
