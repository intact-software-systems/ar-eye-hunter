import { expect, request, test } from '@playwright/test';
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from 'node:http';
import {
    RELIC_PROTOCOL_VERSION,
    applyRelicCommand,
    createRelicGame,
    isRelicCommand,
    toPublicRelicSnapshot,
    type RelicActionInput,
    type RelicCharacterId,
    type RelicCommand,
    type RelicGameState,
} from '../../../packages/relic-hunters/mod.ts';

let server: Server;
let baseURL: string;

type TestPlayer = Readonly<{
    sessionId: string;
    username: string;
    characterId: RelicCharacterId;
}>;

type RelicApiSnapshot = Readonly<{
    phase: string;
    round: number;
    winnerIds: readonly string[];
    players: readonly Readonly<{
        playerId: string;
        roomId: string;
        escaped: boolean;
    }>[];
}>;

test.beforeAll(async () => {
    const games = new Map<string, RelicGameState>();
    server = createServer(async (req, res) => {
        try {
            await handleRelicRequest(req, res, games);
        } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: String(error) }));
        }
    });

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Could not resolve relic test server address.');
    }
    baseURL = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
});

test('serves and mutates relic game state through HTTP API calls', async () => {
    const api = await request.newContext({ baseURL });

    const initial = await api.get('/api/relic/games/room-1');
    expect(initial.ok()).toBe(true);
    await expect(initial.json()).resolves.toMatchObject({
        gameId: 'room-1',
        phase: 'lobby',
        players: [],
    });

    const joined = await api.post('/api/relic/games/room-1/commands', {
        data: joinCommand('room-1'),
    });
    expect(joined.ok()).toBe(true);
    await expect(joined.json()).resolves.toMatchObject({
        gameId: 'room-1',
        players: [
            {
                playerId: 'alice-session',
                username: 'Alice',
                characterId: 'kael-ironstride',
            },
        ],
    });

    const reset = await api.post('/api/relic/games/room-1/reset');
    expect(reset.ok()).toBe(true);
    await expect(reset.json()).resolves.toMatchObject({
        gameId: 'room-1',
        players: [],
    });

    await api.dispose();
});

test('uses the URL game id instead of trusting command body room ids', async () => {
    const api = await request.newContext({ baseURL });
    const alice: TestPlayer = {
        sessionId: 'alice-session',
        username: 'Alice',
        characterId: 'kael-ironstride',
    };

    const joined = await api.post('/api/relic/games/url-room/commands', {
        headers: playerHeader(alice),
        data: joinCommand('body-room', alice),
    });
    expect(joined.ok()).toBe(true);
    await expect(joined.json()).resolves.toMatchObject({
        gameId: 'url-room',
        roomId: 'url-room',
        players: [{ playerId: 'alice-session' }],
    });

    const urlRoom = await api.get('/api/relic/games/url-room');
    await expect(urlRoom.json()).resolves.toMatchObject({
        gameId: 'url-room',
        players: [{ playerId: 'alice-session' }],
    });

    const bodyRoom = await api.get('/api/relic/games/body-room');
    await expect(bodyRoom.json()).resolves.toMatchObject({
        gameId: 'body-room',
        players: [],
    });

    await api.dispose();
});

test('happy path: four hunters can move through the castle and finish by escaping', async () => {
    const api = await request.newContext({ baseURL });
    const roomId = 'room-happy-path';
    const players: readonly TestPlayer[] = [
        { sessionId: 'alice-session', username: 'Alice', characterId: 'kael-ironstride' },
        { sessionId: 'bob-session', username: 'Bob', characterId: 'nyra-vale' },
        { sessionId: 'cara-session', username: 'Cara', characterId: 'oryn-starcoil' },
        { sessionId: 'dane-session', username: 'Dane', characterId: 'vessa-thornlock' },
    ];

    for (const player of players) {
        const response = await api.post(`/api/relic/games/${roomId}/commands`, {
            headers: playerHeader(player),
            data: joinCommand(roomId, player),
        });
        expect(response.ok()).toBe(true);
    }

    const started = await api.post(`/api/relic/games/${roomId}/commands`, {
        headers: playerHeader(players[0]),
        data: startCommand(roomId, players[0]),
    });
    expect(started.ok()).toBe(true);
    await expect(started.json()).resolves.toMatchObject({
        phase: 'planning',
        players: players.map((player) => ({
            playerId: player.sessionId,
            username: player.username,
            roomId: 'entrance',
        })),
    });

    let snapshot = await submitRound(api, roomId, players, { kind: 'move', targetRoomId: 'hallway' });
    expect(snapshot).toMatchObject({ round: 2, phase: 'planning' });
    expect(snapshot.players.map((player) => player.roomId)).toEqual([
        'hallway',
        'hallway',
        'hallway',
        'hallway',
    ]);

    snapshot = await submitRound(api, roomId, players, { kind: 'move', targetRoomId: 'trap' });
    expect(snapshot).toMatchObject({ round: 3, phase: 'planning' });

    snapshot = await submitRound(api, roomId, players, { kind: 'move', targetRoomId: 'monster' });
    expect(snapshot).toMatchObject({ round: 4, phase: 'planning' });

    snapshot = await submitRound(api, roomId, players, { kind: 'move', targetRoomId: 'exit' });
    expect(snapshot).toMatchObject({ round: 5, phase: 'planning' });
    expect(snapshot.players.every((player) => player.roomId === 'exit')).toBe(true);

    snapshot = await submitRound(api, roomId, players, { kind: 'escape' });
    expect(snapshot.phase).toBe('finished');
    expect(snapshot.players.every((player) => player.escaped)).toBe(true);
    expect(snapshot.winnerIds.length).toBeGreaterThan(0);

    await api.dispose();
});

test('not so happy path: an absent active hunter blocks round resolution until reset', async () => {
    const api = await request.newContext({ baseURL });
    const roomId = 'room-absent-player';
    const alice: TestPlayer = {
        sessionId: 'alice-session',
        username: 'Alice',
        characterId: 'kael-ironstride',
    };
    const bob: TestPlayer = {
        sessionId: 'bob-session',
        username: 'Bob',
        characterId: 'nyra-vale',
    };

    for (const player of [alice, bob]) {
        const response = await api.post(`/api/relic/games/${roomId}/commands`, {
            headers: playerHeader(player),
            data: joinCommand(roomId, player),
        });
        expect(response.ok()).toBe(true);
    }
    await api.post(`/api/relic/games/${roomId}/commands`, {
        headers: playerHeader(alice),
        data: startCommand(roomId, alice),
    });

    const afterAlice = await api.post(`/api/relic/games/${roomId}/commands`, {
        headers: playerHeader(alice),
        data: submitCommand(roomId, alice, { kind: 'search' }),
    });
    expect(afterAlice.ok()).toBe(true);
    await expect(afterAlice.json()).resolves.toMatchObject({
        phase: 'planning',
        round: 1,
        submittedPlayerIds: ['alice-session'],
        players: [
            { playerId: 'alice-session', escaped: false, defeated: false },
            { playerId: 'bob-session', escaped: false, defeated: false },
        ],
    });

    const reset = await api.post(`/api/relic/games/${roomId}/reset`);
    expect(reset.ok()).toBe(true);
    await expect(reset.json()).resolves.toMatchObject({
        phase: 'lobby',
        players: [],
        submittedPlayerIds: [],
    });

    await api.dispose();
});

test('rejects invalid relic commands', async () => {
    const api = await request.newContext({ baseURL });

    const response = await api.post('/api/relic/games/room-1/commands', {
        data: {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            kind: 'dance',
            gameId: 'room-1',
            username: 'Alice',
        },
    });

    expect(response.status()).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid relic command' });
    await api.dispose();
});

async function handleRelicRequest(
    req: IncomingMessage,
    res: ServerResponse,
    games: Map<string, RelicGameState>,
): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const gameMatch = /^\/api\/relic\/games\/([^/]+)(?:\/(commands|reset))?$/.exec(url.pathname);
    if (!gameMatch) {
        writeJson(res, { error: 'Not found' }, 404);
        return;
    }

    const gameId = decodeURIComponent(gameMatch[1]);
    const action = gameMatch[2];
    if (req.method === 'GET' && !action) {
        const state = games.get(gameId) ?? createRelicGame(gameId, gameId);
        games.set(gameId, state);
        writeJson(res, toPublicRelicSnapshot(state));
        return;
    }

    if (req.method === 'POST' && action === 'reset') {
        const state = createRelicGame(gameId, gameId);
        games.set(gameId, state);
        writeJson(res, toPublicRelicSnapshot(state));
        return;
    }

    if (req.method === 'POST' && action === 'commands') {
        const body = await readJson(req);
        const command = {
            ...(typeof body === 'object' && body !== null ? body : {}),
            gameId,
        } as RelicCommand;
        if (!isRelicCommand(command)) {
            writeJson(res, { error: 'Invalid relic command' }, 400);
            return;
        }

        const previous = games.get(gameId);
        const result = applyRelicCommand(previous, command, {
            senderId: readSenderId(req),
            now: () => Date.now(),
        });
        games.set(gameId, result.state);
        writeJson(res, toPublicRelicSnapshot(result.state));
        return;
    }

    writeJson(res, { error: 'Not found' }, 404);
}

function readJson(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            resolve(body.length > 0 ? JSON.parse(body) : undefined);
        });
        req.on('error', reject);
    });
}

function writeJson(
    res: ServerResponse,
    body: unknown,
    status = 200,
): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

function readSenderId(req: IncomingMessage): string {
    const raw = req.headers['x-player-id'];
    return typeof raw === 'string' && raw.length > 0 ? raw : 'alice-session';
}

async function submitRound(
    api: Awaited<ReturnType<typeof request.newContext>>,
    roomId: string,
    players: readonly TestPlayer[],
    action: RelicActionInput,
): Promise<RelicApiSnapshot> {
    let snapshot: unknown;
    for (const player of players) {
        const response = await api.post(`/api/relic/games/${roomId}/commands`, {
            headers: playerHeader(player),
            data: submitCommand(roomId, player, action),
        });
        expect(response.ok()).toBe(true);
        snapshot = await response.json();
    }

    return snapshot as RelicApiSnapshot;
}

function playerHeader(player: TestPlayer): Record<string, string> {
    return {
        'x-player-id': player.sessionId,
    };
}

function joinCommand(
    gameId: string,
    player: TestPlayer = {
        sessionId: 'alice-session',
        username: 'Alice',
        characterId: 'kael-ironstride',
    },
): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId,
        username: player.username,
        characterId: player.characterId,
    };
}

function startCommand(gameId: string, player: TestPlayer): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'start-expedition',
        gameId,
        username: player.username,
    };
}

function submitCommand(
    gameId: string,
    player: TestPlayer,
    action: RelicActionInput,
): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'submit-action',
        gameId,
        username: player.username,
        action,
    };
}
