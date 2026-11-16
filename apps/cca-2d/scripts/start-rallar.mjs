import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const publicUrl = new URL(process.env.CCA_RALLAR_PUBLIC_URL || 'http://localhost:8084');
const port = process.env.CCA_RALLAR_PORT || '8084';
const hosts = [
    'localhost',
    '127.0.0.1',
    ...Object.values(networkInterfaces()).flatMap((addresses) =>
        (addresses || []).filter((address) => address.family === 'IPv4' && !address.internal).map((address) =>
            address.address
        )
    )
];
const corsOrigins = [
    publicUrl.origin,
    ...hosts.flatMap((host) => [5180, 5182, 5183].map((frontendPort) => `http://${host}:${frontendPort}`))
];
const server = spawn('bun', ['--no-env-file', 'run', 'apps/api-v1/src/main.ts'], {
    cwd: root,
    stdio: 'inherit',
    env: {
        ...process.env,
        RALLAR_API_CONFIGURATION_PROFILE: 'prod-in-memory',
        PORT: port,
        RALLAR_API_BASE_URL: publicUrl.origin,
        RALLAR_WS_BASE_URL: publicUrl.origin.replace(/^http/, 'ws'),
        CORS_ORIGINS: corsOrigins.join(','),
        RALLAR_AUTH_CREDENTIAL_SECRET: randomBytes(32).toString('hex'),
        RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET: randomBytes(32).toString('hex')
    }
});
server.on('error', (error) => {
    console.error(`Could not start local Rallar: ${error.message}`);
    process.exitCode = 1;
});
server.on('exit', (code) => {
    process.exitCode = code ?? 1;
});
process.on('SIGINT', () => server.kill('SIGINT'));
process.on('SIGTERM', () => server.kill('SIGTERM'));
