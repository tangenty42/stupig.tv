# AGENT-DESIGN：档案摘要、列表与详情页的实现

- 本文档状态：PENDING（初稿，待人类审阅）
- 覆盖范围：摘要的解析与存储、列表与正文接口、列表页、详情页、事件日历
- 对应 LAW：[SID#2.4.0.LAW](LAW.md)；总则见 [SID#2.4.AGENT-DESIGN](../AGENT-DESIGN.md)

## 入口

| 位置 | 内容 |
| --- | --- |
| `server/shared/content-markdown.ts` | Front Matter 解析、评分与置顶标签 |
| `server/services/content/story.service.ts` | `list_stories`、`get_story_body`，以及发布时写入 `content_stories` 的 `create_story`、`update_story` |
| `app/features/content/stories.ts` | `useContentStories`、`useContentStory` |
| `app/pages/content/index.vue`、`app/pages/content/[id]/index.vue` | 列表页、详情页 |
| `app/components/MyContent/Story/` | `Card`、`Header`、`Calendar`、`Cover`、`PublishedList`、`DraftList` |
| `app/features/content/event.ts`、`story-cover.ts`、`image-frame.ts`、`story-presentation.ts` | 日期格式化、封面地址、跨入口复用的评分图 URL 与可见标签。列表、详情和正文共用 `image-frame.ts` 生成的图框 |

`app/pages/content/drafts.vue` 是兼容入口，跳到列表页的草稿视图，草稿列表归 `1_drafts`。

列表页的『已发布』和『未发布草稿』由 `<Suspense suspensible>` 包住，二选一挂载 `PublishedList` 和 `DraftList`。切到草稿时，已发布列表留在屏幕上，等草稿列表的首次请求结束后一次换上；档案数量、事件日历和分隔线跟随实际显示的视图同时切换。标签筛选和排序方式存在页面里，来回切换不会丢。写法见 [前端组件与样式](../../../0_overall/1_architecture/AGENT-DESIGN.md#前端组件与样式)。

## 摘要的来源

摘要写在档案 Markdown 最前面的 Front Matter 里，档案 Markdown 是唯一来源，发布时解析并写进 `content_stories` 的列：

```markdown
---
title: 蠢猪大闹食堂
label: #人上人 食堂 爆笑
time: 2026/3/14 ~ 2026/3/16
desc: 一段说明
cover: ![食堂里的蠢猪小组](cover.jpg)
---
```

| 键 | 列 | 规则 |
| --- | --- | --- |
| `title` | `title` | 必填；不能为空、超长、含非法字符或与别的档案重名 |
| `time` | `event_precision`、`event_dates`（JSON 数组，排好序） | 选填，省略时 `event_dates` 为空数组。填写时用一天 `YYYY/M/D`、一月 `YYYY/M`，或用 `~` 连接的同精度区间。空值报错 |
| `label` | `label` | 选填，空格分隔，不能重复；`#` 开头的是特殊标签，只认评分五档和 `#置顶`，评分标签最多一个 |
| `desc` | `description` | 选填，纯文字 |
| `cover` | `cover`、`cover_label` | 选填，图片语法或文件名 |

解析器前后端共用：编辑器实时检查用它，服务端发布时也用它。

## 特殊标签

| 标签 | 效果 |
| --- | --- |
| `#拉完了` `#NPC` `#人上人` `#顶级` `#夯` | 评分，由低到高；`story_rating_rank` 返回 1 到 5，水印图为 `imgs/ratings/{6 - rank}.svg` |
| 无评分标签 | `story_rating` 返回“难评”，没有水印 |
| `#置顶` | `story_pinned` 为真，排在最前 |

所有 `#` 标签都不在卡片、详情页和标签筛选里显示。各展示入口共用 `story-presentation.ts` 的 `visible_story_labels()`；评分水印和正文引用卡的徽章图片共用 `story_rating_image_url()`。

列表卡、详情和编辑页摘要共用 `MyContentStoryWatermark`。当前评分的 SVG 加载成功后，斜纹水印用 500 毫秒渐入。切换评分时按新图片的加载结果展示，无法读取时不铺水印。系统开启减少动态效果时直接显示水印。

## 接口

| 接口 | 权限 | 返回 |
| --- | --- | --- |
| `content.listStories` | 公开 | 全部档案的摘要，按 `updated_at` 倒序；附带 `title_revision` |
| `content.getStoryBody` | 公开，按身份决定是否删减 | 正文和摘要；传入的 `base_representation_version` 与当前一致时返回 `null`；档案不存在时 404 |

封面地址由 `list_cover_presentations` 生成，始终使用公开投影。旧已发布档案仍引用机密附件时，有公开删减版就显示它，没有则不返回封面地址。列表和详情沿用现有占位，正文档案引用卡省略不可读封面。

使用档案附件作封面时，首次发布和保存更新都检查被引用附件当前有效的 `is_private`，机密附件拒绝发布并提示『封面不能使用机密附件，请改用公开图片或删减版！』。明确引用公开删减版可以发布，云端草稿自动保存照常。发布后才改变附件机密状态时，封面沿用上述公开投影回退，下一次发布再检查。新增发布检查待人工验收。

## 数据加载与更新

| 组合式函数 | 通知资源 | 说明 |
| --- | --- | --- |
| `useContentStories` | `content_stories:all` | 列表页、详情页的日历，以及正文里的档案引用共用同一份数据 |
| `useContentStory` | `content_story:<id>` | 详情页正文；404 时 `story` 置空，不弹提示；刷新失败时保留已读到的正文 |

机制见 `SID#0.1.DESIGN`；这两个资源的通知由发布和删除档案的事务写入 outbox，见 `1_drafts`。

## 列表页

- 排序在前端完成，置顶始终优先。按时间时，每组先排无日期的档案，再按 `event_dates` 拼接后的字符串倒序。按评分时，每组先按评分，再按日期字符串倒序。同项按标题排序。
- 无日期档案的卡片省略日期行，只在有普通标签时显示底部一行。
- 标签筛选的状态和排序方式都是页面内的 `reactive`/`ref`，不写进地址栏。非空列表始终提供排序按钮，不依赖普通标签；数据更新使已选标签消失后仍保留『清除』。
- `?view=drafts` 只对有 `full` 权限的人生效，其他人一律看到已发布列表。
- 宽屏为两列，卡片交替放进两列，所以阅读顺序是按行的。
- 列表和详情的 `Cover.vue` 在水合时接续服务端输出的图片和低清层。直接打开时延续已经开始的呼吸周期，换封面地址时启动新一轮加载。
- 已发布档案查询尚无结果且正在请求时用骨架。首载失败时在空态位置显示带刷新图标、大号描边次要样式的『重新加载』按钮。取到数据后才显示数量和日历。后台刷新失败时保留已读到的列表。

## 详情页

- `MyContentStoryHeader` 显示摘要和评分水印，`editable` 为真时显示编辑按钮。页头的高度动画容器与色带同宽，操作栏和摘要文字对齐正文栏；封面加载引起高度变化时，色带两侧仍铺到视口边缘
- 无日期时省略页头的日期和整块『事件日历』。
- 页面标题为“蠢猪档案 - {标题}”；设置 `og:*` 和 `article:*` 元信息。以 `#` 开头的封面不作为 `og:image`。
- 正文中的文件夹链接会展开附件区里对应的文件夹，并滚动到附件区。
- 正文尚无快照时，加载期间显示转圈，临时失败显示『重新加载』并弹一次错误 Toast。自动重试期间保留失败界面，手动重试期间显示转圈。确认 404 时显示『档案不存在或已被删除』，不弹 Toast；已有正文刷新失败时保留正文并提示。

## 事件日历

- 日历只收录有日期的档案。每篇取 `event_dates` 的最早和最晚日期，按月精度的档案画到最后一个月的月底。
- 横条按开始日期排序，颜色按顺序轮流取。悬停在一段横条上时，同一篇档案的所有横条一起高亮。
- 可翻范围：列表页是所有档案涉及的月份；传入 `highlight_id` 时是这篇档案的起止月份。
- 默认月份：传入 `initial_month` 时用它，否则用可翻范围里最晚的月份；还没有档案时用当前月份。手动翻页之后，数据再变化也不会自动跳走，只会被收回到可翻范围内。

## LAW 没写的细节

- 列表为空时显示“还没有档案~”；筛选后为空时显示“没有符合筛选条件的档案~”。
- 档案总数只在已发布视图里显示，写法是“N 份の 蠢猪档案！”。
- 筛选栏有“清除”，排序按钮显示『排序：按时间』或『排序：按评分』，分别配日历和星标。评分排序时按钮的 `aria-pressed` 为真。

## 验收标准

| 条目 | 测试 |
| --- | --- |
| Front Matter 的解析和报错 | `server/shared/content-markdown.test.ts` |
| 列表和正文带相同的封面尺寸与 LQIP | `story.service.test.ts` 的 “includes the same public cover dimensions …” |
| 正文的版本标识按服务端的身份计算 | `story.service.test.ts` 的 “checks server viewer identity …” |
| 机密封面只给删减版，没有删减版就不给 | `cover-presentation.test.ts` 的 “uses only the redaction metadata …” |
| 档案不存在时共享空状态，不弹 404 提示 | `stories.test.ts` 的 “shares a confirmed missing story …” |
| 首载失败可从详情页重试，自动重试期间保留失败状态 | [详情页组件测试](../../../../app/pages/content/%5Bid%5D/index.nuxt.test.ts) 和 `stories.test.ts` 的 “keeps the first-load failure visible …” |
| 刷新失败时保留已读到的正文 | `stories.test.ts` 的 “keeps a readable story …” |
| 排序、筛选、日历的可翻范围与默认月份 | [列表页与日历组件测试](../../../../app/pages/content/index.nuxt.test.ts) |
