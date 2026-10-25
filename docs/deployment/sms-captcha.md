# 号码认证短信与图形验证

当前接入阿里云号码认证服务（DYPNS/PNVS）的 `SendSmsVerifyCode` 和 `CheckSmsVerifyCode`，不是传统 Dysms `SendSms` 接口。图形验证也使用 PNVS 集成的 `captcha.alicaptcha.com` 协议。不要用另一个验证码产品的 appId、密钥或 SDK 配置直接替换。

入口：[SMS](../../server/lib/sms.ts)、[CAPTCHA](../../server/lib/captcha.ts)、[共享配置](../../config/shared.yaml)、[鉴权业务](../modules/accounts.md)。

## 短信开通与配置

1. 在号码认证服务开通短信认证，核对当前账号可用的签名、模板和方案。
2. 给独立 RAM 身份绑定 [短信策略 JSON](../../config/ram/stupig-sms-access.json)，填入 `ALIYUN_DYPNS_ACCESS_KEY_ID/SECRET`；创建步骤见 [RAM 清单](ram.md)。策略只含 `dypns:SendSmsVerifyCode` 与 `dypns:CheckSmsVerifyCode`，两项 API 使用 `Resource: "*"`，不配置模板资源 ARN。
3. 在 `aliyun.sms` 填写 `signName`、`templateCode`、`schemeName`；发送与核验必须使用同一 scheme。模板需支持项目传入的 `code: ##code##` 和有效分钟数 `min`。
4. 核对 `aliyun.dypns.regionId` 和 endpoint。当前 shared 为 `cn-hongkong` 与 `dypnsapi.aliyuncs.com`，迁入其他账号时以所开通服务的可用接入点核验。
5. 生产使用受控号码测试发送、正确核验、错误/过期核验，以及应用的发送冷却与频率限制。

参数和权限依据：[SendSmsVerifyCode](https://help.aliyun.com/en/pnvs/developer-reference/api-dypnsapi-2017-05-25-sendsmsverifycode)、[CheckSmsVerifyCode](https://help.aliyun.com/en/pnvs/developer-reference/api-dypnsapi-2017-05-25-checksmsverifycode)。当前代码要求响应 success 且 code=OK；核验还必须得到 `Model.VerifyResult=PASS`。

## 图形验证开通与配置

在同一产品的图形验证配置中核对站点/应用和允许的访问域名，取得 appId/appKey。appId 配在 `aliyun.captcha.appId` 并下发浏览器；appKey 从 `ALIYUN_DYPNS_CAPTCHA_APP_KEY` 注入，仅供服务端使用。

浏览器提交 `lot_number`、`captcha_output`、`pass_token`、`gen_time`，服务端以 appKey 对 lot_number 做 HMAC-SHA256，向 `https://captcha.alicaptcha.com/validate` 二次核验。协议见 [PNVS 服务端集成](https://help.aliyun.com/en/pnvs/developer-reference/graphical-authentication-server-integration)。当前控制台实际域名白名单本轮未读取，迁移域名后必须用新页面真实完成一次验证。

现行故障行为需要明确：字段缺失会拒绝，服务返回非 success 会拒绝；网络异常、HTTP 非 2xx 或 JSON 解析失败落入 catch 后会放行（fail-open）。这是当前代码的业务选择，不应在部署说明中误写为任何故障均拒绝。若要改为失败关闭，应作为业务行为变更单独实现与验收。

## 开发与生产开关

| 项目 | 开发 | 生产 |
| --- | --- | --- |
| `NUXT_OTP_DEBUG` | 默认 true，跳过真实短信发送/核验 | 必须 false |
| `NUXT_CAPTCHA_DEBUG` | 默认 true，跳过图形验证 | 必须 false |

生产 loader 对任一 debug 开启均拒绝启动，不能把开发 `.env.dev` 直接部署。开发测试账号手机号不能用于真实短信：在任何发送流程前确认运行中配置为 OTP debug，或改用密码登录/已有会话。

短信发送失败先区分 RAM 拒绝、未开通产品、签名/模板不匹配、额度/频控及网络；不要把 OSS 或 ESA 的 AccessKey 填进短信凭据来试错。服务成本和限额以当前账号控制台为准，本仓库没有自动设置短信套餐或消费上限。
