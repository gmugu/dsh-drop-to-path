# Changelog

本项目的所有重要变更都会记录在此文件。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.4.0] - 2026-10-09

**行为收敛：只保留"纯文本模型 × 图片"的转路径，其余一律放行原生**。当前 DSH 作曲器已原生支持图片与文档双草稿管道,插件不再拦截散文件。

### Changed

- **散文件拖入/粘贴不再拦截**（PDF/Office/压缩包/音视频/混合一律放行）——DSH 原生建草稿;原"文件 chips"机制仅保留给无原生通路的场景;
- **剪贴板救援路径改走原生优先**：直读(Ctrl+V 无 paste 事件)与 host 位图提取(CF_BITMAP)得到的图片,先以合成纯图 drop 送原生附件栏(发送时按模型判定);仅当合成 drop 失败才落路径 chip 兜底,图片不再必然变路径;
- README(中英)、package.json description、locale 展示元数据同步改写。

### Unchanged

- **核心不变**：发送时判定当前模型(选择器 → 上次使用 → 部署默认,与 prompt 准入同链),纯文本模型把草稿图片上传 `.drops/` 并以 `@` 引用 token 改写消息;多模态模型原生直传;
- **文件夹拖入/粘贴保留**：目录条目无原生管道,仍递归上传 + 📁 chip + 根路径随行。

## [0.3.7] - 2026-10-05

**按 DSH 插件规范补全发布元数据**（发布至 GitHub 的可安装组合包）。依据 `dsh-agent-preset` 的 `cordis-plugin-development` 技能（`references/host-plugin.md`、`references/ui-plugin.md`）与 `@deepseek-ai/dsh-package-manifest` 类型声明。

### Added

- **locale 展示元数据**：新增 `locale/en.json` 与 `locale/zh.json`（`meta.title`/`meta.description`）——Plugin Manager 卡片、组合包详情、组件行与设置页在**不激活插件**的情况下读取;`exports` 增加 `./locale/*.json`,`files` 纳入 `locale/*.json`;
- **manifest 声明**：`dsh.manifestVersion: 1`（格式标识,声明性）;
- **兼容性声明**：`engines.dsh: ">=0.2.0-rc.2"`（当前适配的客户端附件 API 自该版本起;声明性,安装器与加载器当前不强制）;
- icon 按需求跳过——规范允许缺省,面板回退默认插画。

### Fixed

- **发布包不再携带运行时日志**：npm 的 `files` 白名单优先级高于 `.npmignore`,整目录 `"lib"` 会把 `lib/.beacon.log`（159.7kB,含模型名/工作区路径等诊断信息）打进 tarball;改为显式四文件清单（index.js/client.js/两个 ps1）,`npm pack --dry-run` 复核 12 文件、33.8kB、零运行时产物。

## [0.3.6] - 2026-10-02

**审计第一批修复：路由安全加固 + 发送路径数据丢失 + fetch 超时**（两轮审计合并后按用户选定范围执行）。

### Security

- **本地源鉴权（CSRF 关闭）**：整条路由前置 `requestAuthorized` —— Host 必须是回环地址（阻断 DNS rebinding），浏览器带 Origin 时必须与 Host 同源（阻断其它页面 `no-cors` 跨站 POST/GET；此前 `text/plain` no-cors POST 可绕过 preflight 写任意绝对路径 `.drops`）;
- **写入仅收 JSON**：POST 必须 `application/json`（该 Content-Type 强制 preflight,跨站伪造过不去）,否则 415;
- **写根圈定**：客户端 `workspace` 字段只用于在**已注册工作区根**中选择（等于或位于其中之一才生效）,任意绝对路径不再受信任;未命中回退最新注册根 —— 任意位置种植文件关闭;
- **`?file=` 收紧**：仅服务注册工作区根内的 `.drops` 图片,响应加 `Cross-Origin-Resource-Policy: same-origin`,其它页面连 `<img>` 内嵌都不再可行;
- **beacon 日志限额**：超 512KB 截断,跨站灌盘上限受控。

### Fixed

- **发送期间上传在途的文件不再无声缺席**：每次入队（文件/文件夹）纳入统一链,`sendSession` 先有界等待（≤30s）链结算再快照队列;超时则提示「仍有文件在上传」并按当前队列发送（beacon `send-settle-timeout`）;
- **成功发送不再清空整个队列**：只移除本次快照内的路径（`removeFilesByPaths`）,发送途中用户新加的 chips 留给下一条消息;
- **所有 fetch 加超时**：beacon 8s / 模态探测 5s / 上传 120s / 剪贴板探测 8s / 位图提取 20s —— host 停滞不再永久挂起发送。

### Added

- `test-route.mjs`：鉴权与 Content-Type 门离线断言（14 例全过）。

## [0.3.5] - 2026-10-02

**转换路径升级为显式文件引用（@ 语法）**。与 `dsh-file-reference` 的共享 `@file` 语法及 agent 指令（「@ 前缀的 token 是用户显式引用的路径」）对齐,转换后的路径不再以裸字符串送达模型。

### Added

- **@ 引用 token**：图片转换、文件 chips、文件夹 chips 的路径统一格式化为 `@D:\ws\...\.drops\xxx.png`;含空格路径采用 `@"..."` 引号形态;文件夹 chip 追加目录标记 `/`（同语法「尾斜杠标记目录」）。多模态模型直传图片时,同消息携带的文件 chips 同样升级。

## [0.3.4] - 2026-10-02

**修复全新会话下多模态模型被错当纯文本**。此前只要用户没碰过模型/档位选择器（全新会话停在默认档），`modelSelection` projection 的 `next`/`lastUsed` 均为空,判定链落到部署默认模型兜底——而 `catalogDefault()` 直接在 `remote.session.modelCatalog()` 的 **Remote 响应包装** `{ ok, value }` 上读 `.default`,恒为 undefined → `unresolved` → 多模态模型(如 glm-5.3-flash)的图片被错转成纯文本路径。一旦用户碰过选择器(比如切档位到 max),`next` 被填上、判定走 `selection` 臂成功——这正是「default 被当纯文本、切 max 才识别」的假象来源。多模态能力与思考档位无关。

### Fixed

- **catalogDefault 解包（核心）**：先解出 `response.value` 再读 `.default`（兼容裸目录对象）；全新会话、默认档、默认模型现在都能正确判定,多模态模型原生直传;
- `sessionModelSelection` 顺带读取 `reasoningEffort`,`model-check` beacon 增加 `effort` 字段（纯诊断用途,不影响判定）。

## [0.3.3] - 2026-10-02

**适配当前 DSH 客户端附件 API（0.2.0-rc.x）并加入多模态识别**。v0.2.6 的 `sendSession` 包装基于已移除的 `draftImages()` API,在当前 DSH 上对每次带图发送都静默回退原生路径,纯文本模型重新被 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝。

### Fixed

- **带图发送再次被拒（核心）**：包装器重写为当前签名 `sendSession(session, text, attachmentIds, mode, signal)`;草稿经 `resolveDraftAttachments()` 解析、成功后 `releaseDraftAttachment(s)()` 释放;转换后的消息通过**原生 sendSession** 发送（本地回显/host 准入/附件退休全部保留）;
- **服务惰性解析**：当前 DSH 在应用服务挂载前加载本模块,apply 时捕获的服务句柄恒为空——改为 drop/发送时经 liveCtx 现取;
- **工作区解析**：`sessions.list` 已不存在,新增 `retainInfo` 探测,失败回退 host 注册表扫描。

### Added

- **多模态识别**：转换前先问 host（`GET /_dsh/drop-to-path/import?modalities=1`,host 侧经 `llm.resolveModelInfo`,与 prompt 准入同一规则）当前模型是否接受图片输入;判定链与准入逐字一致：会话选择器当前模型 → 上次使用 → 部署默认模型（`remote.session.modelCatalog().default`）。多模态模型原生直传,纯文本模型才转路径;任何探测失败兜底转路径（消息永远发得出去）。结果按 provider/model 缓存,`model-check` beacon 记录 provider/model/source;
- 正常流程保持静默,提示条只在真正失败时出现。

### Fixed

- **pnpm 安装告警**:将 `@deepseek-ai/cordis` 声明为可选 peer(`peerDependenciesMeta`),消除 DSH profile 安装( `autoInstallPeers: false` )下的 missing peer 告警——感谢 [@SPYQWER1](https://github.com/SPYQWER1) 的 [PR #4](https://github.com/loudMore/dsh-drop-to-path/pull/4)(见 [issue #3](https://github.com/loudMore/dsh-drop-to-path/issues/3))。

## [0.1.0] - 2026-08-14

**首个正式版本**:图片与文件直达纯文本模型的完整实现,已通过自动化浏览器验证,并获得首次社区贡献(PR #2)。

### Added

- **图片**(png/jpg/jpeg/webp/gif,≤30MB):保留 DSH 原生附件体验(缩略图/预览/移除),点击发送时自动转为工作区路径;
- **非图片文件**(pdf/office/zip/视频/音频,≤100MB):附件栏方块标签(格式图标、截断文件名、hover 显示全名、✕ 移除),发送时自动附加路径;
- **混合拖入**:图片进原生附件栏、文件进方块区,同一排并排显示;
- 路径只在**点击发送时**附加,输入框保持干净;
- 上传失败显示**可见提示条**并回退原生发送,消息永不丢失;
- 支持粘贴与拖入;多文件按序上传,一次送达;
- 自动关闭 DSH 全屏拖拽蒙版(`dragend`),页面不会卡住;
- 方块尺寸**实时复用** DSH 图片缩略图尺寸(默认 62px,DSH 改版自动跟随);
- 中英双语 README(演示 GIF + 效果图)、ADAPTING.md 升级适配指南;
- GitHub 生态:`dsh-plugin` topic,已被 awesome-dsh-plugin 自动收录。

### Fixed

- **DSH_HOME 未设置时上传失败**:回退到 `~/.dsh`(与 DSH 官方 home 解析一致)——感谢 [@SPYQWER1](https://github.com/SPYQWER1) 的 [PR #2](https://github.com/loudMore/dsh-drop-to-path/pull/2);
- **多工作区下文件落到错误目录**:上传携带活动会话工作区,host 仅信任绝对路径——感谢 [@SPYQWER1](https://github.com/SPYQWER1)。
