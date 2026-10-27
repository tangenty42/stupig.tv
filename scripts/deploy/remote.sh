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
#   IMAGE             完整镜像地址（含 :latest）
#   ACR_USERNAME / ACR_PASSWORD                 CI 与主机共用的 Registry 凭据
#   HEALTH_ATTEMPTS / HEALTH_INTERVAL_SECONDS   可选，健康门窗口（默认 72 × 5s = 6 分钟）
#   SERVICE                                     可选，compose 里的服务名（默认 app），
#                                               容器用它来解析，不靠容器的实际名字
#
# workflow 先把新 .env.prod 和 docker-compose.yml 上传为 incoming；本脚本备份旧文件后再切换。
# 配置、镜像或健康门任一失败都会恢复旧文件和镜像；数据库迁移是前向迁移，不自动回退。
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

# The previous release may still use .env. Only rollback reads that legacy name.
previous_env_file=.env.prod
if [ ! -f .env.prod ] && [ -f .env ]; then
  previous_env_file=.env
fi
active_env_file=$previous_env_file
compose() {
  docker compose --env-file "$active_env_file" "$@"
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
previous_mqtt_container=$(resolve_container emqx)
previous_mqtt_image=
previous_mqtt_ref=
if [ -n "$previous_mqtt_container" ]; then
  previous_mqtt_image=$(docker inspect --format '{{.Image}}' "$previous_mqtt_container")
  previous_mqtt_ref=$(docker inspect --format '{{.Config.Image}}' "$previous_mqtt_container")
fi
echo "previous container: ${previous_container:-<none>} image: ${previous_image:-<none>}"

transaction_started=0
deployment_succeeded=0
pull_started=0
up_started=0
had_env=0
had_compose=0

rollback_on_exit() {
  exit_status=$?
  trap - EXIT
  if [ "$exit_status" -ne 0 ] && [ "$transaction_started" -eq 1 ] && [ "$deployment_succeeded" -ne 1 ]; then
    set +e
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
      docker tag "$previous_mqtt_image" "$previous_mqtt_ref" || rollback_ok=0
    fi
    if [ "$rollback_ok" -eq 1 ] && [ "$pull_started" -eq 1 ] && [ -n "$previous_image" ]; then
      docker tag "$previous_image" "$IMAGE" || rollback_ok=0
      if [ "$rollback_ok" -eq 1 ] && [ "$up_started" -eq 1 ]; then
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

if [ -f "$previous_env_file" ]; then
  cp -p "$previous_env_file" .env.prod.bak
  had_env=1
fi
if [ -f docker-compose.yml ]; then
  cp -p docker-compose.yml docker-compose.yml.bak
  had_compose=1
fi

transaction_started=1
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

pull_started=1
compose pull
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
  echo "部署完成：容器已就绪"
  exit 0
fi

capture_failure_logs "$SERVICE"

echo "健康门失败（状态码 $readiness），将恢复旧镜像和配置。" >&2
exit 1
