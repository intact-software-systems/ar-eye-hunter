// prisma.config.ts
import { defineConfig, env } from 'prisma/config';

declare const process: {
    loadEnvFile?: (path?: string) => void;
};

process.loadEnvFile?.('.env');

export default defineConfig({
    schema: 'prisma/schema.prisma',
    migrations: {
        path: 'prisma/migrations',
    },
    datasource: {
        url: env('DATABASE_URL'),
    },
});
