# TMP：基础设施总览的固定布局试稿

此方案已放弃，仅保留试排记录。原依据是 [SID#0.1.DESIGN](DESIGN.md) 此前将开发回调加入主图的版本；当前改为保留主图，另设普通 flowchart 对照图，见 [SID#0.1.TMP-AUTH-CALLBACK](TMP-AUTH-CALLBACK.md)。本文件不定义新的架构要求。

## 总览试稿

完整保留原图的 20 条有向关系，缩短部分连线标签。此版用于比较布局能力，暂不建议直接替换主图：节点位置固定后，直线连接仍会穿过其他节点或与标签重叠。

```mermaid
---
config:
  theme: neutral
  themeVariables:
    fontFamily: 'Microsoft YaHei, sans-serif'
    fontSize: '14px'
  block:
    padding: 16
---
block-beta
  columns 9

  space:2 Browser["用户浏览器"]:2 space Edge["ESA 边缘函数"]:2 space Delivery["ESA 缓存层"]
  space:9

  MQTT["EMQX"] space Proxy["生产：容器反向代理"]:2 space
  block:DevCallback:3
    columns 3
    DevTitle["开发环境授权回调"]:3
    DevTunnel["FRP 隧道"] space DevProxy["本机专用代理"]
  end
  space
  space:9

  space:2
  block:Application:5
    columns 3
    AppTitle["Nuxt 应用进程"]:3
    Web["Nuxt SSR / Nitro / tRPC"] space Runner["应用内后台 runner"]
  end
  space
  OSS[("阿里云 OSS")]

  space:9
  DB[("MySQL")]:2 space:2 External["阿里云短信 / CAPTCHA / ESA 管理接口"]:3 space:2

  Browser -- "页面与业务请求" --> Proxy
  Proxy --> Web
  Edge -- "生产授权回调" --> Proxy
  Edge -. "开发授权回调" .-> DevTunnel
  DevTunnel -.-> DevProxy
  DevProxy -.-> Web

  Web --> DB
  Runner --> DB
  Web -- "数据变更通知" --> MQTT
  Runner -- "蠢猪档案 outbox 投递" --> MQTT
  MQTT -- "WebSocket 更新通知" --> Browser

  Web -- "对象操作" --> OSS
  Runner -- "图片处理与垃圾清扫" --> OSS
  Browser -- "签名分片上传" --> OSS
  Browser -- "附件读取（重定向后）" --> Edge
  Edge -- "授权后放行" --> Delivery
  Browser -- "公开静态资源" --> Delivery
  Delivery -- "未命中时回源" --> OSS

  Web --> External
  Runner --> External

  style DevCallback fill:#f8fafc,stroke:#888,stroke-width:1px,stroke-dasharray:5 5
  style DevTitle fill:transparent,stroke:none
  style Application fill:#f1f5f9,stroke:#94a3b8
  style AppTitle fill:transparent,stroke:none
```

本图以生产环境为基础；虚线和虚框表示开发环境专用的授权回调通道，两条回调通道按环境配置选择。Nuxt 应用节点代表对应环境的实例。

本机专用代理仅转发 `POST /api/content/authorize`；开发回调的公网 HTTPS 入口等中间环节未单独展开。图中箭头延续 DESIGN 的主要请求、消息和任务处理关系。

## 回调通道并列版

将两种环境展开成左右两个视图；两边的 ESA 与 Nuxt 节点分别代表对应环境的实例。此图仅比较授权回调，不重复其余存储、消息及业务请求关系。

```mermaid
---
config:
  theme: neutral
  themeVariables:
    fontFamily: 'Microsoft YaHei, sans-serif'
    fontSize: '14px'
  block:
    padding: 24
---
block-beta
  columns 2

  block:Production
    columns 1
    ProdTitle["生产环境授权回调"]
    ProdEdge["ESA 边缘函数"]
    space
    ProdProxy["容器反向代理"]
    space
    space
    space
    ProdApp["Nuxt 应用进程"]
  end

  block:Development
    columns 1
    DevTitle["开发环境授权回调"]
    DevEdge["ESA 边缘函数"]
    space
    Tunnel["FRP 隧道"]
    space
    LocalProxy["本机专用代理"]
    space
    DevApp["Nuxt 应用进程"]
  end

  ProdEdge --> ProdProxy
  ProdProxy --> ProdApp
  DevEdge -.-> Tunnel
  Tunnel -.-> LocalProxy
  LocalProxy -.-> DevApp

  style Production fill:#f8fafc,stroke:#94a3b8
  style Development fill:#f8fafc,stroke:#888,stroke-width:1px,stroke-dasharray:5 5
  style ProdTitle fill:transparent,stroke:none
  style DevTitle fill:transparent,stroke:none
```

两条链路均为 ESA 发起的授权确认请求，通道按环境选择；响应按请求链路返回。本机专用代理只放行授权接口，公网 HTTPS 入口等中间环节与总览版一样省略。

## 布局约定

- `columns` 与 `space` 控制节点所处的行列；生产入口与开发回调通道占据同一行的左右两列。
- 组内标题仅作视觉标签，不表示独立的服务。
- 修改节点文案仍可能改变列宽与行高；固定行列不等于固定像素坐标，连线与标签需要一并检查。

## 试排结论

`block-beta` 可以稳定表达左右并列，回调通道的局部图效果较好。完整总览包含多条跨区连线，当前本地渲染器会以直线穿过中间节点；固定网格没有解决这部分可读性问题。

因此，这份试稿支持将局部对比图作为补充，但不足以证明整个主图适合改为 `block-beta`。若要求一张图同时保留全部关系、固定布局并控制折线路径，应考虑可手工布线的绘图工具。
