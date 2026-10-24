#!/usr/bin/env bash
# The ALM V1d growth proof: a hand-launched local stack on a fresh Postgres database, held for the whole window,
# driving the 15-agent 78-minute principal multicast manifest and the medium-scale churn recipes side by side
# while a sampler records the database, the admin reads, process memory and the agents' stats every 30 s.
# Three API processes share the database, as the medium-scale gate runs them: the churn reads through all three
# and everything else talks to the first. Each process's forced-GC heap samples go to samples/api-heap.jsonl and
# its console lines to api-<n>.log; the rest of its timing lines are dropped.
# After the window it waits for the manifest when it is due to finish within the drain bound, records the
# workload's outcome in run.json, stops everything, drops the database and writes the growth verdict.
#
# Usage: apps/rallar-black-box/scripts/run-v1d-growth-proof.sh [--minutes 75] [--out <run-dir>]
# Needs: the dev Postgres container running, Docker, Deno, Node, jq, lsof; nothing else listening on the ports below.
# Do not edit the worktree while it runs: the headless SPA serves from it. Launch it from a terminal whose Chromium
# can connect WebRTC on the local network: where its mDNS host candidates do not resolve, every agent's RTC connect
# times out and the manifest fails.
# Disk: a 75-minute run directory takes about 4.2 GB (proof run 2 without its timing log: control-server storage
# 1.9 GB, world-fleet artefacts 2.0 GB, churn artefacts 0.2 GB, samples 0.13 GB).
set -euo pipefail
set -m

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

MINUTES=75
OUT_DIR=""
while [[ $# -gt 0 ]]; do
	case "$1" in
	--minutes)
		MINUTES="$2"
		shift 2
		;;
	--out)
		OUT_DIR="$2"
		shift 2
		;;
	*)
		echo "Unknown argument: $1" >&2
		exit 2
		;;
	esac
done

readonly API_PORTS=(18780 18781 18782)
readonly SPA_PORT=5476
readonly CONTROL_PORT=5480
readonly API_BASE_URL="http://127.0.0.1:${API_PORTS[0]}"
readonly API_WS_BASE_URL="ws://127.0.0.1:${API_PORTS[0]}"
readonly SPA_BASE_URL="http://127.0.0.1:${SPA_PORT}"
readonly CONTROL_BASE_URL="http://127.0.0.1:${CONTROL_PORT}"
readonly CONTROL_WS_URL="ws://127.0.0.1:${CONTROL_PORT}/control"

readonly POSTGRES_CONTAINER=ar-eye-hunter-postgres
readonly POSTGRES_USER=app
readonly POSTGRES_PASSWORD=app
readonly POSTGRES_HOST_PORT=5432
readonly POSTGRES_ADMIN_DATABASE=appdb

readonly MANIFEST=apps/rallar-black-box/manifests/hetzner/23-rtc-messages-principal-15-agent-78m-2hz-tree.json
readonly ROW_COUNTS_SQL=apps/rallar-black-box/scripts/v1d-growth-proof-row-counts.sql

readonly SAMPLE_INTERVAL_SECONDS=30
readonly SERVICE_READY_TIMEOUT_SECONDS=180
readonly AGENT_REGISTRATION_TIMEOUT_SECONDS=240
readonly LOGIN_WINDOW_SECONDS=60
readonly RUNNER_TIMEOUT_MS=5100000
readonly RUNNER_POLL_MS=2000
readonly CHURN_DRAIN_TIMEOUT_SECONDS=300
readonly MANIFEST_DRAIN_TIMEOUT_SECONDS=900
readonly MANIFEST_END_MARGIN_SECONDS=300
readonly STOP_GRACE_SECONDS=20
readonly CONTROL_SAMPLE_ENVELOPES=2000

readonly AUTH_CREDENTIAL_SECRET=local-v1d-growth-proof-auth-credential-secret-v1
readonly OPERATOR_TOKEN_SECRET=local-v1d-growth-proof-operator-secret-v1
readonly REGISTRATION_IP_RATE_LIMIT=500
readonly LOGIN_IP_RATE_LIMIT=100
readonly USER_RATE_LIMIT=100
readonly CRDT_DOCUMENT_TYPE_POLICIES_JSON='[{"documentType":"black-box-map","rollout":"production"}]'
# A 75-minute run creates about 70 groups, under the API's default of 512 current group snapshots, so each process's
# heap rises with the filling cache for the whole window. Churn adds 5 groups an iteration; at 32 the cache is full by
# about minute 17, its count stays put and the process heap after it shows whether anything else grows.
readonly GROUP_CURRENT_SNAPSHOT_CACHE_MAX_ENTRIES=32
readonly ADMIN_USERNAME=admin
readonly ADMIN_PASSWORD=admin
readonly AGENT_PREFIX=controller
readonly AGENT_PASSWORD_PREFIX=v1d-growth-proof-agent

AGENT_COUNT="$(jq -r '.metadata.participantCount' "$MANIFEST")"
MESH_MIN_SIZE="$(jq -r '.metadata.rtcTopologyEnv.RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE' "$MANIFEST")"
MANIFEST_SECONDS="$(jq -r '.metadata.expectedDurationSeconds' "$MANIFEST")"
DISTRIBUTED_RUN_ID="$(jq -r '.distributedRunId' "$MANIFEST")"
EVENT_HISTORY_MAX_EVENTS="$(jq -er 'select(.eventHistory.mode == "recent") | .eventHistory.maxEvents' "$MANIFEST")"
readonly AGENT_COUNT MESH_MIN_SIZE MANIFEST_SECONDS DISTRIBUTED_RUN_ID EVENT_HISTORY_MAX_EVENTS

STAMP="$(date -u +%Y%m%dt%H%M%Sz)"
readonly STAMP
readonly DATABASE_NAME="v1d_growth_${STAMP}"
readonly RUN_DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_HOST_PORT}/${DATABASE_NAME}"
readonly CONTROL_RUN_ID="v1d-growth-proof-control-${STAMP}"
OUT_DIR="${OUT_DIR:-tmp/v1d-growth-proof/${STAMP}}"
mkdir -p "$OUT_DIR/samples" "$OUT_DIR/churn" "$OUT_DIR/control-storage"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
readonly OUT_DIR

API_PIDS=()
CONTROL_PID=""
SPA_PID=""
WORKER_PID=""
RUNNER_PID=""
RUNNER_OUTCOME=""
CHURN_PID=""
SAMPLER_PID=""
DATABASE_CREATED=false
TORN_DOWN=false

log() {
	echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$OUT_DIR/run.log"
}

now_epoch_ms() {
	echo $(($(date +%s) * 1000))
}

psql_admin() {
	docker exec -i "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_ADMIN_DATABASE" -v ON_ERROR_STOP=1 -At "$@"
}

require_free_port() {
	if lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; then
		echo "Port $1 is in use; stop whatever listens there first." >&2
		exit 2
	fi
}

wait_for_url() {
	local url="$1" deadline=$(($(date +%s) + SERVICE_READY_TIMEOUT_SECONDS))
	until curl -sf -o /dev/null "$url"; do
		if (($(date +%s) > deadline)); then
			log "timed out waiting for $url"
			return 1
		fi
		sleep 1
	done
}

listening_pid() {
	lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1
}

stop_group() {
	local pid="$1"
	if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
		return 0
	fi
	kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
	local deadline=$(($(date +%s) + STOP_GRACE_SECONDS))
	while kill -0 "$pid" 2>/dev/null && (($(date +%s) < deadline)); do
		sleep 1
	done
	kill -KILL -- "-$pid" 2>/dev/null || true
}

create_database() {
	log "creating database $DATABASE_NAME"
	psql_admin -c "create database ${DATABASE_NAME}" >/dev/null
	DATABASE_CREATED=true
	(cd apps/api-v1 && env DATABASE_URL="$RUN_DATABASE_URL" deno task db:migrate:deploy) >"$OUT_DIR/migrate.log" 2>&1
}

# The heap-sample timing lines to samples/api-heap.jsonl, every other timing line dropped, the console to its log.
split_api_output() {
	LC_ALL=C awk -v heap="$OUT_DIR/samples/api-heap.jsonl" -v console="$OUT_DIR/api-$1.log" '
		/^\{"/ && index($0, "\"type\":\"rallar.timing\"") > 0 {
			if (index($0, "\"operation\":\"heap-sample\"") > 0) {
				print >>heap
				fflush(heap)
			}
			next
		}
		{
			print >>console
			fflush(console)
		}'
}

start_api_processes() {
	local ordinal port
	for ((ordinal = 1; ordinal <= ${#API_PORTS[@]}; ordinal++)); do
		port="${API_PORTS[ordinal - 1]}"
		log "starting API process $ordinal on http://127.0.0.1:${port}"
		start_api_process "$port" > >(split_api_output "$ordinal") 2>&1 &
		API_PIDS+=($!)
	done
	for port in "${API_PORTS[@]}"; do
		wait_for_url "http://127.0.0.1:${port}/api/config"
	done
}

start_api_process() {
	exec env \
		RALLAR_API_CONFIGURATION_PROFILE=prod-in-memory \
		RALLAR_SQL_BACKEND=postgres \
		RALLAR_PGLITE_SCHEMA_INIT=disabled \
		RALLAR_DB_PUBSUB=postgres \
		DATABASE_URL="$RUN_DATABASE_URL" \
		PORT="$1" \
		RALLAR_API_BASE_URL="http://127.0.0.1:$1" \
		RALLAR_WS_BASE_URL="ws://127.0.0.1:$1" \
		CORS_ORIGINS="${SPA_BASE_URL},http://localhost:${SPA_PORT}" \
		RALLAR_TIMING_LOGS=true \
		RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE="$MESH_MIN_SIZE" \
		RALLAR_REGISTRATION_IP_RATE_LIMIT="$REGISTRATION_IP_RATE_LIMIT" \
		RALLAR_REGISTRATION_USER_RATE_LIMIT="$USER_RATE_LIMIT" \
		RALLAR_LOGIN_IP_RATE_LIMIT="$LOGIN_IP_RATE_LIMIT" \
		RALLAR_LOGIN_USER_RATE_LIMIT="$USER_RATE_LIMIT" \
		RALLAR_AUTH_CREDENTIAL_SECRET="$AUTH_CREDENTIAL_SECRET" \
		RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET="$OPERATOR_TOKEN_SECRET" \
		RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON="$CRDT_DOCUMENT_TYPE_POLICIES_JSON" \
		RALLAR_GROUP_CURRENT_SNAPSHOT_CACHE_MAX_ENTRIES="$GROUP_CURRENT_SNAPSHOT_CACHE_MAX_ENTRIES" \
		deno run --config apps/api-v1/deno.json --allow-net --allow-env --allow-read --v8-flags=--expose-gc \
		apps/api-v1/src/main.ts
}

start_control_server() {
	log "starting the control server on $CONTROL_BASE_URL"
	(cd apps/rallar-black-box-control-server &&
		PORT="$CONTROL_PORT" RALLAR_BLACK_BOX_STORAGE_DIR="$OUT_DIR/control-storage" deno task start) \
		>"$OUT_DIR/control-server.log" 2>&1 &
	CONTROL_PID=$!
	wait_for_url "$CONTROL_BASE_URL/health"
}

start_spa() {
	log "starting the headless SPA on $SPA_BASE_URL"
	RALLAR_BLACK_BOX_FULL_STACK=1 VITE_RALLAR_API_BASE_URL="$API_BASE_URL" \
		npm --workspace rallar-black-box-headless run dev -- --port "$SPA_PORT" --force >"$OUT_DIR/spa.log" 2>&1 &
	SPA_PID=$!
	wait_for_url "$SPA_BASE_URL/headless/"
}

start_worker() {
	log "starting one headless worker with $AGENT_COUNT agents"
	local credentials=() ordinal agent_id
	for ((ordinal = 1; ordinal <= AGENT_COUNT; ordinal++)); do
		agent_id="${AGENT_PREFIX}-$(printf '%02d' "$ordinal")"
		credentials+=("RALLAR_BLACK_BOX_AGENT_${ordinal}_USERNAME=${agent_id}")
		credentials+=("RALLAR_BLACK_BOX_AGENT_${ordinal}_PASSWORD=${AGENT_PASSWORD_PREFIX}-${agent_id}")
	done
	env "${credentials[@]}" \
		RALLAR_BLACK_BOX_SPA_URL="$SPA_BASE_URL" \
		RALLAR_BLACK_BOX_CONTROL_URL="$CONTROL_WS_URL" \
		RALLAR_CONTROL_HTTP_URL="$CONTROL_BASE_URL" \
		RALLAR_API_BASE_URL="$API_BASE_URL" \
		RALLAR_BLACK_BOX_RUN_ID="$CONTROL_RUN_ID" \
		RALLAR_BLACK_BOX_AGENT_COUNT="$AGENT_COUNT" \
		RALLAR_BLACK_BOX_AGENT_START_INDEX=1 \
		RALLAR_BLACK_BOX_AGENT_PREFIX="$AGENT_PREFIX" \
		RALLAR_BLACK_BOX_APPLICATION_ID="$(jq -r '.group.applicationId' "$MANIFEST")" \
		RALLAR_BLACK_BOX_WORKSPACE_ID="$(jq -r '.group.workspaceId' "$MANIFEST")" \
		RALLAR_BLACK_BOX_ROOM_ID="$(jq -r '.group.groupId' "$MANIFEST")" \
		RALLAR_BLACK_BOX_HEADLESS_ENTRY=headless \
		RALLAR_BLACK_BOX_REGISTER=true \
		RALLAR_BLACK_BOX_EXIT_MODE=signal \
		RALLAR_BLACK_BOX_STATS_INTERVAL_MS=$((SAMPLE_INTERVAL_SECONDS * 1000)) \
		RALLAR_BLACK_BOX_BROWSER_CENSUS_INTERVAL_MS=$((SAMPLE_INTERVAL_SECONDS * 1000)) \
		node --import tsx apps/rallar-black-box/scripts/headless-worker.ts >"$OUT_DIR/worker.log" 2>&1 &
	WORKER_PID=$!
	local deadline=$(($(date +%s) + AGENT_REGISTRATION_TIMEOUT_SECONDS)) registered=0
	until ((registered == AGENT_COUNT)); do
		registered="$(curl -sf "$CONTROL_BASE_URL/runs/$CONTROL_RUN_ID?limitCommands=0&limitResults=0&limitEvents=0&limitStats=0&limitReports=0&limitHeartbeats=0" |
			jq '[.agents[]? | select(.connected and .registeredAtEpochMs != null)] | length' 2>/dev/null || echo 0)"
		if (($(date +%s) > deadline)) || ! kill -0 "$WORKER_PID" 2>/dev/null; then
			log "only $registered of $AGENT_COUNT agents registered"
			return 1
		fi
		sleep 2
	done
	log "all $AGENT_COUNT agents registered"
}

start_runner() {
	log "driving $MANIFEST"
	node --import tsx apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts \
		--control "$CONTROL_BASE_URL" \
		--manifest "$MANIFEST" \
		--control-run-id "$CONTROL_RUN_ID" \
		--artifact-dir "$OUT_DIR/world-fleet" \
		--poll-ms "$RUNNER_POLL_MS" \
		--timeout-ms "$RUNNER_TIMEOUT_MS" >"$OUT_DIR/runner.log" 2>&1 &
	RUNNER_PID=$!
}

run_churn_loop() {
	local iteration=0 run_id status
	sleep "$LOGIN_WINDOW_SECONDS"
	while (($(date +%s) < WINDOW_END_EPOCH_S)); do
		iteration=$((iteration + 1))
		run_id="v1d-growth-churn-${STAMP}-$(printf '%03d' "$iteration")"
		echo "$iteration $run_id started" >>"$OUT_DIR/churn-iterations.txt"
		if env \
			RALLAR_API_BASE_URL="$API_BASE_URL" \
			RALLAR_API_BASE_URL_SECONDARY="http://127.0.0.1:${API_PORTS[1]}" \
			RALLAR_API_BASE_URL_TERTIARY="http://127.0.0.1:${API_PORTS[2]}" \
			RALLAR_WS_BASE_URL="$API_WS_BASE_URL" \
			RALLAR_WS_BASE_URL_SECONDARY="ws://127.0.0.1:${API_PORTS[1]}" \
			RALLAR_WS_BASE_URL_TERTIARY="ws://127.0.0.1:${API_PORTS[2]}" \
			DATABASE_URL="$RUN_DATABASE_URL" \
			RALLAR_AUTH_CREDENTIAL_SECRET="$AUTH_CREDENTIAL_SECRET" \
			RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET="$OPERATOR_TOKEN_SECRET" \
			deno run -A packages/shared-test/black-box-runner/api-v1-black-box-run.mts \
			--recipes-only \
			--profile=api-v1-black-box-medium-scale \
			--run-id="$run_id" \
			--artifact-dir="$OUT_DIR/churn/$(printf '%03d' "$iteration")" >>"$OUT_DIR/churn.log" 2>&1; then
			status=passed
		else
			status=failed
		fi
		echo "$iteration $run_id $status" >>"$OUT_DIR/churn-iterations.txt"
	done
}

read_admin_token() {
	curl -sf -X POST "$API_BASE_URL/api/auth/login/requests/v1d-growth-proof-sampler-login-${STAMP}" \
		-H 'content-type: application/json' \
		-d "{\"username\":\"${ADMIN_USERNAME}\",\"password\":\"${ADMIN_PASSWORD}\"}"
}

append_sample() {
	jq -c --argjson at "$1" '{atEpochMs: $at, value: .}' >>"$OUT_DIR/samples/$2.jsonl"
}

# The resident set in KiB of whatever listens on the port, or null.
read_listener_rss() {
	local rss
	rss="$(ps -o rss= -p "$(listening_pid "$1")" 2>/dev/null | tr -d ' ' || true)"
	echo "${rss:-null}"
}

sample_once() {
	local at endpoint api_rss
	at="$(now_epoch_ms)"
	docker exec -i "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$DATABASE_NAME" -v ON_ERROR_STOP=1 -At \
		<"$ROW_COUNTS_SQL" 2>>"$OUT_DIR/sampler.log" | append_sample "$at" postgres || log "postgres sample failed"
	for endpoint in system queues realtime; do
		curl -sf "$API_BASE_URL/api/admin/operations/$endpoint" \
			-H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" -H "x-client-id: $ADMIN_CLIENT_ID" |
			append_sample "$at" "admin-$endpoint" || log "admin $endpoint sample failed"
	done
	api_rss="$(for port in "${API_PORTS[@]}"; do read_listener_rss "$port"; done | jq -s -c .)"
	jq -n --argjson api "$api_rss" --argjson control "$(read_listener_rss "$CONTROL_PORT")" \
		'{api: [$api[] | if . == null then null else . * 1024 end],
          control: (if $control == null then null else $control * 1024 end)}' | append_sample "$at" process-rss || true
	curl -sf "$CONTROL_BASE_URL/runs/$CONTROL_RUN_ID?limitCommands=0&limitResults=0&limitReports=0&limitHeartbeats=0&limitEvents=${CONTROL_SAMPLE_ENVELOPES}&limitStats=${CONTROL_SAMPLE_ENVELOPES}" |
		jq -c '{stats: (.stats // []), events: [(.events // [])[] | select(.payload.kind == "stats")]}' |
		append_sample "$at" control-run || log "control run sample failed"
}

run_sampler_loop() {
	while (($(date +%s) < WINDOW_END_EPOCH_S)); do
		sample_once
		sleep "$SAMPLE_INTERVAL_SECONDS"
	done
	sample_once
}

# Fixes RUNNER_OUTCOME at the runner's exit; leaves it empty while the runner runs, and keeps the first outcome after.
settle_runner_outcome() {
	if [[ -n "$RUNNER_OUTCOME" ]] || kill -0 "$RUNNER_PID" 2>/dev/null; then
		return 0
	fi
	if wait "$RUNNER_PID" 2>/dev/null; then
		RUNNER_OUTCOME=passed
	else
		RUNNER_OUTCOME=failed
	fi
}

wait_for_churn_drain() {
	local deadline=$(($(date +%s) + CHURN_DRAIN_TIMEOUT_SECONDS))
	while [[ -n "$CHURN_PID" ]] && kill -0 "$CHURN_PID" 2>/dev/null && (($(date +%s) < deadline)); do
		sleep 2
	done
}

count_churn_iterations() {
	awk -v status="$1" '$3 == status' "$OUT_DIR/churn-iterations.txt" 2>/dev/null | wc -l | tr -d ' '
}

read_distributed_run() {
	curl -sf "$CONTROL_BASE_URL/distributed-runs/$DISTRIBUTED_RUN_ID" || echo '{}'
}

# Waits for the runner while the manifest is due to finish within the drain bound; a short window stops it instead.
wait_for_manifest() {
	local started_at_ms due_s deadline
	started_at_ms="$(read_distributed_run | jq -r '.startedAtEpochMs // empty')"
	if [[ -z "$started_at_ms" ]]; then
		return 0
	fi
	due_s=$((started_at_ms / 1000 + MANIFEST_SECONDS + MANIFEST_END_MARGIN_SECONDS))
	deadline=$(($(date +%s) + MANIFEST_DRAIN_TIMEOUT_SECONDS))
	if ((due_s > deadline)); then
		return 0
	fi
	while kill -0 "$RUNNER_PID" 2>/dev/null && (($(date +%s) < due_s)); do
		sleep 5
	done
}

# The verdict fails without a passed manifest and a clean churn loop, so the workload's outcome joins run.json; the
# iterations started and the manifest's agents count the accounts the run registered, and the manifest's event history
# bound is the cap of the test runtime's retained events, the snapshot cache cap the API processes started with is the
# cap of their kept groups, and the API processes started say how many heap sample streams the verdict expects.
record_workload() {
	local runner="$1" distributed failed_run_ids
	distributed="$(read_distributed_run)"
	failed_run_ids="$(awk '$3 == "failed" {print $2}' "$OUT_DIR/churn-iterations.txt" 2>/dev/null | jq -R . | jq -s -c .)"
	jq \
		--arg runner "$runner" \
		--argjson distributed "$distributed" \
		--argjson manifestAgents "$AGENT_COUNT" \
		--argjson eventHistoryMaxEvents "$EVENT_HISTORY_MAX_EVENTS" \
		--argjson groupCurrentSnapshotCacheMaxEntries "$GROUP_CURRENT_SNAPSHOT_CACHE_MAX_ENTRIES" \
		--argjson apiProcesses "${#API_PORTS[@]}" \
		--argjson churnStarted "$(count_churn_iterations started)" \
		--argjson churnPassed "$(count_churn_iterations passed)" \
		--argjson churnFailedRunIds "$failed_run_ids" \
		'.workload = {runner: $runner,
			manifestStartedAtEpochMs: ($distributed.startedAtEpochMs // null),
			manifestCompletedAtEpochMs: ($distributed.completedAtEpochMs // null),
			manifestAgents: $manifestAgents,
			eventHistoryMaxEvents: $eventHistoryMaxEvents,
			groupCurrentSnapshotCacheMaxEntries: $groupCurrentSnapshotCacheMaxEntries,
			apiProcesses: $apiProcesses,
			churnStarted: $churnStarted, churnPassed: $churnPassed, churnFailedRunIds: $churnFailedRunIds}' \
		"$OUT_DIR/run.json" >"$OUT_DIR/run.json.next"
	mv "$OUT_DIR/run.json.next" "$OUT_DIR/run.json"
}

tear_down() {
	if [[ "$TORN_DOWN" == true ]]; then
		return 0
	fi
	TORN_DOWN=true
	log "stopping the stack"
	stop_group "$SAMPLER_PID"
	stop_group "$CHURN_PID"
	stop_group "$RUNNER_PID"
	stop_group "$WORKER_PID"
	stop_group "$SPA_PID"
	stop_group "$CONTROL_PID"
	local pid
	for pid in ${API_PIDS[@]+"${API_PIDS[@]}"}; do
		stop_group "$pid"
	done
	if [[ "$DATABASE_CREATED" == true ]]; then
		log "dropping database $DATABASE_NAME"
		psql_admin -c "drop database if exists ${DATABASE_NAME} with (force)" >/dev/null || log "drop failed"
	fi
}
trap tear_down EXIT
trap 'tear_down; exit 130' INT TERM

for port in "${API_PORTS[@]}" "$SPA_PORT" "$CONTROL_PORT"; do
	require_free_port "$port"
done
docker exec "$POSTGRES_CONTAINER" pg_isready -U "$POSTGRES_USER" >/dev/null

create_database
start_api_processes
start_control_server
start_spa
start_worker

LOGIN_BODY="$(read_admin_token)"
ADMIN_ACCESS_TOKEN="$(jq -r '.accessToken' <<<"$LOGIN_BODY")"
ADMIN_CLIENT_ID="$(jq -r '.clientId' <<<"$LOGIN_BODY")"
readonly ADMIN_ACCESS_TOKEN ADMIN_CLIENT_ID

WINDOW_STARTED_AT_EPOCH_MS="$(now_epoch_ms)"
WINDOW_END_EPOCH_S=$((WINDOW_STARTED_AT_EPOCH_MS / 1000 + MINUTES * 60))
readonly WINDOW_STARTED_AT_EPOCH_MS WINDOW_END_EPOCH_S
jq -n \
	--argjson windowStartedAtEpochMs "$WINDOW_STARTED_AT_EPOCH_MS" \
	--argjson minutes "$MINUTES" \
	--arg database "$DATABASE_NAME" \
	--arg manifest "$MANIFEST" \
	--arg controlRunId "$CONTROL_RUN_ID" \
	--arg sourceCommit "$(git rev-parse HEAD)" \
	'{windowStartedAtEpochMs: $windowStartedAtEpochMs, minutes: $minutes,
      database: $database, manifest: $manifest,
      controlRunId: $controlRunId, sourceCommit: $sourceCommit}' >"$OUT_DIR/run.json"
log "window of $MINUTES min started; samples in $OUT_DIR"

run_sampler_loop &
SAMPLER_PID=$!
start_runner
run_churn_loop &
CHURN_PID=$!

while (($(date +%s) < WINDOW_END_EPOCH_S)) && [[ "$RUNNER_OUTCOME" != failed ]]; do
	sleep "$SAMPLE_INTERVAL_SECONDS"
	settle_runner_outcome
done
if [[ "$RUNNER_OUTCOME" == failed ]]; then
	log "the manifest runner failed before the window ended; stopping early"
	stop_group "$SAMPLER_PID"
	stop_group "$CHURN_PID"
	sample_once
else
	log "window ended; letting the current churn iteration and a due manifest finish"
	wait_for_churn_drain
	wait "$SAMPLER_PID" 2>/dev/null || true
	wait_for_manifest
	settle_runner_outcome
	RUNNER_OUTCOME="${RUNNER_OUTCOME:-outlasted-window}"
fi
record_workload "$RUNNER_OUTCOME"
log "runner: $RUNNER_OUTCOME; churn iterations: $(count_churn_iterations passed) passed, $(count_churn_iterations failed) failed"
tear_down

log "writing the verdict"
node --import tsx apps/rallar-black-box/scripts/write-v1d-growth-verdict.ts --run-dir "$OUT_DIR"
