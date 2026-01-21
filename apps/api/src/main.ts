import { health } from './routes/health.ts';
import { tictactoeWebRtcWebSocketHandler } from './services/tictactoe-webrtc-req-handler.ts';

Deno.serve(
  (req) => {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return health();
    }

    if (url.pathname === '/signaling') {
      return tictactoeWebRtcWebSocketHandler(req);
    }

    return new Response('Not Found', { status: 404 });
  },
);
