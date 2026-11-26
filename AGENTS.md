# 项目指引

先读 [Swordoc 宪章](docs/README.md) 和 [全项目工程约定](docs/0_overall/AGENT-DESIGN.md)。再按本次涉及的文件和主题查阅下表。

**Agent 对权威文档一律只读。** `docs/README.md` 和 `docs/` 下各级 `LAW.md`、`DESIGN.md` 只由人类创建、修改或删除。委派子代理和批量格式化时也须遵守。

人类裁定“把这条写进 LAW”时，Agent 在所属目录的 `AGENT.md` 记录裁定，在回复中给出建议文字。有需要时可在同目录的 `TMP-LAW.md` 起草，正式条文由人类亲自写入。

改业务代码时，下表只给技术约定；业务规则另按 [源码与领域对照](docs/2_domains/AGENT-DESIGN.md#源码与领域对照) 找到所属领域目录，读它已有的 LAW、AGENT-DESIGN 和 AGENT。LAW 与代码不符时先问人类。

| 涉及范围 | 阅读入口 |
| --- | --- |
| 总体业务和实现 | [项目背景](docs/0_overall/0_background/LAW.md)、[板块职责](docs/0_overall/1_architecture/LAW.md)、[总体架构](docs/0_overall/1_architecture/DESIGN.md) |
| `app/**/*.{vue,ts}` | [前端分区](docs/0_overall/1_architecture/DESIGN.md#前端)、[前端实现约定](docs/0_overall/1_architecture/AGENT-DESIGN.md#前端组件与样式)、[测试](docs/1_workflows/2_test/AGENT-DESIGN.md) |
| `server/**/*.ts` | [后端分区](docs/0_overall/1_architecture/DESIGN.md#后端)、[后端实现约定](docs/0_overall/1_architecture/AGENT-DESIGN.md#后端入口与类型)、[测试](docs/1_workflows/2_test/AGENT-DESIGN.md) |
| SQL、迁移与迁移工具 | [编写与冻结](docs/1_workflows/1_develop/AGENT-DESIGN.md#编写数据库迁移)、[迁移验证](docs/1_workflows/2_test/AGENT-DESIGN.md#专项数据库与迁移演练)、[执行及恢复](docs/1_workflows/4_maintain/AGENT-DESIGN.md#迁移查询与失败恢复) |
| 初次配置、开发、测试、交付、维护 | [工作流程总览](docs/1_workflows/DESIGN.md) |
| 领域业务与文档进度 | [领域文档的组织方式](docs/2_domains/AGENT-DESIGN.md)、[领域文档进度](docs/2_domains/AGENT.md)、[文档进度](docs/AGENT.md) |
