# Benefits And Use Cases

Rallar Black Box exists to make browser-side Rallar behavior testable from the outside. It gives developers and test
automation a browser agent that can be driven locally, remotely, visibly, or headlessly through one command contract.

## Benefits

### One Command Vocabulary

The same `rallar-bb-test` commands are used by:

- local UI recipes
- manual UI actions
- control-server commands
- browser agent results
- remote runner provider work
- report and diagnostic surfaces

This reduces drift between a manual reproduction, a headless smoke test, and a server-orchestrated run.

### Visible Debugging

Failures are easier to investigate because the app shows:

- active command and elapsed time
- selected command result JSON
- completed command history
- filtered runtime event stream
- first failure details
- latest stats
- received data
- RTC connect diagnostics
- topology graph
- redacted report snapshot

The goal is to avoid relying on DevTools or raw logs as the first debugging surface.

### Faster Manual Probing

The manual workbench can create and execute normal commands without writing a recipe first. That is useful when checking:

- group join behavior
- direct client targeting
- multicast metadata
- broadcast metadata
- RTC versus WebSocket payload shape
- reconnect and cleanup behavior
- received payload visibility

When a manual sequence becomes useful, it can be copied as a recipe snippet.

### Better RTC Investigation

RTC connect failures are often sensitive to timing and hidden state. The diagnostics panel makes the stages explicit:

- auth
- runtime bootstrap
- group join
- signaling
- peer discovery
- data-channel readiness
- first payload

It also tracks expected versus observed clients, missing clients, stale clients, and latency. This turns an ambiguous
"RTC did not connect" failure into a smaller set of concrete checks.

### Remote Browser Control

The control client lets a server queue commands and collect results from a browser that initiated a WebSocket
connection. This works well for:

- headless CI smoke tests
- remote browser-agent experiments
- testing reconnect and command replay
- collecting stats and final reports from a controlled browser

The browser remains the executor of browser-native behavior. The server controls it through validated envelopes.

### Report Parity

The command/result/event vocabulary is designed so local runs and remote browser-agent runs can produce comparable
reports. That makes it easier to compare failures between:

- a local visible run
- a Playwright smoke run
- a black-box runner scenario
- a future monitor-ingested run

### Security Hooks

Remote browser control is risky. The implementation already includes important hooks:

- run tokens
- command validation
- command allowlists
- rate limits
- request size limits
- destination allowlists
- redaction
- origin and TLS enforcement options
- reset cleanup

These hooks let the tool move toward broader use without treating arbitrary browser actions as safe.

## Current Best Uses

The tool is currently best for:

- designing and validating the black-box command contract
- developing the control protocol
- proving result replay and reconnect behavior
- visible debugging of recipes and command flows
- creating manual test sequences and recipe snippets
- checking diagnostics and report shape
- validating topology and received-message UI behavior
- smoke-testing the browser agent registration and command/result loop

Because the default SPA mode is simulated, local UI runs are not final proof of live deployed Rallar RTC behavior. Use
`provider=browser-rallar` plus real environment config for live connect/send checks; two-agent delivery is still the
next proof needed for end-to-end payload receipt.
