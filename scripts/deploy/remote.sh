#!/bin/sh
# 服务器端部署序列：由 .github/workflows/deploy.yml 通过 `ssh … sh -s` 管道执行，
# 步骤与 GitHub 上的运行状态无关（workflow 只负责把这份脚本送过去并转发退出码）。
#
# 为什么是文件而不是 workflow 里的内联字符串：SSH → 远端 shell 的两层引号转义本身
# 就是事故来源（`$(...)`、`{{...}}`、`!` 各层的含义都不同，写错一处只有真部署时
# 才暴露），而放进文件后这段逻辑能在本地用替身 docker 逐条分支跑
# （见 scripts/deploy/remote.test.ts）。
#
# 输入（公开参数由远端命令行传入，凭据由 SSH stdin 中的赋值传入）：
#   DEPLOY_DIR        服务器上 compose 文件与 .env.prod 所在目录
#   IMAGE             Registry 仓库地址，兼容旧回退时使用默认 latest；运行 env 固定实际 digest
#   ACR_USERNAME / ACR_PASSWORD                 CI 与主机共用的 Registry 凭据
#   HEALTH_ATTEMPTS / HEALTH_INTERVAL_SECONDS   可选，健康门窗口（默认 72 × 5s = 6 分钟）
#   SERVICE                                     可选，compose 里的服务名（默认 app），
#                                               容器用它来解析，不靠容器的实际名字
#
# workflow 先把新 .env.prod 和 docker-compose.yml 上传为 incoming；本脚本备份旧文件后再切换。
# 同协议的配置、镜像或健康门失败恢复旧文件和镜像；首次跨云端草稿协议失败停写保留数据。
# 数据库迁移是前向迁移，不自动回退。
# 回滚锚点在 pull 前保存，成功后才 prune 旧镜像。
set -eu

: "${DEPLOY_DIR:?DEPLOY_DIR 未设置}"
: "${IMAGE:?IMAGE 未设置}"
: "${ACR_USERNAME:?ACR_USERNAME 未设置}"
: "${ACR_PASSWORD:?ACR_PASSWORD 未设置}"

ATTEMPTS=${HEALTH_ATTEMPTS:-72}
INTERVAL=${HEALTH_INTERVAL_SECONDS:-5}
SERVICE=${SERVICE:-app}

cd "$DEPLOY_DIR"

# The manual workflow and ordinary CD share both the Actions concurrency group
# and this host lock. A maintenance approval must not race another release.
exec 9> .deploy.lock
flock -n 9 || { echo '另一发布正在运行，拒绝并发切换。' >&2; exit 1; }
DEPLOY_MODE=${DEPLOY_MODE:-normal}
case "$DEPLOY_MODE" in normal|maintenance) ;; *) exit 1 ;; esac

# The previous release may still use .env. Only rollback reads that legacy name.
previous_env_file=.env.prod
if [ ! -f .env.prod ] && [ -f .env ]; then
  previous_env_file=.env
fi
active_env_file=$previous_env_file
compose() {
  docker compose --env-file "$active_env_file" "$@"
}

candidate_compose() {
  docker compose -p "$compose_project" --project-directory "$candidate_dir" --env-file "$candidate_dir/.env.prod" -f "$candidate_dir/docker-compose.yml" "$@"
}

release_check() {
  # Keep host-side plan files owned by the account running this deployment.
  candidate_compose run --rm --no-deps --user "$(id -u):$(id -g)" -v "$candidate_dir:/release" app node .output/server/maintenance/release.mjs "$@"
}

# The root Docker host can back up a colocated MySQL without distributing its
# root credential to the runner or application. Remote DBs require an adapter.
backup_and_verify() {
  mysql_container=${MYSQL_BACKUP_CONTAINER:-$DB_HOST}
  case "$mysql_container" in ''|[!a-zA-Z0-9]*|*[!a-zA-Z0-9_.-]*) return 1 ;; esac
  case "$DB_NAME" in ''|*[!a-zA-Z0-9_]*) return 1 ;; esac
  recovery=$(mktemp -d "$candidate_dir/recovery-XXXXXXXX") || return 1
  for backup_file in "$previous_env_file" docker-compose.yml; do
    if [ -f "$backup_file" ]; then cp -p "$backup_file" "$recovery/" || return 1; fi
  done
  cp -p "$candidate_dir/.env.prod" "$recovery/candidate.env" || return 1
  actual_uuid=$(docker exec "$mysql_container" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot --batch --skip-column-names -e "SELECT @@server_uuid"') || return 1
  [ "$actual_uuid" = "$DB_UUID" ] || { echo '备份实例与应用连接的数据库不一致。' >&2; return 1; }
  sessions=$(docker exec "$mysql_container" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot --batch --skip-column-names -e "$1"' sh "SELECT COUNT(*) FROM information_schema.processlist WHERE db='$DB_NAME' AND id != CONNECTION_ID()") || return 1
  [ "$sessions" = 0 ] || { echo '目标数据库仍有其他连接，需停止外部写者后重试。' >&2; return 1; }
  # Program objects could contain source-qualified writes or scheduled effects.
  # Reject before production writes and require a reviewed recovery adapter for them.
  objects=$(docker exec "$mysql_container" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot --batch --skip-column-names -e "$1"' sh "SELECT (SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema='$DB_NAME') + (SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema='$DB_NAME') + (SELECT COUNT(*) FROM information_schema.events WHERE event_schema='$DB_NAME') + (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB_NAME' AND (table_type!='BASE TABLE' OR engine!='InnoDB')) + (SELECT COUNT(*) FROM information_schema.referential_constraints WHERE constraint_schema='$DB_NAME' AND unique_constraint_schema!='$DB_NAME')") || return 1
  [ "$objects" = 0 ] || { echo '数据库结构超出当前恢复适配器支持范围，需要专用方案。' >&2; return 1; }
  docker exec "$mysql_container" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -uroot --single-transaction --hex-blob --no-tablespaces --set-gtid-purged=OFF --routines --events --triggers "$1"' sh "$DB_NAME" > "$recovery/database.sql.part" || return 1
  [ -s "$recovery/database.sql.part" ] || return 1
  mv "$recovery/database.sql.part" "$recovery/database.sql" || return 1
  sha256sum "$recovery/database.sql" > "$recovery/database.sha256" || return 1
  qa="stupig_deploy_qa_$(date -u +%s)_$$"
  docker exec "$mysql_container" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -e "$1"' sh "CREATE DATABASE \`$qa\` CHARACTER SET utf8mb4" || return 1
  # The subshell owns only this uniquely named QA database; clean it even if a
  # restore or byte comparison fails. The production dump is always retained.
  (
    trap 'qa_status=$?; trap - EXIT; docker exec "$mysql_container" sh -c '\''MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -e "$1"'\'' sh "DROP DATABASE \`$qa\`" || exit 1; exit "$qa_status"' EXIT
    docker exec -i "$mysql_container" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot "$1"' sh "$qa" < "$recovery/database.sql" || exit 1
    for target in "$DB_NAME" "$qa"; do
      docker exec "$mysql_container" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -uroot --single-transaction --hex-blob --no-tablespaces --set-gtid-purged=OFF --no-create-info --skip-comments --skip-dump-date --skip-add-locks --skip-disable-keys --skip-triggers --order-by-primary "$1"' sh "$target" > "$recovery/$target.data.sql" || exit 1
    done
    cmp "$recovery/$DB_NAME.data.sql" "$recovery/$qa.data.sql" || exit 1
    printf 'all-table-restored-data=byte-identical\n' > "$recovery/restore-verification.txt" || exit 1
  ) || return 1
  if [ "${VERIFY_MAIN_UNCHANGED:-0}" = 1 ]; then
    snapshot_main > "$recovery/main-before.tsv" || return 1
  fi
  echo "一致性备份已通过隔离恢复验证：$recovery"
}

snapshot_main() {
  docker exec "$mysql_container" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot --batch --skip-column-names -e "$1"' sh "SELECT id,OCTET_LENGTH(markdown),SHA2(markdown,256),revision,namespace_revision,namespace_floor,created_at,updated_at FROM \`$DB_NAME\`.content_stories ORDER BY id"
}

# Old rollback files may still contain publisher credentials. Only rewrite a
# simple, fully understood single-line dotenv file; otherwise preserve it for
# manual cleanup. This runs after the new release is healthy, not during rollback.
sanitize_backup() {
  backup=$1
  [ -f "$backup" ] || return 0
  temporary=$(mktemp "${backup}.sanitized.XXXXXX") || return 1
  if awk '
    /^[[:space:]]*(#|$)/ { print; next }
    {
      line = $0
      sub(/\r$/, "", line)
      if (! match(line, /^[[:space:]]*(export[[:space:]]+)?[[:alnum:]_.-]+[[:space:]]*=/)) exit 2
      prefix = substr(line, 1, RLENGTH)
      key = prefix
      sub(/^[[:space:]]*(export[[:space:]]+)?/, "", key)
      sub(/[[:space:]]*=.*/, "", key)
      value = substr(line, RLENGTH + 1)
      sub(/^[[:space:]]*/, "", value)
      quote = substr(value, 1, 1)
      if (quote == sprintf("%c", 39) || quote == sprintf("%c", 34) || quote == sprintf("%c", 96)) {
        closed = 0
        for (i = 2; i <= length(value); i++) {
          character = substr(value, i, 1)
          if (character == "\\") exit 2
          if (character == quote) { closed = 1; break }
        }
        if (! closed || substr(value, i + 1) !~ /^[[:space:]]*(#.*)?$/) exit 2
      }
      if (key !~ /^ALIYUN_ESA_PUBLISH_/) print
    }
  ' "$backup" > "$temporary" && chmod 600 "$temporary" && mv -f "$temporary" "$backup"; then
    return 0
  fi
  rm -f "$temporary"
  return 1
}

# 容器名必须问 compose，不能写死：容器名由 compose 里有没有 container_name 决定
# （这份 compose 是 CD 送来的，也可能被服务器上的人改过），写死名字会让健康门永远
# 看不到容器 —— 2026-10-09 第一次上线时就是这样：容器其实健康，门却超时判失败，
# 回滚锚点也是空的。
resolve_container() {
  compose ps -q "${1:-$SERVICE}" 2>/dev/null | head -n 1
}

# A rollback may remove the failed container. Keep its logs on the server with
# restricted permissions; never stream their contents into the CI log.
capture_failure_logs() {
  log_service=$1
  log_container=$(resolve_container "$log_service")
  if [ -z "$log_container" ]; then
    echo "未找到 $log_service 容器，无法保存其日志。" >&2
    return 0
  fi
  case "$log_service" in
    ''|*[!a-zA-Z0-9_-]*) log_label=service ;;
    *) log_label=$log_service ;;
  esac
  log_path=$(umask 077; mktemp "$DEPLOY_DIR/.deploy-failure-${log_label}.XXXXXX.log") || {
    echo "无法创建服务器诊断日志文件。" >&2
    return 0
  }
  if docker logs --tail 80 "$log_container" > "$log_path" 2>&1; then
    echo "容器日志保留在服务器：$log_path" >&2
  else
    echo "读取容器日志失败，诊断文件保留在服务器：$log_path" >&2
  fi
}

wait_until_ready() {
  readiness_service=${1:-$SERVICE}
  attempt=0
  while [ "$attempt" -lt "$ATTEMPTS" ]; do
    attempt=$((attempt + 1))
    container=$(resolve_container "$readiness_service")
    if [ -z "$container" ]; then
      echo "[$attempt/$ATTEMPTS] 没找到 $readiness_service 服务的容器" >&2
      return 1
    fi
    status=$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || echo missing)
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || echo missing)
    echo "[$attempt/$ATTEMPTS] service=$readiness_service status=$status health=$health"
    case "$status" in
      running)
        if [ "$health" = healthy ]; then
          return 0
        fi
        ;;
      exited|dead)
        echo "容器已退出（health=$health）" >&2
        return 1
        ;;
      restarting)
        echo "容器在重启循环中" >&2
        return 1
        ;;
    esac
    sleep "$INTERVAL"
  done
  echo "等待 $((ATTEMPTS * INTERVAL)) 秒仍未就绪" >&2
  return 2
}

previous_container=$(resolve_container)
previous_image=$(docker inspect --format '{{.Image}}' "$previous_container" 2>/dev/null || true)
previous_running=$(docker inspect --format '{{.State.Running}}' "$previous_container" 2>/dev/null || true)
compose_project=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$previous_container" 2>/dev/null || true)
compose_project=${compose_project:-$(basename "$DEPLOY_DIR")}
case "$compose_project" in *[!a-z0-9_-]*|'') echo 'Invalid Compose project' >&2; exit 1 ;; esac
previous_mqtt_container=$(resolve_container emqx)
previous_mqtt_image=
previous_mqtt_ref=
if [ -n "$previous_mqtt_container" ]; then
  previous_mqtt_image=$(docker inspect --format '{{.Image}}' "$previous_mqtt_container")
  previous_mqtt_ref=$(docker inspect --format '{{.Config.Image}}' "$previous_mqtt_container")
fi
previous_release_sha256=$({
  printf '%s\n%s\n' "$previous_image" "$previous_mqtt_image"
  for identity_file in "$previous_env_file" docker-compose.yml; do
    if [ -f "$identity_file" ]; then sha256sum "$identity_file"; fi
  done
} | sha256sum | cut -d ' ' -f 1)
echo "previous container: ${previous_container:-<none>} image: ${previous_image:-<none>}"

transaction_started=0
deployment_succeeded=0
pull_started=0
up_started=0
had_env=0
had_compose=0
writers_stopped=0
data_started=0

rollback_on_exit() {
  exit_status=$?
  trap - EXIT
  if [ "$exit_status" -ne 0 ] && [ "$transaction_started" -eq 1 ] && [ "$deployment_succeeded" -ne 1 ]; then
    set +e
    # A pre-cloud application would resume unleased main writes and local drafts.
    # Once the new process may have migrated/served traffic, retain its state and
    # stop editing for manual recovery instead of bringing that old writer back.
    unsafe_database=0
    if [ "$up_started" -eq 1 ] && [ "$data_started" -eq 0 ]; then
      release_check rollback > "$candidate_dir/rollback-check.log" 2>&1 || unsafe_database=1
    fi
    if [ "$data_started" -eq 1 ] || [ "$unsafe_database" -eq 1 ] ||
      { [ "$up_started" -eq 1 ] && [ "$had_env" -eq 1 ] &&
        grep -q '^CONTENT_DRAFT_PROTOCOL=cloud-v1$' .env.prod &&
        ! grep -q '^CONTENT_DRAFT_PROTOCOL=cloud-v1$' .env.prod.bak; }; then
      capture_failure_logs "$SERVICE"
      compose stop "$SERVICE"
      echo "发布已进入维护恢复状态：应用已停止，保留配置、数据库和备份，禁止自动启动不兼容的旧写者。" >&2
      exit "$exit_status"
    fi
    rollback_ok=1
    echo "部署失败：恢复旧 .env.prod 与 compose 配置" >&2
    if [ "$up_started" -eq 1 ] && [ -z "$previous_mqtt_container" ]; then
      candidate_mqtt_container=$(resolve_container emqx)
      if [ -n "$candidate_mqtt_container" ]; then
        docker rm -f "$candidate_mqtt_container" || rollback_ok=0
      fi
    fi
    if [ "$had_env" -eq 1 ]; then
      cp -p .env.prod.bak "$previous_env_file" || rollback_ok=0
      if [ "$previous_env_file" != .env.prod ]; then
        rm -f .env.prod || rollback_ok=0
      fi
    else
      rm -f .env.prod || rollback_ok=0
    fi
    active_env_file=$previous_env_file
    if [ "$had_compose" -eq 1 ]; then
      cp -p docker-compose.yml.bak docker-compose.yml || rollback_ok=0
    else
      rm -f docker-compose.yml || rollback_ok=0
    fi
    rm -f .env.prod.incoming docker-compose.yml.incoming || rollback_ok=0

    if [ "$pull_started" -eq 1 ] && [ -n "$previous_mqtt_image" ]; then
      case "$previous_mqtt_ref" in
        *@sha256:*) : ;; # Restored Compose already names the immutable local digest.
        *) docker tag "$previous_mqtt_image" "$previous_mqtt_ref" || rollback_ok=0 ;;
      esac
    fi
    if [ "$rollback_ok" -eq 1 ] && [ "$pull_started" -eq 1 ] && [ -n "$previous_image" ]; then
      docker tag "$previous_image" "$IMAGE" || rollback_ok=0
      if [ "$rollback_ok" -eq 1 ] && { [ "$up_started" -eq 1 ] || { [ "$writers_stopped" -eq 1 ] && [ "$previous_running" = true ]; }; }; then
        compose up -d --force-recreate || rollback_ok=0
        if [ "$rollback_ok" -eq 1 ] && [ -n "$previous_mqtt_container" ]; then
          wait_until_ready emqx || rollback_ok=0
        fi
        if [ "$rollback_ok" -eq 1 ]; then
          wait_until_ready || rollback_ok=0
        fi
      fi
    elif [ "$up_started" -eq 1 ] && [ -z "$previous_image" ]; then
      echo "没有旧镜像可恢复；配置文件已恢复，但首次部署需要人工处理。" >&2
      rollback_ok=0
    fi

    if [ "$rollback_ok" -eq 1 ]; then
      if [ "$up_started" -eq 1 ]; then
        echo "已完整回滚：旧镜像、.env.prod 与 compose 均已恢复。" >&2
      else
        echo "配置已回滚；容器未切换，无需重建。" >&2
      fi
    else
      echo "自动回滚未能完全完成，需要人工检查部署目录与容器。" >&2
    fi
  fi
  exit "$exit_status"
}
trap rollback_on_exit EXIT

printf '%s' "$ACR_PASSWORD" | docker login "${IMAGE%%/*}" -u "$ACR_USERNAME" --password-stdin

# CD 只上传 incoming 文件；切换前先验证候选 .env.prod，并保存完整回滚点。
umask 077
mkdir -p .release-plans
chmod 700 .release-plans
if [ "$DEPLOY_MODE" = maintenance ]; then
  case "${APPROVED_PLAN_ID:-}" in ''|*[!a-f0-9]*) echo 'Invalid approved plan' >&2; exit 1 ;; esac
  [ "${#APPROVED_PLAN_ID}" = 64 ] && [ "${CONFIRM_MAINTENANCE:-}" = true ] || exit 1
  candidate_dir="$DEPLOY_DIR/.release-plans/$APPROVED_PLAN_ID"
  [ -f "$candidate_dir/plan.json" ] && [ -f "$candidate_dir/decision.env" ] || { echo '预检计划不存在。' >&2; exit 1; }
else
if [ ! -f .env.prod.incoming ]; then
  echo "缺少 .env.prod.incoming，拒绝部署。" >&2
  exit 1
fi
if grep -q '=<required>' .env.prod.incoming; then
  echo ".env.prod.incoming 还有 <required> 占位符未填，拒绝部署。" >&2
  exit 1
fi
if [ ! -f docker-compose.yml.incoming ]; then
  echo "缺少 docker-compose.yml.incoming，拒绝部署。" >&2
  exit 1
fi
  candidate_dir=$(mktemp -d "$DEPLOY_DIR/.release-plans/staging-XXXXXXXX")
  cp .env.prod.incoming "$candidate_dir/.env.prod"
  cp docker-compose.yml.incoming "$candidate_dir/docker-compose.yml"
fi

if ! candidate_compose config -q; then
  echo '候选配置校验失败，旧配置与容器未切换。' >&2
  exit 1
fi
pull_started=1
candidate_compose pull
previous_protocol=legacy
if [ -f "$previous_env_file" ] && grep -q '^CONTENT_DRAFT_PROTOCOL=cloud-v1$' "$previous_env_file"; then previous_protocol=cloud-v1; fi
if [ "$DEPLOY_MODE" = maintenance ]; then
  release_check plan "$APPROVED_PLAN_ID" "$previous_protocol" "$previous_release_sha256"
else
  release_check plan new "$previous_protocol" "$previous_release_sha256"
  . "$candidate_dir/decision.env"
  [ ! -e "$DEPLOY_DIR/.release-plans/$PLAN_ID" ] || { echo '该计划已存在，请使用已有计划。' >&2; exit 1; }
  mv "$candidate_dir" "$DEPLOY_DIR/.release-plans/$PLAN_ID"
  candidate_dir="$DEPLOY_DIR/.release-plans/$PLAN_ID"
fi
. "$candidate_dir/decision.env"
[ "$SQL_RECOVERY_REQUIRED" = 0 ] || { echo '存在可能部分执行的 SQL，须先人工核对恢复。' >&2; exit 1; }
if [ "$MAINTENANCE_REQUIRED" = 1 ] && [ "$DEPLOY_MODE" != maintenance ]; then
  echo "需要维护发布；旧服务未切换。请在 Maintenance Deploy 授权计划：$PLAN_ID" >&2
  exit 1
fi
cp "$candidate_dir/.env.prod" .env.prod.incoming
cp "$candidate_dir/docker-compose.yml" docker-compose.yml.incoming

if [ -f "$previous_env_file" ]; then
  cp -p "$previous_env_file" .env.prod.bak
  had_env=1
fi
if [ -f docker-compose.yml ]; then
  cp -p docker-compose.yml docker-compose.yml.bak
  had_compose=1
fi

transaction_started=1
if [ "$DEPLOY_MODE" = maintenance ]; then
  if [ -n "$previous_container" ]; then
    compose stop "$SERVICE"
    writers_stopped=1
  fi
  # Check the approved ledger again after every old writer has disconnected.
  release_check plan "$APPROVED_PLAN_ID" "$previous_protocol" "$previous_release_sha256"
  if ! backup_and_verify > "$candidate_dir/backup-verification.log" 2>&1; then
    echo '备份或隔离恢复验证失败，未执行生产迁移；详细日志保留在计划目录。' >&2
    exit 1
  fi
  echo "一致性备份已通过隔离恢复验证：$recovery"
fi
mv .env.prod.incoming .env.prod
chmod 600 .env.prod
active_env_file=.env.prod
mv docker-compose.yml.incoming docker-compose.yml
echo "候选 .env.prod 与 compose 已切换（旧配置备份为 .env.prod.bak / docker-compose.yml.bak）"

# 必须在两份候选配置同时就位后校验，确保 env_file 和 Compose 插值都是新值。
if ! compose config -q; then
  echo "候选 .env.prod / compose 校验失败，自动恢复旧配置。" >&2
  exit 1
fi

if [ "$DEPLOY_MODE" = maintenance ]; then
  data_started=1
  if ! candidate_compose run --rm --no-deps app node .output/server/maintenance/migrate.mjs --maintenance > "$candidate_dir/maintenance.log" 2>&1; then
    echo '生产维护迁移失败，详细结果保留在计划目录。' >&2
    exit 1
  fi
  if ! release_check verify before-start > "$candidate_dir/data-verification.log" 2>&1; then
    echo '迁移数据校验失败。' >&2
    exit 1
  fi
  if [ "${VERIFY_MAIN_UNCHANGED:-0}" = 1 ]; then
    snapshot_main > "$recovery/main-after.tsv"
    cmp "$recovery/main-before.tsv" "$recovery/main-after.tsv"
  fi
fi
up_started=1
compose up -d

if ! wait_until_ready emqx; then
  echo "项目 MQTT broker 未就绪，拒绝完成部署。" >&2
  capture_failure_logs emqx
  exit 1
fi

set +e
wait_until_ready
readiness=$?
set -e

if [ "$readiness" -eq 0 ]; then
  # Container health does not prove that the public authenticated WSS route exists.
  if ! release_check verify-public > "$candidate_dir/public-verification.log" 2>&1; then
    echo '公网 HTTP/WSS 验收失败。' >&2
    exit 1
  fi
  if ! release_check verify > "$candidate_dir/final-migrations.log" 2>&1; then
    echo '迁移完成回执校验失败。' >&2
    exit 1
  fi
  if ! release_check receipt "$DEPLOY_MODE" "${DEPLOY_EXECUTION_ID:-manual}" > "$candidate_dir/receipt.log" 2>&1; then
    echo '生产回执保存失败。' >&2
    exit 1
  fi
  if [ -f .env ]; then
    mv .env .env.legacy.bak
  fi
  docker image prune -f || echo "清理悬空镜像失败，忽略此项" >&2
  deployment_succeeded=1
  for backup in .env.prod.bak .env.legacy.bak; do
    if ! sanitize_backup "$backup"; then
      echo "无法安全清理 $backup 中的发布凭据；请手动检查该备份。" >&2
    fi
  done
  if [ -n "${recovery:-}" ] && ! sanitize_backup "$recovery/$(basename "$previous_env_file")"; then
    echo '无法清理恢复配置中的历史发布凭据，请检查私有恢复目录。' >&2
  fi
  echo "部署完成：容器已就绪"
  exit 0
fi

capture_failure_logs "$SERVICE"

echo "健康门失败（状态码 $readiness），将恢复旧镜像和配置。" >&2
exit 1
