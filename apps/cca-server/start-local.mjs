import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const origin = new URL(process.env.CCA_ORIGIN ?? 'http://localhost:5180');
const websocket = new URL(origin);
websocket.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
const server = spawn('bun', ['src/main.ts'], {
    cwd: new URL('.', import.meta.url),
    stdio: 'inherit',
    env: {
        ...process.env,
        RALLAR_API_CONFIGURATION_PROFILE: 'prod-in-memory',
        PORT: '8092',
        RALLAR_API_BASE_URL: origin.origin,
        RALLAR_WS_BASE_URL: websocket.origin,
        CORS_ORIGINS: origin.origin,
        RALLAR_TIMING_LOGS: 'false',
        RALLAR_AUTH_CREDENTIAL_SECRET: randomBytes(32).toString('hex'),
        RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET: randomBytes(32).toString('hex')
    }
});
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.kill(signal));
}
server.on('error', (error) => {
    console.error('Could not start the local market server:', error.message);
    process.exitCode = 1;
});
server.on('exit', (code) => {
    process.exitCode = code ?? 0;
});
