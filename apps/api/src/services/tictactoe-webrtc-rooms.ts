// ============================================================================
// Types & Enums
// ============================================================================

enum MessageType {
  CREATE_ROOM = 'CREATE_ROOM',
  ROOM_CREATED = 'ROOM_CREATED',
  JOIN_ROOM = 'JOIN_ROOM',
  ROOM_JOINED = 'ROOM_JOINED',
  PEER_JOINED = 'PEER_JOINED',
  OFFER = 'OFFER',
  ANSWER = 'ANSWER',
  ICE_CANDIDATE = 'ICE_CANDIDATE',
  PEER_DISCONNECTED = 'PEER_DISCONNECTED',
  ERROR = 'ERROR',
}

enum PlayerSymbol {
  X = 'X',
  O = 'O',
}

interface SignalingMessage {
  type: MessageType;
  roomCode?: string;
  playerName?: string;
  playerId?: string;
  symbol?: PlayerSymbol;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  error?: string;
  peerName?: string;
}

interface Peer {
  ws: WebSocket;
  playerId: string;
  playerName: string;
  symbol: PlayerSymbol;
}

interface Room {
  roomCode: string;
  peers: Peer[];
  createdAt: number;
  lastActivity: number;
}

// ============================================================================
// Pure Functions (No Side Effects)
// ============================================================================

const generateRoomCode = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const length = 6;
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

const isRoomCodeValid = (code: string): boolean => {
  return /^[A-Z0-9]{4,6}$/.test(code);
};

const isRoomFull = (room: Room): boolean => {
  return room.peers.length >= 2;
};

const isRoomExpired = (room: Room, now: number): boolean => {
  const ONE_HOUR = 60 * 60 * 1000;
  return now - room.lastActivity > ONE_HOUR;
};

const createRoom = (roomCode: string): Room => ({
  roomCode,
  peers: [],
  createdAt: Date.now(),
  lastActivity: Date.now(),
});

const updateRoomActivity = (room: Room): Room => ({
  ...room,
  lastActivity: Date.now(),
});

const addPeerToRoom = (room: Room, peer: Peer): Room => ({
  ...room,
  peers: [...room.peers, peer],
  lastActivity: Date.now(),
});

const removePeerFromRoom = (room: Room, playerId: string): Room => ({
  ...room,
  peers: room.peers.filter((p) => p.playerId !== playerId),
  lastActivity: Date.now(),
});

const getOtherPeer = (room: Room, playerId: string): Peer | undefined => {
  return room.peers.find((p) => p.playerId !== playerId);
};

const createErrorMessage = (error: string): SignalingMessage => ({
  type: MessageType.ERROR,
  error,
});

// ============================================================================
// State Management (Mutable - Isolated)
// ============================================================================

export class RoomManager {
  private rooms: Map<string, Room> = new Map();

  getRoomByCode(roomCode: string): Room | undefined {
    return this.rooms.get(roomCode);
  }

  createRoom(): Room {
    let roomCode: string;
    do {
      roomCode = generateRoomCode();
    } while (this.rooms.has(roomCode));

    const room = createRoom(roomCode);
    this.rooms.set(roomCode, room);
    return room;
  }

  updateRoom(roomCode: string, room: Room): void {
    this.rooms.set(roomCode, room);
  }

  deleteRoom(roomCode: string): void {
    this.rooms.delete(roomCode);
  }

  cleanupExpiredRooms(): void {
    const now = Date.now();
    const expiredRooms: string[] = [];

    for (const [code, room] of this.rooms.entries()) {
      if (isRoomExpired(room, now)) {
        // Close all peer connections in expired room
        room.peers.forEach((peer) => {
          if (peer.ws.readyState === WebSocket.OPEN) {
            peer.ws.close();
          }
        });
        expiredRooms.push(code);
      }
    }

    expiredRooms.forEach((code) => this.deleteRoom(code));

    if (expiredRooms.length > 0) {
      console.log(`Cleaned up ${expiredRooms.length} expired room(s)`);
    }
  }

  getAllRooms(): Room[] {
    return Array.from(this.rooms.values());
  }
}

// ============================================================================
// WebSocket Message Handlers
// ============================================================================

const handleCreateRoom = (
  roomManager: RoomManager,
  ws: WebSocket,
  message: SignalingMessage,
): void => {
  if (!message.playerName) {
    sendMessage(ws, createErrorMessage('Player name is required'));
    return;
  }

  const room = roomManager.createRoom();
  const playerId = crypto.randomUUID();

  const peer: Peer = {
    ws,
    playerId,
    playerName: message.playerName,
    symbol: PlayerSymbol.X,
  };

  const updatedRoom = addPeerToRoom(room, peer);
  roomManager.updateRoom(room.roomCode, updatedRoom);

  sendMessage(ws, {
    type: MessageType.ROOM_CREATED,
    roomCode: room.roomCode,
    playerId,
    symbol: PlayerSymbol.X,
  });

  console.log(`Room created: ${room.roomCode} by ${message.playerName}`);
};

const handleJoinRoom = (
  roomManager: RoomManager,
  ws: WebSocket,
  message: SignalingMessage,
): void => {
  if (!message.playerName || !message.roomCode) {
    sendMessage(ws, createErrorMessage('Player name and room code are required'));
    return;
  }

  if (!isRoomCodeValid(message.roomCode)) {
    sendMessage(ws, createErrorMessage('Invalid room code format'));
    return;
  }

  const room = roomManager.getRoomByCode(message.roomCode);

  if (!room) {
    sendMessage(ws, createErrorMessage('Room not found'));
    return;
  }

  if (isRoomFull(room)) {
    sendMessage(ws, createErrorMessage('Room is full'));
    return;
  }

  const playerId = crypto.randomUUID();

  const peer: Peer = {
    ws,
    playerId,
    playerName: message.playerName,
    symbol: PlayerSymbol.O,
  };

  const updatedRoom = addPeerToRoom(room, peer);
  roomManager.updateRoom(message.roomCode, updatedRoom);

  // Notify joining player
  sendMessage(ws, {
    type: MessageType.ROOM_JOINED,
    roomCode: message.roomCode,
    playerId,
    symbol: PlayerSymbol.O,
    peerName: updatedRoom.peers[0].playerName,
  });

  // Notify existing player
  const otherPeer = updatedRoom.peers[0];
  sendMessage(otherPeer.ws, {
    type: MessageType.PEER_JOINED,
    peerName: message.playerName,
  });

  console.log(`Player ${message.playerName} joined room: ${message.roomCode}`);
};

const handleSignalingMessage = (
  roomManager: RoomManager,
  ws: WebSocket,
  message: SignalingMessage,
): void => {
  if (!message.roomCode || !message.playerId) {
    sendMessage(ws, createErrorMessage('Room code and player ID are required'));
    return;
  }

  const room = roomManager.getRoomByCode(message.roomCode);

  if (!room) {
    sendMessage(ws, createErrorMessage('Room not found'));
    return;
  }

  const updatedRoom = updateRoomActivity(room);
  roomManager.updateRoom(message.roomCode, updatedRoom);

  const otherPeer = getOtherPeer(updatedRoom, message.playerId);

  if (!otherPeer) {
    sendMessage(ws, createErrorMessage('Peer not found in room'));
    return;
  }

  // Forward the signaling message to the other peer
  sendMessage(otherPeer.ws, message);
};

export const handleDisconnect = (
  roomManager: RoomManager,
  ws: WebSocket,
): void => {
  // Find the room and peer that disconnected
  for (const room of roomManager.getAllRooms()) {
    const disconnectedPeer = room.peers.find((p) => p.ws === ws);

    if (disconnectedPeer) {
      const otherPeer = getOtherPeer(room, disconnectedPeer.playerId);

      // Notify the other peer
      if (otherPeer && otherPeer.ws.readyState === WebSocket.OPEN) {
        sendMessage(otherPeer.ws, {
          type: MessageType.PEER_DISCONNECTED,
        });
      }

      // Remove peer from room
      const updatedRoom = removePeerFromRoom(room, disconnectedPeer.playerId);

      // Delete room if empty
      if (updatedRoom.peers.length === 0) {
        roomManager.deleteRoom(room.roomCode);
        console.log(`Room ${room.roomCode} deleted (empty)`);
      } else {
        roomManager.updateRoom(room.roomCode, updatedRoom);
      }

      console.log(`Player ${disconnectedPeer.playerName} disconnected from room ${room.roomCode}`);
      break;
    }
  }
};

// ============================================================================
// Helper Functions
// ============================================================================

const sendMessage = (ws: WebSocket, message: SignalingMessage): void => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
};

export const handleWebSocketMessage = (
  roomManager: RoomManager,
  ws: WebSocket,
  data: string,
): void => {
  try {
    const message: SignalingMessage = JSON.parse(data);

    switch (message.type) {
      case MessageType.CREATE_ROOM:
        handleCreateRoom(roomManager, ws, message);
        break;
      case MessageType.JOIN_ROOM:
        handleJoinRoom(roomManager, ws, message);
        break;
      case MessageType.OFFER:
      case MessageType.ANSWER:
      case MessageType.ICE_CANDIDATE:
        handleSignalingMessage(roomManager, ws, message);
        break;
      default:
        sendMessage(ws, createErrorMessage('Unknown message type'));
    }
  } catch (error) {
    console.error('Error handling message:', error);
    sendMessage(ws, createErrorMessage('Failed to process message'));
  }
};
