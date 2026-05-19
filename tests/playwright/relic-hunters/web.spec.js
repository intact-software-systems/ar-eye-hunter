"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
var node_fs_1 = require("node:fs");
var test_1 = require("@playwright/test");
var SESSION_TTL_MS = 60 * 60 * 1000;
var session = {
    clientId: 'alice-client',
    accessToken: 'alice-token',
    username: 'alice',
    sessionId: 'alice-session',
    expiresAtEpochMs: Date.now() + SESSION_TTL_MS,
};
var SCENE_BASELINE_DIR = 'apps/relic-hunters-v1/baseline/screenshots/scene-upgrades';
var WRITE_SCENE_BASELINES = process.env.RELIC_SCENE_BASELINE_WRITE === '1' ||
    process.env.RELIC_SCENE_BASELINE_WRITE === 'true';
test_1.test.describe('Relic Hunters web app', function () {
    (0, test_1.test)('renders a Babylon opening scene before authentication', function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
        var canvas;
        var page = _b.page;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, installBrowserDoubles(page)];
                case 1:
                    _c.sent();
                    return [4 /*yield*/, mockBackend(page, { rooms: [] })];
                case 2:
                    _c.sent();
                    return [4 /*yield*/, page.goto('/')];
                case 3:
                    _c.sent();
                    canvas = page.locator('canvas.relic-scene');
                    return [4 /*yield*/, (0, test_1.expect)(canvas).toBeVisible()];
                case 4:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.locator('.relic-scene-fallback')).toHaveCount(0)];
                case 5:
                    _c.sent();
                    return [4 /*yield*/, test_1.expect.poll(function () { return sceneHasVisiblePixels(page); }).toBe(true)];
                case 6:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByRole('button', { name: 'Login' })).toBeVisible()];
                case 7:
                    _c.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, test_1.test)('captures scene upgrade baselines and verifies canvas render contracts', function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
        var baselineMetrics, scenarios, _loop_1, _i, scenarios_1, scenario;
        var _c, _d, _e;
        var browser = _b.browser;
        return __generator(this, function (_f) {
            switch (_f.label) {
                case 0:
                    test_1.test.slow();
                    test_1.test.setTimeout(240000);
                    baselineMetrics = [];
                    scenarios = [
                        {
                            name: 'opening-desktop',
                            mode: 'opening',
                            viewport: { width: 1280, height: 720 },
                            expectedLightingPreset: 'day',
                        },
                        {
                            name: 'lobby-desktop',
                            mode: 'room',
                            viewport: { width: 1280, height: 720 },
                            snapshot: relicSnapshotWithPlayers(1, 'lobby'),
                            expectedLightingPreset: 'day',
                            wait: function (page) { return __awaiter(void 0, void 0, void 0, function () {
                                return __generator(this, function (_a) {
                                    switch (_a.label) {
                                        case 0: return [4 /*yield*/, (0, test_1.expect)(page.getByText('Keeper: Alice')).toBeVisible()];
                                        case 1:
                                            _a.sent();
                                            return [4 /*yield*/, (0, test_1.expect)(page.getByRole('button', { name: /^Start$/ })).toBeVisible()];
                                        case 2:
                                            _a.sent();
                                            return [2 /*return*/];
                                    }
                                });
                            }); },
                        },
                        {
                            name: 'planning-desktop',
                            mode: 'room',
                            viewport: { width: 1280, height: 720 },
                            snapshot: relicSnapshotWithPlayers(1, 'planning', { includeStorage: true }),
                            expectedCameraMode: 'tactical',
                            expectedLightingPreset: 'day',
                            wait: function (page) { return __awaiter(void 0, void 0, void 0, function () {
                                return __generator(this, function (_a) {
                                    switch (_a.label) {
                                        case 0: return [4 /*yield*/, (0, test_1.expect)(page.getByLabel('Current turn summary')).toContainText('Choose one plan')];
                                        case 1:
                                            _a.sent();
                                            return [4 /*yield*/, (0, test_1.expect)(page.getByRole('button', { name: 'Submit Plan' })).toBeVisible()];
                                        case 2:
                                            _a.sent();
                                            return [2 /*return*/];
                                    }
                                });
                            }); },
                        },
                        {
                            name: 'planning-mobile',
                            mode: 'room',
                            viewport: { width: 390, height: 844 },
                            snapshot: relicSnapshotWithPlayers(1, 'planning', { includeStorage: true }),
                            expectedCameraMode: 'tactical',
                            expectedLightingPreset: 'day',
                            wait: function (page) { return __awaiter(void 0, void 0, void 0, function () {
                                return __generator(this, function (_a) {
                                    switch (_a.label) {
                                        case 0: return [4 /*yield*/, (0, test_1.expect)(page.getByLabel('Current turn summary')).toContainText('Choose one plan')];
                                        case 1:
                                            _a.sent();
                                            return [4 /*yield*/, (0, test_1.expect)(page.getByRole('button', { name: 'Submit Plan' })).toBeVisible()];
                                        case 2:
                                            _a.sent();
                                            return [2 /*return*/];
                                    }
                                });
                            }); },
                        },
                        {
                            name: 'waiting-locked-desktop',
                            mode: 'room',
                            viewport: { width: 1280, height: 720 },
                            snapshot: relicSnapshotWithPlayers(2, 'planning', {
                                submittedPlayerIds: ['alice-session'],
                            }),
                            onlineMemberCount: 2,
                            expectedCameraMode: 'tactical',
                            expectedLightingPreset: 'day',
                            wait: function (page) { return __awaiter(void 0, void 0, void 0, function () {
                                return __generator(this, function (_a) {
                                    switch (_a.label) {
                                        case 0: return [4 /*yield*/, (0, test_1.expect)(page.getByLabel('Current turn summary')).toContainText('Plan Locked')];
                                        case 1:
                                            _a.sent();
                                            return [4 /*yield*/, (0, test_1.expect)(page.getByLabel('Round plan')).toContainText('1 hunter still choosing')];
                                        case 2:
                                            _a.sent();
                                            return [2 /*return*/];
                                    }
                                });
                            }); },
                        },
                        {
                            name: 'split-party-identities-desktop',
                            mode: 'room',
                            viewport: { width: 1280, height: 720 },
                            snapshot: relicSnapshotWithPlayers(4, 'planning', {
                                includeFullMap: true,
                                playerRooms: {
                                    'alice-session': 'entrance',
                                    'bob-session': 'shrine',
                                    'cara-session': 'monster',
                                    'dain-session': 'exit',
                                },
                                playerRelicIds: {
                                    'dain-session': ['sun-disk'],
                                },
                                submittedPlayerIds: ['alice-session', 'cara-session'],
                            }),
                            onlineMemberCount: 4,
                            expectedCameraMode: 'tactical',
                            expectedLightingPreset: 'day',
                            wait: function (page) { return __awaiter(void 0, void 0, void 0, function () {
                                return __generator(this, function (_a) {
                                    switch (_a.label) {
                                        case 0: return [4 /*yield*/, (0, test_1.expect)(page.getByLabel('Current turn summary')).toContainText('Plan Locked')];
                                        case 1:
                                            _a.sent();
                                            return [4 /*yield*/, (0, test_1.expect)(page.getByLabel('Castle room map')).toContainText('Shrine')];
                                        case 2:
                                            _a.sent();
                                            return [4 /*yield*/, (0, test_1.expect)(page.getByLabel('Castle room map')).toContainText('Monster')];
                                        case 3:
                                            _a.sent();
                                            return [4 /*yield*/, (0, test_1.expect)(page.getByLabel('Castle room map')).toContainText('Treasure')];
                                        case 4:
                                            _a.sent();
                                            return [4 /*yield*/, (0, test_1.expect)(page.getByLabel('Room occupants')).toContainText('1 hunter here / 3 elsewhere')];
                                        case 5:
                                            _a.sent();
                                            return [2 /*return*/];
                                    }
                                });
                            }); },
                        },
                        {
                            name: 'resolved-timeline-desktop',
                            mode: 'room',
                            viewport: { width: 1280, height: 720 },
                            snapshot: relicSnapshotWithPlayers(1, 'planning', {
                                includeStorage: true,
                                playerRoomId: 'storage',
                            }),
                            commandSnapshot: resolvedStorageSearchSnapshot(),
                            expectedCameraMode: 'tactical',
                            expectedLightingPreset: 'lantern',
                            wait: function (page) { return __awaiter(void 0, void 0, void 0, function () {
                                return __generator(this, function (_a) {
                                    switch (_a.label) {
                                        case 0: return [4 /*yield*/, (0, test_1.expect)(page.getByLabel('Current turn summary')).toContainText('Choose one plan', { timeout: 15000 })];
                                        case 1:
                                            _a.sent();
                                            return [4 /*yield*/, (0, test_1.expect)(page.getByRole('button', { name: 'Submit Plan' })).toBeEnabled()];
                                        case 2:
                                            _a.sent();
                                            return [4 /*yield*/, page.getByRole('button', { name: 'Submit Plan' }).click()];
                                        case 3:
                                            _a.sent();
                                            return [4 /*yield*/, (0, test_1.expect)(page.getByLabel('Turn timeline')).toContainText('Alice searched the crates and marked a false supply trail.', { timeout: 15000 })];
                                        case 4:
                                            _a.sent();
                                            return [2 /*return*/];
                                    }
                                });
                            }); },
                        },
                        {
                            name: 'finished-desktop',
                            mode: 'room',
                            viewport: { width: 1280, height: 720 },
                            snapshot: finishedRelicSnapshot(),
                            expectedLightingPreset: 'sunset',
                            wait: function (page) { return __awaiter(void 0, void 0, void 0, function () {
                                return __generator(this, function (_a) {
                                    switch (_a.label) {
                                        case 0: return [4 /*yield*/, (0, test_1.expect)(page.getByText('The Heart Relic has chosen')).toBeVisible()];
                                        case 1:
                                            _a.sent();
                                            return [4 /*yield*/, (0, test_1.expect)(page.getByText('Final score: 5')).toBeVisible()];
                                        case 2:
                                            _a.sent();
                                            return [2 /*return*/];
                                    }
                                });
                            }); },
                        },
                    ];
                    _loop_1 = function (scenario) {
                        var context, page, metrics, screenshot;
                        return __generator(this, function (_g) {
                            switch (_g.label) {
                                case 0: return [4 /*yield*/, browser.newContext({
                                        viewport: scenario.viewport,
                                        deviceScaleFactor: 2,
                                    })];
                                case 1:
                                    context = _g.sent();
                                    return [4 /*yield*/, context.newPage()];
                                case 2:
                                    page = _g.sent();
                                    _g.label = 3;
                                case 3:
                                    _g.trys.push([3, , 17, 19]);
                                    return [4 /*yield*/, installBrowserDoubles(page)];
                                case 4:
                                    _g.sent();
                                    if (!(scenario.mode === 'room')) return [3 /*break*/, 6];
                                    return [4 /*yield*/, restoreRoomSession(page)];
                                case 5:
                                    _g.sent();
                                    _g.label = 6;
                                case 6: return [4 /*yield*/, mockBackend(page, {
                                        rooms: scenario.mode === 'room'
                                            ? [groupSnapshot({ onlineMemberCount: (_c = scenario.onlineMemberCount) !== null && _c !== void 0 ? _c : 1 })]
                                            : [],
                                        relicSnapshot: (_d = scenario.snapshot) !== null && _d !== void 0 ? _d : emptyRelicSnapshot(),
                                        commandSnapshot: scenario.commandSnapshot,
                                    })];
                                case 7:
                                    _g.sent();
                                    return [4 /*yield*/, page.goto('http://127.0.0.1:5175/')];
                                case 8:
                                    _g.sent();
                                    if (!(scenario.mode === 'room')) return [3 /*break*/, 11];
                                    return [4 /*yield*/, openListedRoomIfNeeded(page)];
                                case 9:
                                    _g.sent();
                                    return [4 /*yield*/, ((_e = scenario.wait) === null || _e === void 0 ? void 0 : _e.call(scenario, page))];
                                case 10:
                                    _g.sent();
                                    return [3 /*break*/, 13];
                                case 11: return [4 /*yield*/, (0, test_1.expect)(page.getByRole('button', { name: 'Login' })).toBeVisible()];
                                case 12:
                                    _g.sent();
                                    _g.label = 13;
                                case 13: return [4 /*yield*/, test_1.expect.poll(function () { return sceneCanvasMetrics(page); }, {
                                        message: "".concat(scenario.name, " canvas should render visible high-DPI pixels"),
                                        timeout: 20000,
                                    }).toMatchObject(__assign(__assign(__assign({ ready: true, devicePixelRatio: 2, highDpi: true, hasRenderedFrame: true }, (scenario.expectedCameraMode ? { cameraMode: scenario.expectedCameraMode } : {})), (scenario.expectedLightingPreset
                                        ? { lightingPreset: scenario.expectedLightingPreset }
                                        : {})), { assetPipeline: 'procedural' }))];
                                case 14:
                                    _g.sent();
                                    return [4 /*yield*/, sceneCanvasMetrics(page)];
                                case 15:
                                    metrics = _g.sent();
                                    (0, test_1.expect)(metrics.meshCount).toBeGreaterThan(0);
                                    (0, test_1.expect)(metrics.materialCount).toBeGreaterThan(0);
                                    if (scenario.expectedCameraMode) {
                                        (0, test_1.expect)(metrics.activeMeshCount).toBeGreaterThan(0);
                                        (0, test_1.expect)(metrics.readyMs).toBeGreaterThan(0);
                                    }
                                    baselineMetrics.push(__assign({ scenario: scenario.name }, metrics));
                                    return [4 /*yield*/, captureSceneBaseline(page, scenario.name)];
                                case 16:
                                    screenshot = _g.sent();
                                    (0, test_1.expect)(screenshot.byteLength).toBeGreaterThan(10000);
                                    return [3 /*break*/, 19];
                                case 17: return [4 /*yield*/, context.close()];
                                case 18:
                                    _g.sent();
                                    return [7 /*endfinally*/];
                                case 19: return [2 /*return*/];
                            }
                        });
                    };
                    _i = 0, scenarios_1 = scenarios;
                    _f.label = 1;
                case 1:
                    if (!(_i < scenarios_1.length)) return [3 /*break*/, 4];
                    scenario = scenarios_1[_i];
                    return [5 /*yield**/, _loop_1(scenario)];
                case 2:
                    _f.sent();
                    _f.label = 3;
                case 3:
                    _i++;
                    return [3 /*break*/, 1];
                case 4:
                    if (WRITE_SCENE_BASELINES) {
                        (0, node_fs_1.mkdirSync)(SCENE_BASELINE_DIR, { recursive: true });
                        (0, node_fs_1.writeFileSync)("".concat(SCENE_BASELINE_DIR, "/scene-upgrade-metrics.json"), "".concat(JSON.stringify(baselineMetrics, null, 2), "\n"));
                    }
                    return [2 /*return*/];
            }
        });
    }); });
    (0, test_1.test)('registers a player and shows the connected lobby controls', function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
        var page = _b.page;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, installBrowserDoubles(page)];
                case 1:
                    _c.sent();
                    return [4 /*yield*/, mockBackend(page, { rooms: [] })];
                case 2:
                    _c.sent();
                    return [4 /*yield*/, page.goto('/')];
                case 3:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Register' }).click()];
                case 4:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Username').fill('alice')];
                case 5:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Display name').fill('Alice')];
                case 6:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Password').fill('correct-horse')];
                case 7:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Create Hunter' }).click()];
                case 8:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByRole('button', { name: 'New Room' })).toBeVisible()];
                case 9:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByRole('button', { name: 'Atmosphere' })).toBeVisible()];
                case 10:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByText('alice', { exact: true })).toBeVisible()];
                case 11:
                    _c.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, test_1.test)('captures core lobby layouts at desktop and mobile viewports', function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
        var desktop, mobile;
        var page = _b.page;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, installBrowserDoubles(page)];
                case 1:
                    _c.sent();
                    return [4 /*yield*/, mockBackend(page, {
                            rooms: [groupSnapshot({ onlineMemberCount: 1 })],
                            relicSnapshot: emptyRelicSnapshot(),
                        })];
                case 2:
                    _c.sent();
                    return [4 /*yield*/, page.setViewportSize({ width: 1280, height: 720 })];
                case 3:
                    _c.sent();
                    return [4 /*yield*/, page.goto('/')];
                case 4:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Register' }).click()];
                case 5:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Username').fill('alice')];
                case 6:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Display name').fill('Alice')];
                case 7:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Password').fill('correct-horse')];
                case 8:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Create Hunter' }).click()];
                case 9:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByRole('button', { name: 'Relic Hunters Expedition' })).toBeVisible()];
                case 10:
                    _c.sent();
                    return [4 /*yield*/, page.screenshot({ animations: 'disabled' })];
                case 11:
                    desktop = _c.sent();
                    (0, test_1.expect)(desktop.byteLength).toBeGreaterThan(10000);
                    return [4 /*yield*/, page.setViewportSize({ width: 390, height: 844 })];
                case 12:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByRole('button', { name: 'Relic Hunters Expedition' })).toBeVisible()];
                case 13:
                    _c.sent();
                    return [4 /*yield*/, test_1.expect.poll(function () { return page.locator('.hud-region-side').evaluate(function (el) { return getComputedStyle(el).overflow; }); })
                            .toBe('visible')];
                case 14:
                    _c.sent();
                    return [4 /*yield*/, page.screenshot({ animations: 'disabled' })];
                case 15:
                    mobile = _c.sent();
                    (0, test_1.expect)(mobile.byteLength).toBeGreaterThan(10000);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, test_1.test)('keeps large-screen side menus reachable', function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
        var room, menu, sideWidth, bottomRight, sideLeft, scrollMetrics;
        var page = _b.page;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    test_1.test.slow();
                    room = groupSnapshot({ onlineMemberCount: 1 });
                    return [4 /*yield*/, page.setViewportSize({ width: 1920, height: 1080 })];
                case 1:
                    _c.sent();
                    return [4 /*yield*/, installBrowserDoubles(page)];
                case 2:
                    _c.sent();
                    return [4 /*yield*/, mockBackend(page, {
                            rooms: [room],
                            relicSnapshot: relicSnapshotWithPlayers(1, 'planning'),
                        })];
                case 3:
                    _c.sent();
                    return [4 /*yield*/, page.addInitScript(function (storedSession) {
                            window.localStorage.setItem('auth.session', JSON.stringify(storedSession));
                        }, session)];
                case 4:
                    _c.sent();
                    return [4 /*yield*/, page.goto('/')];
                case 5:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Relic Hunters Expedition' }).click({ force: true })];
                case 6:
                    _c.sent();
                    menu = page.getByRole('navigation', { name: 'Side panel sections' });
                    return [4 /*yield*/, (0, test_1.expect)(menu.getByRole('button', { name: 'Rooms' })).toBeVisible()];
                case 7:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(menu.getByRole('button', { name: 'Plan' })).toBeVisible()];
                case 8:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(menu.getByRole('button', { name: 'Map' })).toBeVisible()];
                case 9:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(menu.getByRole('button', { name: 'Intel' })).toBeVisible()];
                case 10:
                    _c.sent();
                    return [4 /*yield*/, page.locator('.hud-region-side').evaluate(function (el) { return el.getBoundingClientRect().width; })];
                case 11:
                    sideWidth = _c.sent();
                    (0, test_1.expect)(sideWidth).toBeGreaterThan(700);
                    return [4 /*yield*/, page.locator('.hud-region-bottom').evaluate(function (el) { return el.getBoundingClientRect().right; })];
                case 12:
                    bottomRight = _c.sent();
                    return [4 /*yield*/, page.locator('.hud-region-side').evaluate(function (el) { return el.getBoundingClientRect().left; })];
                case 13:
                    sideLeft = _c.sent();
                    (0, test_1.expect)(bottomRight).toBeLessThanOrEqual(sideLeft);
                    return [4 /*yield*/, page.locator('.side-panel').evaluate(function (el) {
                            var _a, _b;
                            el.scrollTop = el.scrollHeight;
                            var panelBox = el.getBoundingClientRect();
                            var lastChildBox = (_a = el.lastElementChild) === null || _a === void 0 ? void 0 : _a.getBoundingClientRect();
                            return {
                                clientHeight: el.clientHeight,
                                scrollHeight: el.scrollHeight,
                                scrollTop: el.scrollTop,
                                panelBottom: panelBox.bottom,
                                lastChildBottom: (_b = lastChildBox === null || lastChildBox === void 0 ? void 0 : lastChildBox.bottom) !== null && _b !== void 0 ? _b : panelBox.bottom,
                            };
                        })];
                case 14:
                    scrollMetrics = _c.sent();
                    (0, test_1.expect)(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
                    (0, test_1.expect)(scrollMetrics.scrollTop).toBeGreaterThan(0);
                    (0, test_1.expect)(scrollMetrics.lastChildBottom).toBeLessThanOrEqual(scrollMetrics.panelBottom + 1);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, test_1.test)('joins a room and prompts when expedition players no longer match online party', function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
        var room;
        var page = _b.page;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    room = groupSnapshot({ onlineMemberCount: 1 });
                    return [4 /*yield*/, installBrowserDoubles(page)];
                case 1:
                    _c.sent();
                    return [4 /*yield*/, mockBackend(page, {
                            rooms: [room],
                            relicSnapshot: relicSnapshotWithPlayers(2),
                        })];
                case 2:
                    _c.sent();
                    return [4 /*yield*/, page.goto('/')];
                case 3:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Register' }).click()];
                case 4:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Username').fill('alice')];
                case 5:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Display name').fill('Alice')];
                case 6:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Password').fill('correct-horse')];
                case 7:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Create Hunter' }).click()];
                case 8:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Relic Hunters Expedition' }).click({ force: true })];
                case 9:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByText('Party Changed')).toBeVisible()];
                case 10:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByText('1/2 hunters are online')).toBeVisible()];
                case 11:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByText(/Offline joined hunters can hold a round until the timer expires/)).toBeVisible()];
                case 12:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByRole('button', { name: 'Start Over' })).toBeVisible()];
                case 13:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByRole('button', { name: 'Keep Going' })).toBeVisible()];
                case 14:
                    _c.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, test_1.test)('can reset when a joined expedition has lost players', function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
        var room;
        var page = _b.page;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    room = groupSnapshot({ onlineMemberCount: 1 });
                    return [4 /*yield*/, installBrowserDoubles(page)];
                case 1:
                    _c.sent();
                    return [4 /*yield*/, mockBackend(page, {
                            rooms: [room],
                            relicSnapshot: relicSnapshotWithPlayers(2),
                        })];
                case 2:
                    _c.sent();
                    return [4 /*yield*/, page.goto('/')];
                case 3:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Register' }).click()];
                case 4:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Username').fill('alice')];
                case 5:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Display name').fill('Alice')];
                case 6:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Password').fill('correct-horse')];
                case 7:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Create Hunter' }).click()];
                case 8:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Relic Hunters Expedition' }).click({ force: true })];
                case 9:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByText('Party Changed')).toBeVisible()];
                case 10:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Start Over' }).click()];
                case 11:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByText('Party Changed')).toBeHidden()];
                case 12:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByRole('button', { name: /Join as/ })).toBeVisible()];
                case 13:
                    _c.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, test_1.test)('can continue a mismatched expedition without resetting it', function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
        var room, requests;
        var page = _b.page;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    room = groupSnapshot({ onlineMemberCount: 1 });
                    requests = [];
                    return [4 /*yield*/, installBrowserDoubles(page)];
                case 1:
                    _c.sent();
                    return [4 /*yield*/, mockBackend(page, {
                            rooms: [room],
                            relicSnapshot: relicSnapshotWithPlayers(2),
                            requests: requests,
                        })];
                case 2:
                    _c.sent();
                    return [4 /*yield*/, page.goto('/')];
                case 3:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Register' }).click()];
                case 4:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Username').fill('alice')];
                case 5:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Display name').fill('Alice')];
                case 6:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Password').fill('correct-horse')];
                case 7:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Create Hunter' }).click()];
                case 8:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Relic Hunters Expedition' }).click()];
                case 9:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByText('Party Changed')).toBeVisible()];
                case 10:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Keep Going' }).click()];
                case 11:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByText('Party Changed')).toBeHidden()];
                case 12:
                    _c.sent();
                    (0, test_1.expect)(requests).not.toContain('POST /api/relic/games/room-1/reset');
                    return [2 /*return*/];
            }
        });
    }); });
    (0, test_1.test)('shows lobby membership and start blockers when online members have not joined', function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
        var room;
        var page = _b.page;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    room = groupSnapshot({ onlineMemberCount: 2 });
                    return [4 /*yield*/, installBrowserDoubles(page)];
                case 1:
                    _c.sent();
                    return [4 /*yield*/, mockBackend(page, {
                            rooms: [room],
                            relicSnapshot: relicSnapshotWithPlayers(1),
                        })];
                case 2:
                    _c.sent();
                    return [4 /*yield*/, page.goto('/')];
                case 3:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Register' }).click()];
                case 4:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Username').fill('alice')];
                case 5:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Display name').fill('Alice')];
                case 6:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Password').fill('correct-horse')];
                case 7:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Create Hunter' }).click()];
                case 8:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Relic Hunters Expedition' }).click()];
                case 9:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByText('Keeper: Alice')).toBeVisible()];
                case 10:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByText('Online room members', { exact: true })).toBeVisible()];
                case 11:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByText('Joined expedition hunters', { exact: true })).toBeVisible()];
                case 12:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByText('1 online room member still needs to join.')).toBeVisible()];
                case 13:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByRole('button', { name: /^Start$/ })).toBeDisabled()];
                case 14:
                    _c.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, test_1.test)('sends room-scoped relic commands from the browser UI', function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
        var room, commandBodies;
        var page = _b.page;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    room = groupSnapshot({ onlineMemberCount: 1 });
                    commandBodies = [];
                    return [4 /*yield*/, installBrowserDoubles(page)];
                case 1:
                    _c.sent();
                    return [4 /*yield*/, mockBackend(page, {
                            rooms: [room],
                            relicSnapshot: emptyRelicSnapshot(),
                            commandBodies: commandBodies,
                        })];
                case 2:
                    _c.sent();
                    return [4 /*yield*/, page.goto('/')];
                case 3:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Register' }).click()];
                case 4:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Username').fill('alice')];
                case 5:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Display name').fill('Alice')];
                case 6:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Password').fill('correct-horse')];
                case 7:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Create Hunter' }).click()];
                case 8:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Relic Hunters Expedition' }).click()];
                case 9:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: /Join as/ }).click()];
                case 10:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Start' }).click()];
                case 11:
                    _c.sent();
                    (0, test_1.expect)(commandBodies).toHaveLength(2);
                    (0, test_1.expect)(commandBodies[0]).toMatchObject({
                        protocolVersion: 1,
                        kind: 'join-expedition',
                        gameId: 'room-1',
                        username: 'alice',
                        characterId: 'kael-ironstride',
                    });
                    (0, test_1.expect)(commandBodies[1]).toMatchObject({
                        protocolVersion: 1,
                        kind: 'start-expedition',
                        gameId: 'room-1',
                        username: 'alice',
                    });
                    return [2 /*return*/];
            }
        });
    }); });
    (0, test_1.test)('can force-resolve a timed-out round from the browser UI', function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
        var room, commandBodies;
        var page = _b.page;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    room = groupSnapshot({ onlineMemberCount: 2 });
                    commandBodies = [];
                    return [4 /*yield*/, installBrowserDoubles(page)];
                case 1:
                    _c.sent();
                    return [4 /*yield*/, mockBackend(page, {
                            rooms: [room],
                            relicSnapshot: relicSnapshotWithPlayers(2, 'planning', {
                                submittedPlayerIds: ['alice-session'],
                                roundStartedAtEpochMs: Date.now() - 90000,
                                roundTimeLimitMs: 60000,
                            }),
                            commandBodies: commandBodies,
                            commandSnapshot: resolvedSearchSnapshot(),
                        })];
                case 2:
                    _c.sent();
                    return [4 /*yield*/, page.goto('/')];
                case 3:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Register' }).click()];
                case 4:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Username').fill('alice')];
                case 5:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Display name').fill('Alice')];
                case 6:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Password').fill('correct-horse')];
                case 7:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Create Hunter' }).click()];
                case 8:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Relic Hunters Expedition' }).click()];
                case 9:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByText('1 timed-out hunter.')).toBeVisible()];
                case 10:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Resolve Timed-Out Round' }).click()];
                case 11:
                    _c.sent();
                    (0, test_1.expect)(commandBodies).toHaveLength(1);
                    (0, test_1.expect)(commandBodies[0]).toMatchObject({
                        protocolVersion: 1,
                        kind: 'force-resolve-round',
                        gameId: 'room-1',
                        username: 'alice',
                    });
                    return [2 /*return*/];
            }
        });
    }); });
    (0, test_1.test)('creates a room and completes the first playable turn through the browser UI', function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
        var commandBodies, timeline;
        var page = _b.page;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    test_1.test.setTimeout(60000);
                    commandBodies = [];
                    return [4 /*yield*/, installBrowserDoubles(page)];
                case 1:
                    _c.sent();
                    return [4 /*yield*/, mockBackend(page, {
                            rooms: [],
                            relicSnapshot: emptyRelicSnapshot(),
                            commandBodies: commandBodies,
                            commandResponse: function (body) {
                                var kind = body === null || body === void 0 ? void 0 : body.kind;
                                if (kind === 'join-expedition')
                                    return relicSnapshotWithPlayers(1);
                                if (kind === 'start-expedition')
                                    return relicSnapshotWithPlayers(1, 'planning');
                                if (kind === 'submit-action')
                                    return resolvedSearchSnapshot();
                                return relicSnapshotWithPlayers(1);
                            },
                        })];
                case 2:
                    _c.sent();
                    return [4 /*yield*/, page.goto('/')];
                case 3:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Register' }).click()];
                case 4:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Username').fill('alice')];
                case 5:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Display name').fill('Alice')];
                case 6:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Password').fill('correct-horse')];
                case 7:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Create Hunter' }).click()];
                case 8:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'New Room' }).click()];
                case 9:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByRole('button', { name: /Join as/ })).toBeVisible()];
                case 10:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: /Join as/ }).click()];
                case 11:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByText('Keeper: Alice')).toBeVisible()];
                case 12:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.locator('.lobby-begin-btn')).toBeEnabled()];
                case 13:
                    _c.sent();
                    return [4 /*yield*/, page.locator('.lobby-begin-btn').click()];
                case 14:
                    _c.sent();
                    return [4 /*yield*/, test_1.expect.poll(function () { return commandBodies.length; }).toBe(2)];
                case 15:
                    _c.sent();
                    (0, test_1.expect)(commandBodies.at(-1).kind).toBe('start-expedition');
                    return [4 /*yield*/, (0, test_1.expect)(page.getByLabel('Current turn summary')).toContainText('Choose one plan', { timeout: 15000 })];
                case 16:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Submit Plan' }).click()];
                case 17:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByLabel('Current turn summary')).toContainText('Choose one plan', { timeout: 15000 })];
                case 18:
                    _c.sent();
                    timeline = page.getByLabel('Turn timeline');
                    return [4 /*yield*/, (0, test_1.expect)(timeline).toContainText('Reveal', { timeout: 20000 })];
                case 19:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(timeline).toContainText('Your Action', { timeout: 20000 })];
                case 20:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(timeline).toContainText('Result', { timeout: 20000 })];
                case 21:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(timeline).toContainText('Alice searched the Entrance.', { timeout: 20000 })];
                case 22:
                    _c.sent();
                    (0, test_1.expect)(commandBodies.map(function (body) { return body.kind; })).toEqual([
                        'join-expedition',
                        'start-expedition',
                        'submit-action',
                    ]);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, test_1.test)('renders a nonblank Babylon scene and tolerates pointer look', function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
        var room, canvas, box;
        var page = _b.page;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    room = groupSnapshot({ onlineMemberCount: 1 });
                    return [4 /*yield*/, installBrowserDoubles(page)];
                case 1:
                    _c.sent();
                    return [4 /*yield*/, mockBackend(page, {
                            rooms: [room],
                            relicSnapshot: relicSnapshotWithPlayers(1, 'planning'),
                        })];
                case 2:
                    _c.sent();
                    return [4 /*yield*/, page.goto('/')];
                case 3:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Register' }).click()];
                case 4:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Username').fill('alice')];
                case 5:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Display name').fill('Alice')];
                case 6:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Password').fill('correct-horse')];
                case 7:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Create Hunter' }).click()];
                case 8:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Relic Hunters Expedition' }).click()];
                case 9:
                    _c.sent();
                    canvas = page.locator('canvas.relic-scene');
                    return [4 /*yield*/, (0, test_1.expect)(canvas).toBeVisible()];
                case 10:
                    _c.sent();
                    return [4 /*yield*/, test_1.expect.poll(function () { return sceneHasVisiblePixels(page); }).toBe(true)];
                case 11:
                    _c.sent();
                    return [4 /*yield*/, canvas.boundingBox()];
                case 12:
                    box = _c.sent();
                    (0, test_1.expect)(box).not.toBeNull();
                    if (!box) return [3 /*break*/, 17];
                    return [4 /*yield*/, page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)];
                case 13:
                    _c.sent();
                    return [4 /*yield*/, page.mouse.down()];
                case 14:
                    _c.sent();
                    return [4 /*yield*/, page.mouse.move(box.x + box.width / 2 + 48, box.y + box.height / 2 + 24)];
                case 15:
                    _c.sent();
                    return [4 /*yield*/, page.mouse.up()];
                case 16:
                    _c.sent();
                    _c.label = 17;
                case 17: return [4 /*yield*/, (0, test_1.expect)(page.getByRole('button', { name: 'Atmosphere' }).first()).toBeVisible()];
                case 18:
                    _c.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, test_1.test)('scene doorway prompt primes a move plan without submitting it', function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
        var room, commandBodies, canvas, movePrompt;
        var page = _b.page;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    room = groupSnapshot({ onlineMemberCount: 1 });
                    commandBodies = [];
                    return [4 /*yield*/, installBrowserDoubles(page)];
                case 1:
                    _c.sent();
                    return [4 /*yield*/, mockBackend(page, {
                            rooms: [room],
                            relicSnapshot: relicSnapshotWithPlayers(1, 'planning'),
                            commandBodies: commandBodies,
                        })];
                case 2:
                    _c.sent();
                    return [4 /*yield*/, page.goto('/')];
                case 3:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Register' }).click()];
                case 4:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Username').fill('alice')];
                case 5:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Display name').fill('Alice')];
                case 6:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Password').fill('correct-horse')];
                case 7:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Create Hunter' }).click()];
                case 8:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Relic Hunters Expedition' }).click()];
                case 9:
                    _c.sent();
                    canvas = page.locator('canvas.relic-scene');
                    return [4 /*yield*/, (0, test_1.expect)(canvas).toBeVisible()];
                case 10:
                    _c.sent();
                    return [4 /*yield*/, test_1.expect.poll(function () { return sceneHasVisiblePixels(page); }).toBe(true)];
                case 11:
                    _c.sent();
                    return [4 /*yield*/, page.keyboard.down('w')];
                case 12:
                    _c.sent();
                    movePrompt = page.getByRole('button', { name: /Move to Hallway/ });
                    return [4 /*yield*/, (0, test_1.expect)(movePrompt).toBeVisible({ timeout: 15000 })];
                case 13:
                    _c.sent();
                    return [4 /*yield*/, movePrompt.click()];
                case 14:
                    _c.sent();
                    return [4 /*yield*/, page.keyboard.up('w')];
                case 15:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByText('Step into an adjacent room')).toBeVisible()];
                case 16:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByRole('button', { name: 'Submit Plan' })).toBeEnabled()];
                case 17:
                    _c.sent();
                    (0, test_1.expect)(commandBodies).toHaveLength(0);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, test_1.test)('scene objective panel primes the recommended room action', function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
        var room, commandBodies, objective;
        var page = _b.page;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    room = groupSnapshot({ onlineMemberCount: 1 });
                    commandBodies = [];
                    return [4 /*yield*/, installBrowserDoubles(page)];
                case 1:
                    _c.sent();
                    return [4 /*yield*/, mockBackend(page, {
                            rooms: [room],
                            relicSnapshot: relicSnapshotWithPlayers(1, 'planning'),
                            commandBodies: commandBodies,
                        })];
                case 2:
                    _c.sent();
                    return [4 /*yield*/, page.goto('/')];
                case 3:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Register' }).click()];
                case 4:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Username').fill('alice')];
                case 5:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Display name').fill('Alice')];
                case 6:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Password').fill('correct-horse')];
                case 7:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Create Hunter' }).click()];
                case 8:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Relic Hunters Expedition' }).click()];
                case 9:
                    _c.sent();
                    objective = page.locator('[aria-label="Room objective"]');
                    return [4 /*yield*/, (0, test_1.expect)(objective.getByText('Move to Hallway')).toBeVisible()];
                case 10:
                    _c.sent();
                    return [4 /*yield*/, objective.getByRole('button', { name: 'Prime Move' }).click()];
                case 11:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByText('Step into an adjacent room')).toBeVisible()];
                case 12:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(objective.getByText('Submit the plan to commit this turn-based move.')).toBeVisible()];
                case 13:
                    _c.sent();
                    (0, test_1.expect)(commandBodies).toHaveLength(0);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, test_1.test)('scene objective panel exposes escape when the hunter reaches the exit', function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
        var room, commandBodies, objective;
        var page = _b.page;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    room = groupSnapshot({ onlineMemberCount: 1 });
                    commandBodies = [];
                    return [4 /*yield*/, installBrowserDoubles(page)];
                case 1:
                    _c.sent();
                    return [4 /*yield*/, mockBackend(page, {
                            rooms: [room],
                            relicSnapshot: relicSnapshotWithPlayers(1, 'planning', {
                                carryRelic: true,
                                includeExit: true,
                                playerRoomId: 'exit',
                            }),
                            commandBodies: commandBodies,
                        })];
                case 2:
                    _c.sent();
                    return [4 /*yield*/, page.goto('/')];
                case 3:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Register' }).click()];
                case 4:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Username').fill('alice')];
                case 5:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Display name').fill('Alice')];
                case 6:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Password').fill('correct-horse')];
                case 7:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Create Hunter' }).click()];
                case 8:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Relic Hunters Expedition' }).click()];
                case 9:
                    _c.sent();
                    objective = page.locator('[aria-label="Room objective"]');
                    return [4 /*yield*/, (0, test_1.expect)(objective.getByText('Escape with your relics')).toBeVisible()];
                case 10:
                    _c.sent();
                    return [4 /*yield*/, objective.getByRole('button', { name: 'Prime Escape' }).click()];
                case 11:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByText('Leave from the Exit with your relics')).toBeVisible()];
                case 12:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(objective.getByText('Escape is primed')).toBeVisible()];
                case 13:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByRole('button', { name: 'Submit Plan' })).toBeEnabled()];
                case 14:
                    _c.sent();
                    (0, test_1.expect)(commandBodies).toHaveLength(0);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, test_1.test)('shows party coordination and map occupancy for a split party', function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
        var room, occupants;
        var page = _b.page;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    room = groupSnapshot({ onlineMemberCount: 4 });
                    return [4 /*yield*/, installBrowserDoubles(page)];
                case 1:
                    _c.sent();
                    return [4 /*yield*/, mockBackend(page, {
                            rooms: [room],
                            relicSnapshot: relicSnapshotWithPlayers(4, 'planning', {
                                includeStorage: true,
                                playerRooms: {
                                    'alice-session': 'storage',
                                    'bob-session': 'storage',
                                    'cara-session': 'trap',
                                    'dain-session': 'hallway',
                                },
                                playerRelicIds: {
                                    'bob-session': ['sun-disk'],
                                },
                                playerScores: {
                                    'bob-session': 6,
                                    'cara-session': 1,
                                },
                                submittedPlayerIds: ['alice-session', 'cara-session'],
                            }),
                        })];
                case 2:
                    _c.sent();
                    return [4 /*yield*/, page.goto('/')];
                case 3:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Register' }).click()];
                case 4:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Username').fill('alice')];
                case 5:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Display name').fill('Alice')];
                case 6:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Password').fill('correct-horse')];
                case 7:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Create Hunter' }).click()];
                case 8:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Relic Hunters Expedition' }).click()];
                case 9:
                    _c.sent();
                    occupants = page.getByLabel('Room occupants');
                    return [4 /*yield*/, (0, test_1.expect)(occupants).toContainText('2 hunters here / 2 elsewhere')];
                case 10:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(occupants).toContainText('2/4 plans locked')];
                case 11:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(occupants).toContainText('Storage')];
                case 12:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(occupants).toContainText('Bob')];
                case 13:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(occupants).toContainText('1 relic')];
                case 14:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(occupants).toContainText('Searching makes noise for 2 hunters in Storage.')];
                case 15:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByLabel('2 hunters in Storage')).toBeVisible()];
                case 16:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByLabel('1 hunter in Trap Room')).toBeVisible()];
                case 17:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByLabel('1 hunter in Hallway')).toBeVisible()];
                case 18:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: /Steal/ }).click()];
                case 19:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(occupants).toContainText('Steal is possible here: Bob carries 1 relic.')];
                case 20:
                    _c.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, test_1.test)('resolved search marks the room objective as investigated', function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
        var room, objective, timeline;
        var page = _b.page;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    room = groupSnapshot({ onlineMemberCount: 1 });
                    return [4 /*yield*/, installBrowserDoubles(page)];
                case 1:
                    _c.sent();
                    return [4 /*yield*/, mockBackend(page, {
                            rooms: [room],
                            relicSnapshot: relicSnapshotWithPlayers(1, 'planning', {
                                includeStorage: true,
                                playerRoomId: 'storage',
                            }),
                            commandSnapshot: relicSnapshotWithPlayers(1, 'planning', {
                                includeStorage: true,
                                playerRoomId: 'storage',
                                roomInvestigations: [
                                    {
                                        roomId: 'storage',
                                        searchedByPlayerId: 'alice-session',
                                        searchedByUsername: 'Alice',
                                        searchedAtRound: 1,
                                        searchedAtEpochMs: Date.now(),
                                        result: 'empty',
                                        summary: 'The crates held a torn supply map, but no relic.',
                                        hint: 'The supply marks point back toward the Entrance and onward through the Trap Room.',
                                        effect: 'map-fragment',
                                        revealedRoomId: 'trap',
                                    },
                                ],
                                events: [
                                    {
                                        id: 'event-reveal-1',
                                        round: 1,
                                        type: 'action_revealed',
                                        message: 'Round 1 actions are revealed.',
                                        animationCue: {
                                            type: 'noise_pulse',
                                            durationMs: 620,
                                            intensity: 'low',
                                        },
                                        tone: 'mystery',
                                        createdAtEpochMs: Date.now(),
                                    },
                                    {
                                        id: 'event-search-1',
                                        round: 1,
                                        type: 'player_searched',
                                        message: 'Alice searched the crates and marked a false supply trail.',
                                        animationCue: {
                                            type: 'search_altar',
                                            playerId: 'alice-session',
                                            roomId: 'storage',
                                            durationMs: 700,
                                            intensity: 'low',
                                        },
                                        tone: 'mystery',
                                        createdAtEpochMs: Date.now(),
                                    },
                                    {
                                        id: 'event-noise-1',
                                        round: 1,
                                        type: 'noise_pulse',
                                        message: 'The ruin hears 2 noise.',
                                        animationCue: {
                                            type: 'noise_pulse',
                                            durationMs: 900,
                                            intensity: 'low',
                                        },
                                        tone: 'mystery',
                                        createdAtEpochMs: Date.now(),
                                    },
                                    {
                                        id: 'event-round-2',
                                        round: 1,
                                        type: 'round_started',
                                        message: 'Round 2 begins.',
                                        tone: 'mystery',
                                        createdAtEpochMs: Date.now(),
                                    },
                                ],
                                round: 2,
                            }),
                        })];
                case 2:
                    _c.sent();
                    return [4 /*yield*/, page.goto('/')];
                case 3:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Register' }).click()];
                case 4:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Username').fill('alice')];
                case 5:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Display name').fill('Alice')];
                case 6:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Password').fill('correct-horse')];
                case 7:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Create Hunter' }).click()];
                case 8:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Relic Hunters Expedition' }).click()];
                case 9:
                    _c.sent();
                    objective = page.locator('[aria-label="Room objective"]');
                    return [4 /*yield*/, (0, test_1.expect)(objective.getByText('Search the crates')).toBeVisible()];
                case 10:
                    _c.sent();
                    return [4 /*yield*/, objective.getByRole('button', { name: 'Prime Search' }).click()];
                case 11:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Submit Plan' }).click()];
                case 12:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(objective.getByText('Clue trail marked')).toBeVisible()];
                case 13:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(objective.getByText('The crates held a torn supply map, but no relic.')).toBeVisible()];
                case 14:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(objective.getByText('Follow the map fragment toward Trap Room')).toBeVisible()];
                case 15:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(objective.getByText('Next step: Move to Trap Room. The supply marks point back toward the Entrance and onward through the Trap Room.')).toBeVisible()];
                case 16:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByLabel('Current turn summary')).toContainText('Choose one plan')];
                case 17:
                    _c.sent();
                    timeline = page.getByLabel('Turn timeline');
                    return [4 /*yield*/, (0, test_1.expect)(timeline).toContainText('Your Action')];
                case 18:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(timeline).toContainText('Castle Reaction')];
                case 19:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(timeline).toContainText('Result')];
                case 20:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(timeline).toContainText('Alice searched the crates and marked a false supply trail.')];
                case 21:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByLabel('Discovered clue trails')).toContainText('Storage - Trap Room')];
                case 22:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByLabel('Discovered clue trails')).toContainText('The crates held a torn supply map, but no relic.')];
                case 23:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByLabel('Castle room map').getByRole('button', { name: 'Trap Room' })).toHaveClass(/clue-target/)];
                case 24:
                    _c.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, test_1.test)('Rallar browser bootstrap reads server config, state snapshots, and opens WebSocket', function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
        var requests, wsUrls;
        var page = _b.page;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    requests = [];
                    return [4 /*yield*/, installBrowserDoubles(page)];
                case 1:
                    _c.sent();
                    return [4 /*yield*/, mockBackend(page, { rooms: [], requests: requests })];
                case 2:
                    _c.sent();
                    return [4 /*yield*/, page.goto('/')];
                case 3:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Register' }).click()];
                case 4:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Username').fill('alice')];
                case 5:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Display name').fill('Alice')];
                case 6:
                    _c.sent();
                    return [4 /*yield*/, page.getByLabel('Password').fill('correct-horse')];
                case 7:
                    _c.sent();
                    return [4 /*yield*/, page.getByRole('button', { name: 'Create Hunter' }).click()];
                case 8:
                    _c.sent();
                    return [4 /*yield*/, (0, test_1.expect)(page.getByRole('button', { name: 'New Room' })).toBeVisible()];
                case 9:
                    _c.sent();
                    (0, test_1.expect)(requests).toContain('GET /api/config');
                    (0, test_1.expect)(requests).toContain('POST /api/auth/ws-ticket');
                    (0, test_1.expect)(requests).toContain('GET /api/state/apps/ar-eye-hunter/workspaces/default/clients');
                    (0, test_1.expect)(requests).toContain('GET /api/state/apps/ar-eye-hunter/workspaces/default/groups');
                    return [4 /*yield*/, page.evaluate(function () { var _a; return (_a = window.__rallarWsUrls) !== null && _a !== void 0 ? _a : []; })];
                case 10:
                    wsUrls = _c.sent();
                    (0, test_1.expect)(wsUrls).toContain('ws://127.0.0.1:5175/api/ws/alice-session?ticket=test-ticket');
                    return [2 /*return*/];
            }
        });
    }); });
});
function installBrowserDoubles(page) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, page.addInitScript(function () {
                        var FakeWebSocket = /** @class */ (function (_super) {
                            __extends(FakeWebSocket, _super);
                            function FakeWebSocket(url) {
                                var _a;
                                var _this = _super.call(this) || this;
                                _this.readyState = FakeWebSocket.CONNECTING;
                                _this.binaryType = 'blob';
                                _this.onopen = null;
                                _this.onclose = null;
                                _this.onerror = null;
                                _this.onmessage = null;
                                _this.url = url;
                                var target = window;
                                (_a = target.__rallarWsUrls) !== null && _a !== void 0 ? _a : (target.__rallarWsUrls = []);
                                target.__rallarWsUrls.push(url);
                                window.setTimeout(function () {
                                    var _a;
                                    _this.readyState = FakeWebSocket.OPEN;
                                    var event = new Event('open');
                                    _this.dispatchEvent(event);
                                    (_a = _this.onopen) === null || _a === void 0 ? void 0 : _a.call(_this, event);
                                }, 0);
                                return _this;
                            }
                            FakeWebSocket.prototype.send = function (data) {
                                var _a;
                                var target = window;
                                (_a = target.__rallarWsOutbox) !== null && _a !== void 0 ? _a : (target.__rallarWsOutbox = []);
                                target.__rallarWsOutbox.push(data);
                            };
                            FakeWebSocket.prototype.close = function (code, reason) {
                                var _a;
                                if (code === void 0) { code = 1000; }
                                if (reason === void 0) { reason = ''; }
                                this.readyState = FakeWebSocket.CLOSED;
                                var event = new CloseEvent('close', { code: code, reason: reason });
                                this.dispatchEvent(event);
                                (_a = this.onclose) === null || _a === void 0 ? void 0 : _a.call(this, event);
                            };
                            FakeWebSocket.CONNECTING = 0;
                            FakeWebSocket.OPEN = 1;
                            FakeWebSocket.CLOSING = 2;
                            FakeWebSocket.CLOSED = 3;
                            return FakeWebSocket;
                        }(EventTarget));
                        Object.defineProperty(window, 'WebSocket', {
                            configurable: true,
                            writable: true,
                            value: FakeWebSocket,
                        });
                    })];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
function restoreRoomSession(page) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, page.addInitScript(function (storedSession) {
                        window.localStorage.setItem('auth.session', JSON.stringify(__assign(__assign({}, storedSession), { expiresAtEpochMs: Date.now() + 60 * 60 * 1000 })));
                        window.localStorage.setItem('relic.currentRoomId', 'room-1');
                    }, session)];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
function openListedRoomIfNeeded(page) {
    return __awaiter(this, void 0, void 0, function () {
        var roomButton, summary, deadline, summaryText;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    roomButton = page.getByRole('button', { name: 'Relic Hunters Expedition' }).first();
                    summary = page.getByLabel('Current turn summary');
                    deadline = Date.now() + 15000;
                    _a.label = 1;
                case 1:
                    if (!(Date.now() < deadline)) return [3 /*break*/, 7];
                    return [4 /*yield*/, summary.textContent().catch(function () { return ''; })];
                case 2:
                    summaryText = _a.sent();
                    if (summaryText && !summaryText.includes('No Expedition')) {
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, roomButton.count()];
                case 3:
                    if (!((_a.sent()) > 0)) return [3 /*break*/, 5];
                    return [4 /*yield*/, roomButton.click({ force: true })];
                case 4:
                    _a.sent();
                    return [2 /*return*/];
                case 5: return [4 /*yield*/, page.waitForTimeout(250)];
                case 6:
                    _a.sent();
                    return [3 /*break*/, 1];
                case 7: return [4 /*yield*/, (0, test_1.expect)(roomButton).toBeAttached({ timeout: 1000 })];
                case 8:
                    _a.sent();
                    return [4 /*yield*/, roomButton.click({ force: true })];
                case 9:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
function captureSceneBaseline(page, name) {
    return __awaiter(this, void 0, void 0, function () {
        var options;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    options = {
                        animations: 'disabled',
                        fullPage: false,
                    };
                    if (!!WRITE_SCENE_BASELINES) return [3 /*break*/, 2];
                    return [4 /*yield*/, page.screenshot(options)];
                case 1: return [2 /*return*/, _a.sent()];
                case 2:
                    (0, node_fs_1.mkdirSync)(SCENE_BASELINE_DIR, { recursive: true });
                    return [4 /*yield*/, page.screenshot(__assign(__assign({}, options), { path: "".concat(SCENE_BASELINE_DIR, "/").concat(name, ".png") }))];
                case 3: return [2 /*return*/, _a.sent()];
            }
        });
    });
}
function mockBackend(page, options) {
    return __awaiter(this, void 0, void 0, function () {
        var rooms, currentRelicSnapshot, commandSnapshotIndex;
        var _this = this;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    rooms = __spreadArray([], ((_a = options.rooms) !== null && _a !== void 0 ? _a : []), true);
                    currentRelicSnapshot = (_b = options.relicSnapshot) !== null && _b !== void 0 ? _b : relicSnapshotWithPlayers(1);
                    commandSnapshotIndex = 0;
                    return [4 /*yield*/, page.route('http://127.0.0.1:5175/api/**', function (route) { return __awaiter(_this, void 0, void 0, function () {
                            var request, url, path, commandBody, created, room;
                            var _a, _b, _c, _d, _e, _f, _g, _h;
                            return __generator(this, function (_j) {
                                request = route.request();
                                url = new URL(request.url());
                                path = url.pathname;
                                (_a = options.requests) === null || _a === void 0 ? void 0 : _a.push("".concat(request.method(), " ").concat(path));
                                if (path === '/api/config') {
                                    return [2 /*return*/, json(route, {
                                            apiBaseUrl: 'http://127.0.0.1:5175',
                                            wsBaseUrl: 'ws://127.0.0.1:5175',
                                            endpoints: {
                                                createWs: '/api/ws/:id',
                                            },
                                        })];
                                }
                                if (path === '/api/auth/register') {
                                    return [2 /*return*/, json(route, {
                                            clientId: session.clientId,
                                            username: session.username,
                                            displayName: 'Alice',
                                            registeredAtEpochMs: Date.now(),
                                        }, 201)];
                                }
                                if (path === '/api/auth/login') {
                                    return [2 /*return*/, json(route, session)];
                                }
                                if (path === '/api/auth/ws-ticket') {
                                    return [2 /*return*/, json(route, {
                                            ticket: 'test-ticket',
                                            sessionId: session.sessionId,
                                            expiresAtEpochMs: Date.now() + 60000,
                                        })];
                                }
                                if (path === '/api/webrtc/ice') {
                                    return [2 /*return*/, json(route, {
                                            iceServers: [],
                                            expiresAtEpochMs: Date.now() + 60000,
                                        })];
                                }
                                if (path === '/api/relic/games/room-1') {
                                    return [2 /*return*/, json(route, currentRelicSnapshot)];
                                }
                                if (path === '/api/relic/games/room-1/reset') {
                                    currentRelicSnapshot = emptyRelicSnapshot();
                                    return [2 /*return*/, json(route, currentRelicSnapshot)];
                                }
                                if (path === '/api/relic/games/room-1/commands') {
                                    commandBody = parseJsonBody(request.postData());
                                    (_b = options.commandBodies) === null || _b === void 0 ? void 0 : _b.push(commandBody);
                                    currentRelicSnapshot = (_g = (_f = (_d = (_c = options.commandResponse) === null || _c === void 0 ? void 0 : _c.call(options, commandBody)) !== null && _d !== void 0 ? _d : (_e = options.commandSnapshots) === null || _e === void 0 ? void 0 : _e[commandSnapshotIndex]) !== null && _f !== void 0 ? _f : options.commandSnapshot) !== null && _g !== void 0 ? _g : relicSnapshotWithPlayers(1);
                                    commandSnapshotIndex += 1;
                                    return [2 /*return*/, json(route, currentRelicSnapshot)];
                                }
                                if (path.endsWith('/clients') && request.method() === 'GET') {
                                    return [2 /*return*/, json(route, [clientSnapshot()])];
                                }
                                if (path.endsWith('/groups') && request.method() === 'POST') {
                                    created = groupSnapshot({ onlineMemberCount: 1 });
                                    rooms = [created];
                                    return [2 /*return*/, json(route, created, 201)];
                                }
                                if (path.endsWith('/groups') && request.method() === 'GET') {
                                    return [2 /*return*/, json(route, rooms)];
                                }
                                if (path.includes('/groups/') && !path.endsWith('/groups')) {
                                    room = (_h = rooms[0]) !== null && _h !== void 0 ? _h : groupSnapshot({ onlineMemberCount: 1 });
                                    rooms = [room];
                                    return [2 /*return*/, json(route, room)];
                                }
                                if (path.includes('/clients/') && path.endsWith('/heartbeat')) {
                                    return [2 /*return*/, json(route, clientSnapshot())];
                                }
                                return [2 /*return*/, json(route, {})];
                            });
                        }); })];
                case 1:
                    _c.sent();
                    return [2 /*return*/];
            }
        });
    });
}
function json(route_1, body_1) {
    return __awaiter(this, arguments, void 0, function (route, body, status) {
        if (status === void 0) { status = 200; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, route.fulfill({
                        status: status,
                        contentType: 'application/json',
                        body: JSON.stringify(body),
                    })];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
function parseJsonBody(body) {
    if (!body) {
        return undefined;
    }
    return JSON.parse(body);
}
function sceneHasVisiblePixels(page) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, page.evaluate(function () {
                        var _a;
                        var canvas = document.querySelector('canvas.relic-scene');
                        if (!canvas) {
                            return false;
                        }
                        if (canvas.dataset.sceneReady === 'true') {
                            return true;
                        }
                        var gl = (_a = canvas.getContext('webgl2')) !== null && _a !== void 0 ? _a : canvas.getContext('webgl');
                        if (!gl) {
                            return false;
                        }
                        var width = gl.drawingBufferWidth;
                        var height = gl.drawingBufferHeight;
                        if (width <= 0 || height <= 0) {
                            return false;
                        }
                        var pixels = new Uint8Array(4);
                        var samples = [
                            [0.5, 0.5],
                            [0.34, 0.42],
                            [0.66, 0.42],
                            [0.5, 0.28],
                            [0.5, 0.72],
                        ];
                        for (var _i = 0, samples_1 = samples; _i < samples_1.length; _i++) {
                            var _b = samples_1[_i], xRatio = _b[0], yRatio = _b[1];
                            gl.readPixels(Math.min(width - 1, Math.max(0, Math.floor(width * xRatio))), Math.min(height - 1, Math.max(0, Math.floor(height * yRatio))), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                            if (pixels[3] > 0 && (pixels[0] > 4 || pixels[1] > 4 || pixels[2] > 4)) {
                                return true;
                            }
                        }
                        return false;
                    })];
                case 1: return [2 /*return*/, _a.sent()];
            }
        });
    });
}
function sceneCanvasMetrics(page) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, page.evaluate(function () {
                        var _a;
                        var canvas = document.querySelector('canvas.relic-scene');
                        if (!canvas) {
                            return {
                                ready: false,
                                cssWidth: 0,
                                cssHeight: 0,
                                drawingBufferWidth: 0,
                                drawingBufferHeight: 0,
                                devicePixelRatio: window.devicePixelRatio,
                                highDpi: false,
                                hasRenderedFrame: false,
                                averageLuma: 0,
                                cameraMode: undefined,
                                lightingPreset: undefined,
                                assetPipeline: undefined,
                                meshCount: 0,
                                activeMeshCount: 0,
                                materialCount: 0,
                                particleSystemCount: 0,
                                activeParticleSystemCount: 0,
                                activeRoomLightCount: 0,
                                staticBatchCount: 0,
                                batchedMeshCount: 0,
                                activeEffectCount: 0,
                                effectMeshCount: 0,
                                drawCalls: undefined,
                                fps: undefined,
                                readyMs: 0,
                            };
                        }
                        var gl = (_a = canvas.getContext('webgl2')) !== null && _a !== void 0 ? _a : canvas.getContext('webgl');
                        var box = canvas.getBoundingClientRect();
                        if (!gl || box.width <= 0 || box.height <= 0) {
                            return {
                                ready: false,
                                cssWidth: box.width,
                                cssHeight: box.height,
                                drawingBufferWidth: 0,
                                drawingBufferHeight: 0,
                                devicePixelRatio: window.devicePixelRatio,
                                highDpi: false,
                                hasRenderedFrame: false,
                                averageLuma: 0,
                                cameraMode: canvas.dataset.cameraMode,
                                lightingPreset: canvas.dataset.lightingPreset,
                                assetPipeline: canvas.dataset.assetPipeline,
                                meshCount: numberDataset(canvas.dataset.sceneMeshCount),
                                activeMeshCount: numberDataset(canvas.dataset.sceneActiveMeshCount),
                                materialCount: numberDataset(canvas.dataset.sceneMaterialCount),
                                particleSystemCount: numberDataset(canvas.dataset.sceneParticleSystemCount),
                                activeParticleSystemCount: numberDataset(canvas.dataset.sceneActiveParticleSystemCount),
                                activeRoomLightCount: numberDataset(canvas.dataset.sceneActiveRoomLightCount),
                                staticBatchCount: numberDataset(canvas.dataset.sceneStaticBatchCount),
                                batchedMeshCount: numberDataset(canvas.dataset.sceneBatchedMeshCount),
                                activeEffectCount: numberDataset(canvas.dataset.sceneActiveEffectCount),
                                effectMeshCount: numberDataset(canvas.dataset.sceneEffectMeshCount),
                                drawCalls: optionalNumberDataset(canvas.dataset.sceneDrawCalls),
                                fps: optionalNumberDataset(canvas.dataset.sceneFps),
                                readyMs: numberDataset(canvas.dataset.sceneReadyMs),
                            };
                        }
                        var width = gl.drawingBufferWidth;
                        var height = gl.drawingBufferHeight;
                        var pixels = new Uint8Array(4);
                        var samples = [
                            [0.50, 0.50],
                            [0.30, 0.38],
                            [0.70, 0.38],
                            [0.40, 0.62],
                            [0.60, 0.62],
                            [0.50, 0.24],
                            [0.50, 0.76],
                        ];
                        var visibleSamples = 0;
                        var lumaTotal = 0;
                        for (var _i = 0, samples_2 = samples; _i < samples_2.length; _i++) {
                            var _b = samples_2[_i], xRatio = _b[0], yRatio = _b[1];
                            gl.readPixels(Math.min(width - 1, Math.max(0, Math.floor(width * xRatio))), Math.min(height - 1, Math.max(0, Math.floor(height * yRatio))), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                            var luma = pixels[0] * 0.2126 + pixels[1] * 0.7152 + pixels[2] * 0.0722;
                            lumaTotal += luma;
                            if (pixels[3] > 0 && luma > 6) {
                                visibleSamples += 1;
                            }
                        }
                        var expectedScale = Math.min(window.devicePixelRatio || 1, 2);
                        return {
                            ready: canvas.dataset.sceneReady === 'true' || visibleSamples > 0,
                            cssWidth: box.width,
                            cssHeight: box.height,
                            drawingBufferWidth: width,
                            drawingBufferHeight: height,
                            devicePixelRatio: window.devicePixelRatio,
                            highDpi: width >= box.width * expectedScale - 2 &&
                                height >= box.height * expectedScale - 2,
                            hasRenderedFrame: canvas.dataset.sceneReady === 'true' || visibleSamples >= 2,
                            averageLuma: lumaTotal / samples.length,
                            cameraMode: canvas.dataset.cameraMode,
                            lightingPreset: canvas.dataset.lightingPreset,
                            assetPipeline: canvas.dataset.assetPipeline,
                            meshCount: numberDataset(canvas.dataset.sceneMeshCount),
                            activeMeshCount: numberDataset(canvas.dataset.sceneActiveMeshCount),
                            materialCount: numberDataset(canvas.dataset.sceneMaterialCount),
                            particleSystemCount: numberDataset(canvas.dataset.sceneParticleSystemCount),
                            activeParticleSystemCount: numberDataset(canvas.dataset.sceneActiveParticleSystemCount),
                            activeRoomLightCount: numberDataset(canvas.dataset.sceneActiveRoomLightCount),
                            staticBatchCount: numberDataset(canvas.dataset.sceneStaticBatchCount),
                            batchedMeshCount: numberDataset(canvas.dataset.sceneBatchedMeshCount),
                            activeEffectCount: numberDataset(canvas.dataset.sceneActiveEffectCount),
                            effectMeshCount: numberDataset(canvas.dataset.sceneEffectMeshCount),
                            drawCalls: optionalNumberDataset(canvas.dataset.sceneDrawCalls),
                            fps: optionalNumberDataset(canvas.dataset.sceneFps),
                            readyMs: numberDataset(canvas.dataset.sceneReadyMs),
                        };
                        function numberDataset(value) {
                            var parsed = Number(value);
                            return Number.isFinite(parsed) ? parsed : 0;
                        }
                        function optionalNumberDataset(value) {
                            var parsed = Number(value);
                            return Number.isFinite(parsed) ? parsed : undefined;
                        }
                    })];
                case 1: return [2 /*return*/, _a.sent()];
            }
        });
    });
}
function clientSnapshot() {
    var now = Date.now();
    return {
        principal: {
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            principalId: session.clientId,
            username: session.username,
            displayName: 'Alice',
            status: 'active',
            roles: [],
            metadata: {},
            profileVersion: 1,
            presenceVersion: 1,
            created: { atEpochMs: now },
            updated: { atEpochMs: now },
        },
        instances: [
            {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default',
                principalId: session.clientId,
                clientInstanceId: session.clientId,
                status: 'active',
                platform: 'web',
                capabilities: [],
                registered: { atEpochMs: now },
                updated: { atEpochMs: now },
            },
        ],
        activeSessions: [
            {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default',
                principalId: session.clientId,
                clientInstanceId: session.clientId,
                sessionId: session.sessionId,
                status: 'active',
                presenceState: 'online',
                transport: 'ws',
                authenticatedAtEpochMs: now,
                connectedAtEpochMs: now,
                lastHeartbeatAtEpochMs: now,
                expiresAtEpochMs: now + 60000,
            },
        ],
        isOnline: true,
        activeSessionCount: 1,
        lastSeenAtEpochMs: now,
    };
}
function groupSnapshot(options) {
    var now = Date.now();
    return {
        group: {
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            groupId: 'room-1',
            slug: 'relic-hunters-expedition',
            displayName: 'Relic Hunters Expedition',
            kind: 'room',
            status: 'active',
            joinMode: 'invite-only',
            metadata: {},
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            created: { atEpochMs: now, byPrincipalId: session.clientId },
            updated: { atEpochMs: now, byPrincipalId: session.clientId },
        },
        members: [
            {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default',
                groupId: 'room-1',
                principalId: session.clientId,
                role: 'owner',
                status: 'active',
                joined: { atEpochMs: now },
                updated: { atEpochMs: now },
            },
        ],
        activeSessions: options.onlineMemberCount > 0
            ? [
                {
                    applicationId: 'ar-eye-hunter',
                    workspaceId: 'default',
                    groupId: 'room-1',
                    sessionId: session.sessionId,
                    principalId: session.clientId,
                    connectedAtEpochMs: now,
                    lastHeartbeatAtEpochMs: now,
                    expiresAtEpochMs: now + 60000,
                },
            ]
            : [],
        memberCount: 1,
        onlineMemberCount: options.onlineMemberCount,
    };
}
function relicSnapshotWithPlayers(playerCount, phase, options) {
    var _a, _b, _c, _d, _e, _f;
    if (phase === void 0) { phase = 'lobby'; }
    if (options === void 0) { options = {}; }
    var playerSpecs = [
        ['alice-session', 'Alice', 'kael-ironstride'],
        ['bob-session', 'Bob', 'nyra-vale'],
        ['cara-session', 'Cara', 'oryn-starcoil'],
        ['dain-session', 'Dain', 'vessa-thornlock'],
    ];
    var players = playerSpecs.slice(0, playerCount).map(function (_a) {
        var _b, _c, _d, _e, _f, _g, _h;
        var playerId = _a[0], username = _a[1], characterId = _a[2];
        var relicIds = (_c = (_b = options.playerRelicIds) === null || _b === void 0 ? void 0 : _b[playerId]) !== null && _c !== void 0 ? _c : (options.carryRelic && playerId === 'alice-session' ? ['golden-idol'] : []);
        return {
            playerId: playerId,
            username: username,
            characterId: characterId,
            roomId: (_f = (_e = (_d = options.playerRooms) === null || _d === void 0 ? void 0 : _d[playerId]) !== null && _e !== void 0 ? _e : options.playerRoomId) !== null && _f !== void 0 ? _f : 'entrance',
            health: 3,
            escaped: false,
            defeated: false,
            score: (_h = (_g = options.playerScores) === null || _g === void 0 ? void 0 : _g[playerId]) !== null && _h !== void 0 ? _h : 0,
            relicIds: relicIds,
        };
    });
    var carriedRelics = __spreadArray(__spreadArray([], (options.carryRelic
        ? [
            {
                id: 'golden-idol',
                name: 'Golden Idol',
                value: 5,
                roomId: 'treasure',
                foundBy: 'alice-session',
                carriedBy: 'alice-session',
            },
        ]
        : []), true), Object.entries((_a = options.playerRelicIds) !== null && _a !== void 0 ? _a : {}).flatMap(function (_a) {
        var playerId = _a[0], relicIds = _a[1];
        return relicIds.map(function (relicId, index) {
            var _a, _b, _c;
            return ({
                id: relicId,
                name: relicId === 'sun-disk' ? 'Sun Disk' : "Relic ".concat(index + 1),
                value: relicId === 'sun-disk' ? 6 : 4,
                roomId: (_c = (_b = (_a = options.playerRooms) === null || _a === void 0 ? void 0 : _a[playerId]) !== null && _b !== void 0 ? _b : options.playerRoomId) !== null && _c !== void 0 ? _c : 'entrance',
                foundBy: playerId,
                carriedBy: playerId,
            });
        });
    }), true);
    var map = options.includeFullMap
        ? [
            {
                id: 'entrance',
                name: 'Entrance',
                kind: 'entrance',
                x: 0,
                z: -6,
                neighbors: ['hallway', 'storage'],
            },
            {
                id: 'hallway',
                name: 'Hallway',
                kind: 'hallway',
                x: 0,
                z: -3,
                neighbors: ['entrance', 'shrine', 'monster'],
            },
            {
                id: 'storage',
                name: 'Storage',
                kind: 'storage',
                x: -4,
                z: -3,
                neighbors: ['entrance', 'trap'],
            },
            {
                id: 'trap',
                name: 'Trap Room',
                kind: 'trap',
                x: -4,
                z: 0,
                neighbors: ['storage', 'shrine'],
            },
            {
                id: 'shrine',
                name: 'Shrine',
                kind: 'shrine',
                x: 0,
                z: 0,
                neighbors: ['hallway', 'trap', 'treasure', 'exit'],
            },
            {
                id: 'monster',
                name: 'Monster',
                kind: 'monster',
                x: 4,
                z: -3,
                neighbors: ['hallway', 'treasure'],
            },
            {
                id: 'treasure',
                name: 'Treasure',
                kind: 'treasure',
                x: 4,
                z: 0,
                neighbors: ['monster', 'shrine'],
            },
            {
                id: 'exit',
                name: 'Exit',
                kind: 'exit',
                x: 0,
                z: 3,
                neighbors: ['shrine'],
            },
        ]
        : __spreadArray(__spreadArray([
            {
                id: 'entrance',
                name: 'Entrance',
                kind: 'entrance',
                x: 0,
                z: -6,
                neighbors: options.includeStorage ? ['hallway', 'storage'] : ['hallway'],
            },
            {
                id: 'hallway',
                name: 'Hallway',
                kind: 'hallway',
                x: 0,
                z: -3,
                neighbors: options.includeExit ? ['entrance', 'exit'] : ['entrance'],
            }
        ], (options.includeExit
            ? [
                {
                    id: 'exit',
                    name: 'Exit',
                    kind: 'exit',
                    x: 0,
                    z: 0,
                    neighbors: ['hallway'],
                },
            ]
            : []), true), (options.includeStorage
            ? [
                {
                    id: 'storage',
                    name: 'Storage',
                    kind: 'storage',
                    x: -4,
                    z: -3,
                    neighbors: ['entrance', 'trap'],
                },
                {
                    id: 'trap',
                    name: 'Trap Room',
                    kind: 'trap',
                    x: -4,
                    z: 0,
                    neighbors: ['storage'],
                },
            ]
            : []), true);
    return {
        protocolVersion: 1,
        gameId: 'room-1',
        roomId: 'room-1',
        phase: phase,
        round: (_b = options.round) !== null && _b !== void 0 ? _b : 1,
        maxRounds: 10,
        updatedAtEpochMs: Date.now(),
        roundTimeLimitMs: (_c = options.roundTimeLimitMs) !== null && _c !== void 0 ? _c : 180000,
        roundStartedAtEpochMs: options.roundStartedAtEpochMs,
        map: map,
        relics: carriedRelics,
        roomInvestigations: (_d = options.roomInvestigations) !== null && _d !== void 0 ? _d : [],
        players: players,
        submittedPlayerIds: (_e = options.submittedPlayerIds) !== null && _e !== void 0 ? _e : [],
        events: (_f = options.events) !== null && _f !== void 0 ? _f : [],
        winnerIds: [],
    };
}
function emptyRelicSnapshot() {
    return __assign(__assign({}, relicSnapshotWithPlayers(1)), { players: [], submittedPlayerIds: [], events: [] });
}
function resolvedSearchSnapshot() {
    var now = Date.now();
    return relicSnapshotWithPlayers(1, 'planning', {
        round: 2,
        events: [
            {
                id: 'turn-1-reveal',
                round: 1,
                type: 'action_revealed',
                message: 'Round 1 actions are revealed.',
                tone: 'mystery',
                createdAtEpochMs: now,
            },
            {
                id: 'turn-1-search',
                round: 1,
                type: 'player_searched',
                message: 'Alice searched the Entrance.',
                animationCue: {
                    type: 'search_altar',
                    playerId: 'alice-session',
                    roomId: 'entrance',
                    durationMs: 700,
                    intensity: 'low',
                },
                tone: 'mystery',
                createdAtEpochMs: now,
            },
            {
                id: 'turn-1-round-2',
                round: 1,
                type: 'round_started',
                message: 'Round 2 begins.',
                tone: 'mystery',
                createdAtEpochMs: now,
            },
        ],
    });
}
function resolvedStorageSearchSnapshot() {
    var now = Date.now();
    return relicSnapshotWithPlayers(1, 'planning', {
        includeStorage: true,
        playerRoomId: 'storage',
        roomInvestigations: [
            {
                roomId: 'storage',
                searchedByPlayerId: 'alice-session',
                searchedByUsername: 'Alice',
                searchedAtRound: 1,
                searchedAtEpochMs: now,
                result: 'empty',
                summary: 'The crates held a torn supply map, but no relic.',
                hint: 'The supply marks point back toward the Entrance and onward through the Trap Room.',
                effect: 'map-fragment',
                revealedRoomId: 'trap',
            },
        ],
        events: [
            {
                id: 'event-reveal-1',
                round: 1,
                type: 'action_revealed',
                message: 'Round 1 actions are revealed.',
                animationCue: {
                    type: 'noise_pulse',
                    durationMs: 620,
                    intensity: 'low',
                },
                tone: 'mystery',
                createdAtEpochMs: now,
            },
            {
                id: 'event-search-1',
                round: 1,
                type: 'player_searched',
                message: 'Alice searched the crates and marked a false supply trail.',
                animationCue: {
                    type: 'search_altar',
                    playerId: 'alice-session',
                    roomId: 'storage',
                    durationMs: 700,
                    intensity: 'low',
                },
                tone: 'mystery',
                createdAtEpochMs: now,
            },
            {
                id: 'event-noise-1',
                round: 1,
                type: 'noise_pulse',
                message: 'The ruin hears 2 noise.',
                animationCue: {
                    type: 'noise_pulse',
                    durationMs: 900,
                    intensity: 'low',
                },
                tone: 'mystery',
                createdAtEpochMs: now,
            },
            {
                id: 'event-round-2',
                round: 1,
                type: 'round_started',
                message: 'Round 2 begins.',
                tone: 'mystery',
                createdAtEpochMs: now,
            },
        ],
        round: 2,
    });
}
function finishedRelicSnapshot() {
    var now = Date.now();
    var base = relicSnapshotWithPlayers(2, 'planning', {
        carryRelic: true,
        includeExit: true,
        playerRoomId: 'exit',
        playerScores: {
            'alice-session': 5,
            'bob-session': 1,
        },
        events: [
            {
                id: 'turn-final-escape',
                round: 3,
                type: 'player_escaped',
                message: 'Alice escaped with the Golden Idol.',
                tone: 'success',
                createdAtEpochMs: now,
            },
            {
                id: 'turn-final-finished',
                round: 3,
                type: 'game_finished',
                message: 'The expedition is over.',
                tone: 'success',
                createdAtEpochMs: now,
            },
        ],
        round: 3,
    });
    return __assign(__assign({}, base), { phase: 'finished', winnerIds: ['alice-session'], submittedPlayerIds: [], players: base.players.map(function (player) {
            return player.playerId === 'alice-session'
                ? __assign(__assign({}, player), { escaped: true, score: 5, relicIds: [] }) : player;
        }), relics: base.relics.map(function (relic) {
            return relic.id === 'golden-idol'
                ? __assign(__assign({}, relic), { carriedBy: undefined, escapedBy: 'alice-session' }) : relic;
        }) });
}
