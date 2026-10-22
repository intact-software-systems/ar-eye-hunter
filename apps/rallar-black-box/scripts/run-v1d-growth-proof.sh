#!/usr/bin/env bash
# The ALM V1d growth proof: a hand-launched local stack on a fresh Postgres database, held for the whole window,
# driving the 15-agent 60-minute principal multicast manifest and the medium-scale churn recipes side by side
# while a sampler records the database, the admin reads, process memory and the agents' stats every 30 s.
# At the end it stops everything, drops the database and writes the growth verdict into the run directory.
#
# Usage: apps/rallar-black-box/scripts/run-v1d-growth-proof.sh [--minutes 75] [--out <run-dir>]
# Needs: the dev Postgres container running, Docker, Deno, Node, jq, lsof; nothing else listening on the ports below.
# Do not edit the worktree while it runs: the headless SPA serves from it.
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

readonly API_PORT=18780
readonly SPA_PORT=5476
readonly CONTROL_PORT=5480
readonly API_BASE_URL="http://127.0.0.1:${API_PORT}"
readonly API_WS_BASE_URL="ws://127.0.0.1:${API_PORT}"
readonly SPA_BASE_URL="http://127.0.0.1:${SPA_PORT}"
readonly CONTROL_BASE_URL="http://127.0.0.1:${CONTROL_PORT}"
readonly CONTROL_WS_URL="ws://127.0.0.1:${CONTROL_PORT}/control"

readonly POSTGRES_CONTAINER=ar-eye-hunter-postgres
readonly POSTGRES_USER=app
readonly POSTGRES_PASSWORD=app
readonly POSTGRES_HOST_PORT=5432
readonly POSTGRES_ADMIN_DATABASE=appdb

readonly MANIFEST=apps/rallar-black-box/manifests/hetzner/23-rtc-messages-principal-15-agent-60m-2hz-tree.json
readonly ROW_COUNTS_SQL=apps/rallar-black-box/scripts/v1d-growth-proof-row-counts.sql

readonly SAMPLE_INTERVAL_SECONDS=30
readonly SERVICE_READY_TIMEOUT_SECONDS=180
readonly AGENT_REGISTRATION_TIMEOUT_SECONDS=240
readonly LOGIN_WINDOW_SECONDS=60
readonly RUNNER_TIMEOUT_MS=4500000
readonly RUNNER_POLL_MS=2000
readonly CHURN_DRAIN_TIMEOUT_SECONDS=300
readonly STOP_GRACE_SECONDS=20
readonly CONTROL_SAMPLE_ENVELOPES=2000

readonly AUTH_CREDENTIAL_SECRET=local-v1d-growth-proof-auth-credential-secret-v1
readonly OPERATOR_TOKEN_SECRET=local-v1d-growth-proof-operator-secret-v1
readonly REGISTRATION_IP_RATE_LIMIT=500
readonly LOGIN_IP_RATE_LIMIT=100
readonly USER_RATE_LIMIT=100
readonly CRDT_DOCUMENT_TYPE_POLICIES_JSON='[{"documentType":"black-box-map","rollout":"production"}]'
readonly ADMIN_USERNAME=admin
readonly ADMIN_PASSWORD=admin
readonly AGENT_PASSWORD_PREFIX=v1d-growth-proof-agent

AGENT_COUNT="$(jq -r '.metadata.participantCount' "$MANIFEST")"
MESH_MIN_SIZE="$(jq -r '.metadata.rtcTopologyEnv.RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE' "$MANIFEST")"
readonly AGENT_COUNT MESH_MIN_SIZE

STAMP="$(date -u +%Y%m%dt%H%M%Sz)"
readonly STAMP
readonly DATABASE_NAME="v1d_growth_${STAMP}"
readonly RUN_DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_HOST_PORT}/${DATABASE_NAME}"
readonly CONTROL_RUN_ID="v1d-growth-proof-control-${STAMP}"
OUT_DIR="${OUT_DIR:-tmp/v1d-growth-proof/${STAMP}}"
mkdir -p "$OUT_DIR/samples" "$OUT_DIR/churn" "$OUT_DIR/control-storage"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
readonly OUT_DIR

API_PID=""
CONTROL_PID=""
SPA_PID=""
WORKER_PID=""
RUNNER_PID=""
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

start_api() {
	log "starting the API on $API_BASE_URL"
	env \
		RALLAR_API_CONFIGURATION_PROFILE=prod-in-memory \
		RALLAR_SQL_BACKEND=postgres \
		RALLAR_PGLITE_SCHEMA_INIT=disabled \
		RALLAR_DB_PUBSUB=postgres \
		DATABASE_URL="$RUN_DATABASE_URL" \
		PORT="$API_PORT" \
		RALLAR_API_BASE_URL="$API_BASE_URL" \
		RALLAR_WS_BASE_URL="$API_WS_BASE_URL" \
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
		deno run --config apps/api-v1/deno.json --allow-net --allow-env --allow-read --v8-flags=--expose-gc \
		apps/api-v1/src/main.ts >"$OUT_DIR/api-timing.log" 2>&1 &
	API_PID=$!
	wait_for_url "$API_BASE_URL/api/config"
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
		agent_id="controller-$(printf '%02d' "$ordinal")"
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
		RALLAR_BLACK_BOX_AGENT_PREFIX=controller \
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
		if env \
			RALLAR_API_BASE_URL="$API_BASE_URL" \
			RALLAR_API_BASE_URL_SECONDARY="$API_BASE_URL" \
			RALLAR_API_BASE_URL_TERTIARY="$API_BASE_URL" \
			RALLAR_WS_BASE_URL="$API_WS_BASE_URL" \
			RALLAR_WS_BASE_URL_SECONDARY="$API_WS_BASE_URL" \
			RALLAR_WS_BASE_URL_TERTIARY="$API_WS_BASE_URL" \
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

sample_once() {
	local at endpoint api_rss control_rss
	at="$(now_epoch_ms)"
	docker exec -i "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$DATABASE_NAME" -v ON_ERROR_STOP=1 -At \
		<"$ROW_COUNTS_SQL" 2>>"$OUT_DIR/sampler.log" | append_sample "$at" postgres || log "postgres sample failed"
	for endpoint in system queues realtime; do
		curl -sf "$API_BASE_URL/api/admin/operations/$endpoint" \
			-H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" -H "x-client-id: $ADMIN_CLIENT_ID" |
			append_sample "$at" "admin-$endpoint" || log "admin $endpoint sample failed"
	done
	api_rss="$(ps -o rss= -p "$(listening_pid "$API_PORT")" 2>/dev/null | tr -d ' ' || true)"
	control_rss="$(ps -o rss= -p "$(listening_pid "$CONTROL_PORT")" 2>/dev/null | tr -d ' ' || true)"
	jq -n --argjson api "${api_rss:-null}" --argjson control "${control_rss:-null}" \
		'{api: (if $api == null then null else $api * 1024 end),
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

wait_for_churn_drain() {
	local deadline=$(($(date +%s) + CHURN_DRAIN_TIMEOUT_SECONDS))
	while [[ -n "$CHURN_PID" ]] && kill -0 "$CHURN_PID" 2>/dev/null && (($(date +%s) < deadline)); do
		sleep 2
	done
}

count_churn_iterations() {
	awk -v status="$1" '$3 == status' "$OUT_DIR/churn-iterations.txt" 2>/dev/null | wc -l | tr -d ' '
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
	stop_group "$API_PID"
	if [[ "$DATABASE_CREATED" == true ]]; then
		log "dropping database $DATABASE_NAME"
		psql_admin -c "drop database if exists ${DATABASE_NAME} with (force)" >/dev/null || log "drop failed"
	fi
}
trap tear_down EXIT
trap 'tear_down; exit 130' INT TERM

for port in "$API_PORT" "$SPA_PORT" "$CONTROL_PORT"; do
	require_free_port "$port"
done
docker exec "$POSTGRES_CONTAINER" pg_isready -U "$POSTGRES_USER" >/dev/null

create_database
start_api
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

while (($(date +%s) < WINDOW_END_EPOCH_S)); do
	sleep "$SAMPLE_INTERVAL_SECONDS"
done
log "window ended; letting the current churn iteration finish"
wait_for_churn_drain
wait "$SAMPLER_PID" 2>/dev/null || true
if kill -0 "$RUNNER_PID" 2>/dev/null; then
	log "the manifest outlasted the window; stopping the runner"
else
	wait "$RUNNER_PID" 2>/dev/null && log "runner: passed" || log "runner: did not pass (see runner.log)"
fi
log "churn iterations: $(count_churn_iterations passed) passed, $(count_churn_iterations failed) failed"
tear_down

log "writing the verdict"
node --import tsx apps/rallar-black-box/scripts/write-v1d-growth-verdict.ts --run-dir "$OUT_DIR"
