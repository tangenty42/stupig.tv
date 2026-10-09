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
# 另外，workflow 会先把仓库里的 docker-compose.yml 送到 $DEPLOY_DIR/docker-compose.yml.incoming，
# 本脚本校验后把它换到位（旧的备份成 docker-compose.yml.bak）—— 那份文件是线上编排的
# 唯一来源，不再依赖手工同步。
#
# 设计取舍（2026-10-09 事故后加的）：
#   - 健康门的**唯一**决定性失败信号是容器 exited / restarting。超时（容器仍在
#     running，只是还没 healthy）只让 workflow 变红，**不自动回滚**：慢启动或大迁移
#     都可能超时，凭模糊信号把线上降级到旧镜像比留在原地更危险。
#   - 但容器退出/重启循环是确定的坏消息，此时自动回滚，站点自己恢复。
#   - 回滚锚点必须在 pull 之前取：pull 之后旧镜像的 tag 被 :latest 顶掉，只剩 ID，
#     而成功路径末尾的 prune 会把它当悬空镜像删掉 —— 所以只在成功后 prune。
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

echo "$ACR_PASSWORD" | docker login "${IMAGE%%/*}" -u "$ACR_USERNAME" --password-stdin

# 回滚锚点要在任何改动之前抓：容器与镜像都可能被下面的步骤替换掉
previous_container=$(resolve_container)
previous_image=$(docker inspect --format '{{.Image}}' "$previous_container" 2>/dev/null || true)
echo "previous container: ${previous_container:-<none>} image: ${previous_image:-<none>}"

# compose 文件由 CD 送到 .incoming（见 .github/workflows/deploy.yml）：校验通过才落到
# 位，旧的那份留成 .bak，出问题可以直接 cp 回去。以前这份文件只存在于服务器上，于是
# 它悄悄漂移（探针探的是 /、没有 container_name 导致容器叫 stupig-tv-app-1），而仓库
# 里那份看起来"已经配置好了"。校验的意义：这个文件是线上唯一的编排描述，送进来一份
# 语法或插值有问题的会把下次部署也一起弄坏。
if [ -f docker-compose.yml.incoming ]; then
  if ! docker compose -f docker-compose.yml.incoming config -q; then
    echo "送来的 compose 文件校验失败，保留服务器上现有的那份" >&2
    rm -f docker-compose.yml.incoming
    exit 1
  fi
  if [ -f docker-compose.yml ]; then
    cp -p docker-compose.yml docker-compose.yml.bak
  fi
  mv docker-compose.yml.incoming docker-compose.yml
  echo "compose 已更新（旧文件备份为 docker-compose.yml.bak）"
fi

docker compose pull
docker compose up -d

# 轮询容器状态：0 = 已就绪，1 = 确定的坏消息（退出/重启循环），2 = 超时未就绪。
# 每次采样都打印，失败时这些行就是"它当时到底在干什么"的证据。
wait_until_ready() {
  attempt=0
  while [ "$attempt" -lt "$ATTEMPTS" ]; do
    attempt=$((attempt + 1))
    # 每次重新解析：容器在 up -d / 回滚时会被重建，ID 随之改变
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

set +e
wait_until_ready
readiness=$?
set -e

if [ "$readiness" -eq 0 ]; then
  docker image prune -f
  echo "部署完成：容器已就绪"
  exit 0
fi

echo "--- docker compose ps ---"
docker compose ps || true
echo "--- 容器最后 80 行日志 ---"
docker logs --tail 80 "$(resolve_container)" 2>&1 || true

if [ "$readiness" -eq 2 ]; then
  echo "容器仍在运行但没有通过健康检查，未自动回滚（可能是慢启动）。" >&2
  echo "人工判断后回滚：docker tag $previous_image $IMAGE && docker compose up -d --force-recreate" >&2
  exit 1
fi

if [ -z "$previous_image" ]; then
  echo "没有可回滚的旧镜像，站点需要人工处理。" >&2
  exit 1
fi

echo "回滚到 $previous_image"
docker tag "$previous_image" "$IMAGE"
docker compose up -d --force-recreate
set +e
wait_until_ready
rollback=$?
set -e

if [ "$rollback" -eq 0 ]; then
  echo "已回滚：新镜像有问题，旧镜像已重新提供服务。" >&2
else
  echo "回滚后仍未就绪，需要人工介入。" >&2
fi
echo "回滚命令（供参考）：docker tag $previous_image $IMAGE && docker compose up -d --force-recreate" >&2
exit 1
