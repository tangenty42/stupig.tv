# DESIGN：构建与部署工作流

- 本文档状态：DONE
- 覆盖范围：生产发布、失败回退

## 场景

| 场景 | 怎么做 | 说明 |
| --- | --- | --- |
| 正常发布 | 准备好 `.env.prod.gpg`（见 `SID#1.1`）；合并到 `main`，Check 通过后 Deploy 会自动运行 | 流程：构建镜像 → 推送到 ACR → 服务器拉取镜像 → 部署预检 → 更新容器并启动服务 → 健康检查 → 发布 ESA 函数 |
| 发布含维护迁移的版本 | 先正常 Deploy；若当前符合维护迁移条件，Deploy 时会自动停下并打印一个 `plan_id`（请记住这个，后面要用）；然后在 Actions 手动运行 Maintenance Deploy，填之前记住的 `plan_id` 并确认 | 会：停止写入 → 核验备份与恢复 → 执行迁移 → 恢复服务；复用已构建的镜像；『停止写入』时，工作流只能停止受控应用，独立 worker、外部 cron 等其他写入者须事先自行停止 |
| 单独发布 ESA 函数 | 本地跑 `pnpm esa:deploy:prod`；正式发布前先用 `--plan`（输出发布计划）或 `--check`（对云端只读检查）看一眼 | 正常发布（包括发布含维护迁移的版本）已包含 ESA 函数的自动发布，平时不用手动跑 |
| 应用部署失败 | 若新版本健康检查过不了，服务器会尝试回退旧镜像、配置并恢复服务；维护迁移已经开始或其他回退检查不通过时，会停止服务、保留现场，等待人工恢复；本地已准备生产配置、且能正常连接生产库时，可用 `pnpm migrate:prod --status` 看迁移状态（生产容器内的执行方式见 `SID#1.4`） | 已执行的数据库迁移不会自动撤销，回退镜像也不会使数据库恢复到迁移前的状态 |
| ESA 发布失败 | 核对 ESA 发布回执和实际线上版本，修复后单独重新发布 | 不会自动触发已部署应用的失败回退 |
| 回到旧版本 | 在 `main` 提交回退改动，重新走 Check 和 Deploy；保留已有迁移、并确认回退代码兼容当前数据库 | 只改代码，不会自动撤销数据变更 |

## 所需配置

- **GitHub Secrets**：`ACR_USERNAME`、`ACR_PASSWORD`、`SSH_PRIVATE_KEY`、`SSH_KNOWN_HOSTS`、`ENV_PASSPHRASE`；
- **GitHub Variables**：`ACR_IMAGE`、`SSH_HOST`、`SSH_PORT`、`SSH_USER`、`DEPLOY_DIR`，可选 `MYSQL_BACKUP_CONTAINER`。

生产环境变量来自仓库中的 `.env.prod.gpg`，CI 用 `ENV_PASSPHRASE` 解密，用完就删除明文。

- 环境变量修改方式见 `SID#1.1`；
- 各云服务、服务器与 GitHub 的初次配置见 `SID#1.0`。
