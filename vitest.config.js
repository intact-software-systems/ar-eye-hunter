"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var config_1 = require("vitest/config");
var node_path_1 = require("node:path");
exports.default = (0, config_1.defineConfig)({
    resolve: {
        alias: {
            '@shared-web': node_path_1.default.resolve(__dirname, 'packages/shared-web'),
            '@shared-server': node_path_1.default.resolve(__dirname, 'packages/shared-server'),
            '@shared': node_path_1.default.resolve(__dirname, 'packages/shared'),
            '@shared-graph': node_path_1.default.resolve(__dirname, 'packages/shared-graph'),
            '@relic-hunters': node_path_1.default.resolve(__dirname, 'packages/relic-hunters'),
        },
    },
    test: {
        include: ['packages/tests/**/*.test.ts'],
        exclude: ['packages/tests/dummy.test.ts'],
        environment: 'node',
        globals: true,
        setupFiles: ['packages/tests/setup-vitest.ts'],
    },
});
