# Development sequence, agents, and tools

Status: proposed development strategy. Only the next two slices are concrete.
Later stages name outcomes; expand them after playable evidence. This is not a
commit schedule, progress ledger, or claim that the design has been approved.

## Working principle

Every increment should improve a game people can actually play. Start with the
smallest enjoyable action, connect it through Rallar early, and establish a visual
quality target before multiplying assets. Keep gameplay, mobile input, reliability,
and art in the same integration loop.

Before implementation, review this proposal with the user, settle the visual
direction through references, and choose the initial physical test devices. Design
approval does not certify fun or remove the playtest gates.

## Next slice 1: one playable raid across two devices

**Outcome:** a phone and a computer join through Rallar, move around a small arena,
collect, bank, get caught, respawn, finish a short round, and ready again. The game
owner is a server; browser closure cannot terminate the other player's round.

Start with a brief local feel spike of the same move/dash/pickup/bank rules. Use
simple silhouettes, one guard, two bank zones, and large touch controls. Keep the
spike throwaway unless explicitly retained through normal implementation review.
Do not spend weeks on offline content before connecting Rallar.

Then establish the pure shared rules, scoped runtime boundary, exact game-owner
lifetime, input delivery/expiry, and snapshots. This slice includes the minimum
reusable Rallar change if existing APIs cannot support the measured workload; it
must not bypass Rallar to make a demo pass.

**Acceptance:**

- Visible sign-in/room entry survives an invitation link and reload.
- On physical phone plus desktop, movement, dash, bank, and catch are understandable.
- Two clients finish with identical banked scores. One duplicated deposit outcome
  or dash message cannot apply another effect.
- Releasing touch, hiding the tab, or dropping the connection cannot leave movement
  held indefinitely; reconnect resolves the runner's actual state.
- Closing the room creator's browser leaves the other player able to continue.
- Measure actual input delivery and queue age at target rates with healthy and
  150 ms impaired networking. A receipt-tracked path is not assumed suitable.
- Measure cold shell/renderer transfer and phone frame pacing. Save a short ordinary
  gameplay recording, not just a screenshot of a successful lobby.
- Run focused rule/runtime tests, app/server typechecks and builds, and one visible
  two-client flow against real Rallar. New REST behavior includes shared-test recipes.

**Decision:** continue only if the chase controls and authority path are credible.
If input processing grows queues or corrections make touch play frustrating, resolve
that specific Rallar or game-speed issue before adding mechanics or full art.

## Next slice 2: one polished four-player market

**Outcome:** four people can play repeated complete three-minute rounds on mixed
devices in one coherent illustrated arena. The content is small but representative
of the intended shipping quality.

Select an approved gameplay composition, build the representative scene from
[art and polish](art-and-polish.md), then finish the one arena. Add bag heat/bonus,
the public jackpot, two guards, four distinguishable player identities, concise
onboarding, results/rematch, and essential audio. Refine portrait and landscape with
the same world visibility and equivalent actions.

**Acceptance:**

- Three small human groups play multiple rounds; observe banking comprehension,
  repeated catches, routes, input disadvantage, and voluntary rematches.
- The representative scene meets every visual rubric category at phone scale and
  in motion, including muted audio and reduced motion.
- A physical iPhone, Android phone, iPad, and desktop complete mixed-device rounds;
  record exact hardware/browser versions and any unsupported target explicitly.
- Baseline and impaired runs show identical results and bounded recovery.
- Cold loading and ten-minute frame pacing meet the proposed device budgets or
  trigger an explicit scope/performance decision before content expansion.
- No debug HUD, technical error dump, or endless spinner is part of the ordinary
  player flow. Connection failures have useful actions and truthful outcomes.

**Decision:** if people do not voluntarily replay, revise rules/map/economy. If
visual quality misses, repair the representative scene and asset process. Avoid
responding to either failure by adding more systems.

## Later outcomes, deliberately not task breakdowns

| Gate                    | Evidence needed                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release reliability     | Six-player qualification if retained; cross-room isolation; server capacity; restart/interruption; exact outcome recovery; twenty-round soak                      |
| Device quality          | Touch comfort, real Safari lifecycle/audio, orientation/safe areas, low-tier performance, desktop browsers, accessibility controls                                |
| Deployment              | HTTPS SPA, compatible Rallar/game server, exact allowed origins, versioned assets/contracts, admission capacity, logs/health, safe restart and rollback procedure |
| Small external playtest | Friends outside the developer setup can enter, understand, finish, recover, and rematch without developer assistance                                              |
| Content expansion       | Additional map/cosmetics/events justified by observed play, maintaining load and visual budgets                                                                   |

Keep revision batches in a draft PR when publishing implementation. Follow current
repo delivery guidance and required release checks. Do not copy live PR/check state
into these project documents or create a shared progress registry.

## Agent organization

One lead agent owns the integrated product, rules vocabulary, and acceptance.
Delegate bounded work only when its input and output are clear; all agents use
the same approved scene and rule documents.

| Role                          | Good assignment                                                 | Required return                                                                |
| ----------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Gameplay implementer          | One observable behavior, e.g. catch/deposit ordering            | Working slice, focused behavior evidence, assumptions                          |
| Art/animation agent           | One asset family matched to an approved seed and gameplay scale | Source + runtime assets, preview strip, in-game capture, provenance            |
| Rallar reliability agent      | One protocol/lifecycle gap with a reproduction                  | Canonical platform fix or measured finding, failure evidence and focused tests |
| Independent playtest/reviewer | Try specific human flows and failure cases on the candidate     | Severity-ranked defects, exact reproduction, screenshots/recordings            |

The lead integrates and resolves conflicts; the user judges aesthetic direction
and whether the game is enjoyable. Do not ask multiple agents to redesign the
whole game independently or let each asset agent invent a different look.

An implementation assignment should include the current approved scope, owned
files, player-visible acceptance, relevant target devices, and forbidden regressions.
Require the agent to play and capture its change. Passing TypeScript or a DOM text
assertion is insufficient evidence for movement, animation, or visual polish.

## Skills and MCPs

The necessary core tools are exposed in this session; this is capability inventory,
not a claim that every service credential or physical device has been tested.

| Capability            | Tools/skills                                                                              | Use                                                         |
| --------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Design and scope      | Superpowers brainstorming; repo adaptive-plan-execution                                   | Keep choices explicit and next work small                   |
| Game implementation   | Game Studio foundations, phaser-2d-game, game-ui-frontend                                 | Simulation/render boundary, sprites, input and readable HUD |
| Visual production     | Imagegen, sprite-pipeline, Product Design ideate/audit                                    | Approved reference, consistent frames, real-screen critique |
| Rallar integration    | building-rallar-apps, rallar-platform, rallar-games, rallar-realtime, rallar-code-writing | Public capabilities, authority, scope, ownership            |
| Verification          | game-playtest, Playwright MCP/CLI, rallar-testing, performance-analysis                   | Human flows, multi-client tests, captures, measured budgets |
| Delivery              | GitHub tools, repo publishing-plan-progress, verification/review skills                   | Reviewable increments and current CI evidence               |
| Library documentation | Context7 MCP or official documentation                                                    | Check APIs against the selected installed version           |

### Gaps and optional additions

1. **Physical mobile verification is the main missing capability.** No connected
   iPhone/iPad/Android device automation or device farm has been established here.
   Use the user's actual devices with a shared test URL and structured capture
   protocol first. A plugin-directory search for BrowserStack/Sauce Labs did not
   identify a matching device-testing integration; that search is not proof none
   exists. More may be available in the directory. A device farm can be connected
   later if manual coverage becomes a bottleneck.
2. **Context7 configuration needs attention.** Its lookup failed authentication in
   the preceding discussion. Do not expose credentials; configure it outside the
   project documents. Official Phaser/Playwright documentation is a working fallback.
3. **Audio production is optional tooling work.** No dedicated audio-generation
   tool is currently exposed in the active toolset. Procedural effects and licensed
   assets suffice to start. The directory currently lists fal with model search,
   schema and generation tools, and Shutterstock with music/SFX search. Neither is
   installed here. Model suitability, acquisition rights, pricing, and output quality
   need checking before use; no purchase or installation is requested by this pack.
4. **Visual judgement needs a process more than another MCP.** Existing image,
   sprite, browser, and screenshot tools cover the workflow. A paid editor, a
   different renderer, or more agents will not substitute for an approved reference,
   actual-size review, animation inspection, and human taste.

No new plugin is required to start slice 1. Phaser is a project dependency to
evaluate and pin during implementation, not an MCP or an installed game runtime
created by this document. No CCA-specific skill needs creating until repeated
work exposes a real gap; avoid a second rulebook that duplicates this pack.

## Validation and evidence discipline

For implementation, choose commands from the current repo testing skill and
verify their paths before running them. CCA workspace commands do not exist yet;
create test/typecheck/build scripts with the first implementation. Do not publish
invented commands as completed checks.

Behavioral evidence must include pure rule results, runtime cancellation/recovery,
real Rallar multi-client outcomes, browser captures, and physical-device observations.
Use Playwright [independent browser contexts](https://playwright.dev/docs/browser-contexts)
for different authenticated players; use screenshots/video for canvas behavior.
Browser emulation alone does not qualify phone or tablet play.

Keep playtest recordings consented and diagnostics redacted. Record build, rules,
device, network profile, scenario, and observation so a result is reproducible.
Distinguish automated correctness, measured performance, reviewer judgement, and
human fun feedback. None is a substitute for the others.

## Sources and follow-up

- Repository facts and limitations: [architecture evidence](architecture.md#current-repository-evidence-and-limits).
- Browser/game capabilities: official [Phaser docs](https://docs.phaser.io/),
  [Phaser input](https://docs.phaser.io/phaser/concepts/input), and
  [Playwright emulation](https://playwright.dev/docs/emulation), checked 15 November 2026.
- Plugin availability: current session tool inventory and plugin-directory lookups
  on 15 November 2026; availability may change.

No GitHub issues were created for this proposal. The next work is user review of
the design and a small visual exploration, followed by the two slices above once
implementation is authorized.
