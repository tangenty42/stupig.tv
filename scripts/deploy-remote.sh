#!/bin/sh
# 服务器端部署序列：由 .github/workflows/deploy.yml 通过 `ssh … sh -s` 管道执行，
# 步骤与 GitHub 上的运行状态无关（workflow 只负责把这份脚本送过去并转发退出码）。
#
# 为什么是文件而不是 workflow 里的内联字符串：SSH → 远端 shell 的两层引号转义本身
# 就是事故来源（`$(...)`、`{{...}}`、`!` 各层的含义都不同，写错一处只有真部署时
# 才暴露），而放进文件后这段逻辑能在本地用替身 docker 逐条分支跑
# （见 scripts/deploy-remote.test.ts）。
#
# 输入（workflow 通过远端命令行传入）：
#   DEPLOY_DIR        服务器上 compose 文件与 .env 所在目录
#   IMAGE             完整镜像地址（含 :latest）
#   ACR_USERNAME / ACR_PASSWORD
#   HEALTH_ATTEMPTS / HEALTH_INTERVAL_SECONDS   可选，健康门窗口（默认 72 × 5s = 6 分钟）
#   SERVICE                                     可选，compose 里的服务名（默认 app），
#                                               容器用它来解析，不靠容器的实际名字
#
# workflow 先把新 .env 和 docker-compose.yml 上传为 incoming；本脚本备份旧文件后再切换。
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

# 容器名必须问 compose，不能写死：容器名由 compose 里有没有 container_name 决定
# （这份 compose 是 CD 送来的，也可能被服务器上的人改过），写死名字会让健康门永远
# 看不到容器 —— 2026-10-09 第一次上线时就是这样：容器其实健康，门却超时判失败，
# 回滚锚点也是空的。
resolve_container() {
  docker compose ps -q "$SERVICE" 2>/dev/null | head -n 1
}

wait_until_ready() {
  attempt=0
  while [ "$attempt" -lt "$ATTEMPTS" ]; do
    attempt=$((attempt + 1))
    container=$(resolve_container)
    if [ -z "$container" ]; then
      echo "[$attempt/$ATTEMPTS] 没找到 $SERVICE 服务的容器" >&2
      return 1
    fi
    status=$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || echo missing)
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || echo missing)
    echo "[$attempt/$ATTEMPTS] status=$status health=$health"
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
    echo "部署失败：恢复旧 .env 与 compose 配置" >&2
    if [ "$had_env" -eq 1 ]; then
      cp -p .env.bak .env || rollback_ok=0
    else
      rm -f .env || rollback_ok=0
    fi
    if [ "$had_compose" -eq 1 ]; then
      cp -p docker-compose.yml.bak docker-compose.yml || rollback_ok=0
    else
      rm -f docker-compose.yml || rollback_ok=0
    fi
    rm -f .env.incoming docker-compose.yml.incoming || rollback_ok=0

    if [ "$rollback_ok" -eq 1 ] && [ "$pull_started" -eq 1 ] && [ -n "$previous_image" ]; then
      docker tag "$previous_image" "$IMAGE" || rollback_ok=0
      if [ "$rollback_ok" -eq 1 ] && [ "$up_started" -eq 1 ]; then
        docker compose up -d --force-recreate || rollback_ok=0
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
        echo "已完整回滚：旧镜像、.env 与 compose 均已恢复。" >&2
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

echo "$ACR_PASSWORD" | docker login "${IMAGE%%/*}" -u "$ACR_USERNAME" --password-stdin

# CD 只上传 incoming 文件；切换前先验证候选 .env，并保存完整回滚点。
if [ ! -f .env.incoming ]; then
  echo "缺少 .env.incoming，拒绝部署。" >&2
  exit 1
fi
if grep -q '=<required>' .env.incoming; then
  echo ".env.incoming 还有 <required> 占位符未填，拒绝部署。" >&2
  exit 1
fi
if [ ! -f docker-compose.yml.incoming ]; then
  echo "缺少 docker-compose.yml.incoming，拒绝部署。" >&2
  exit 1
fi

if [ -f .env ]; then
  cp -p .env .env.bak
  had_env=1
fi
if [ -f docker-compose.yml ]; then
  cp -p docker-compose.yml docker-compose.yml.bak
  had_compose=1
fi

transaction_started=1
mv .env.incoming .env
chmod 600 .env
mv docker-compose.yml.incoming docker-compose.yml
echo "候选 .env 与 compose 已切换（旧配置备份为 .env.bak / docker-compose.yml.bak）"

# 必须在两份候选配置同时就位后校验，确保 env_file 和 Compose 插值都是新值。
if ! docker compose config -q; then
  echo "候选 .env / compose 校验失败，自动恢复旧配置。" >&2
  exit 1
fi

pull_started=1
docker compose pull
up_started=1
docker compose up -d

set +e
wait_until_ready
readiness=$?
set -e

if [ "$readiness" -eq 0 ]; then
  docker image prune -f || echo "清理悬空镜像失败，忽略此项" >&2
  deployment_succeeded=1
  echo "部署完成：容器已就绪"
  exit 0
fi

echo "--- docker compose ps ---"
docker compose ps || true
echo "--- 容器最后 80 行日志 ---"
docker logs --tail 80 "$(resolve_container)" 2>&1 || true

echo "健康门失败（状态码 $readiness），将恢复旧镜像和配置。" >&2
exit 1
