# dsh-drop-to-path — 升级适配指南

本插件依赖 DSH 若干**未公开的内部接口**。DSH 升级(或插件本身被重新安装/覆盖)后可能失效。本文记录:依赖哪些接口、失效症状、如何定位、如何修复。

> 维护约定:每次成功适配后,在文末「适配记录」追加一行(DSH 版本 / 日期 / 改动)。排查问题从「失效症状」表开始。

## 1. 依赖的内部接口清单

### 1.1 浏览器侧(`lib/client.js`)

| 接口 | 位置 | 用途 | 失效信号 |
|---|---|---|---|
| 客户端插件加载格式 `window.__ModuleLoader__.load({ id, factory })` | DSH 客户端运行时(所有 client bundle) | 插件入口 | 插件完全不加载(F12 无 `[drop-to-path]` 日志) |
| 插件对象 `exports.apply(ctx)`、`exports.inject = []` | cordis 客户端 | 生命周期与依赖注入 | apply 未执行 / `ctx.conversation` 为 undefined |
| `conversation` 服务(root 单例,scope-addressed) | `@deepseek-ai/dsh-client-ui-conversation` | 注入目标 | 注入失败 |
| `conversation.sendSession(session, text, attachmentIds, mode, signal, accept?)`(原型方法) | 同上 | **包装点**:图片+文件发送入口(prototype 级包装,实例重建不失效)。第 6 参 `accept` 必须在宿主接收的瞬间被调用(结算 composer 草稿区),包装器必须透传 | 发送后仍报 `attachment-error`;或草稿区/附件不随发送结算 |
| `conversation.resolveDraftAttachments(ids)` | 同上 | 由草稿附件 id 取描述符(`{ id, kind, file }`,image 与 file 都带 `file: File`) | 附件取不到 |
| `conversation.releaseDraftAttachment(s)(...)` | 同上 | 发送成功后释放附件预览 | 附件残留 |
| `conversation.fileUploads`(SnapshotStore) | 同上 | **0.2.2 新增**:进框即上传的每份草稿上传状态(`uploading`/`ready`/`error`,`error` 带 `reason` 表示宿主拒收);error 会让 composer 拒绝发送,插件据此救援 | 被拒收的图片卡住发送 |
| `session.projections.faceOf('modelSelection')` | `@deepseek-ai/dsh-api-session-controller` | 取当前模型选择(`next ?? lastUsed`) | 多模态模型被误转路径 |
| `remote.session.modelCatalog()`(返回 `{ ok, value }`) | `@deepseek-ai/dsh-api-gateway` | 部署默认模型(新会话兜底) | 新会话判定 `unresolved` |
| `sessions.list.getSnapshot().byId[id].cwd` | `@deepseek-ai/dsh-api-session-controller` | **0.2.2 唯一可用的会话 cwd 来源**(`SessionListState` 已无 `current`;`retainInfo` 只剩引用计数) | 上传落到"最近更新的工作区" |
| `slots.inject(key, cb)` + `slots.register(options, Component)` | `@deepseek-ai/dsh-client-ui-renderer` | 隐藏 dock 入口:捕获 session 作用域的 `sessionId` 与 `inputActions`(两参注册,`options` 里不再有 `component`) | dock 未出现在 live 槽位树 / 上传救援失效 |
| document 级 `drop` / `paste` 事件(capture 阶段拦截) | 浏览器 DOM | 拦截含目录的拖放/粘贴 | 文件夹拖入无方块生成 |
| `window` 级 `dragend` 事件(DSH 监听并重置拖拽蒙版) | `@deepseek-ai/dsh-client-ui-attachment` | 派发合成 `dragend` 关闭全屏蒙版 | 拖入文件后蒙版残留、页面卡住 |
| `globalThis.__DSH_HOST_PATHS__`(Desktop bridge) | Desktop shell | 存在即说明 composer 会原生把目录转成 `@folder/` 引用,插件必须放行 | 桌面端重复上传整目录 |
| 输入区 `[data-composer-card]` / `[data-input-scroll]` | DSH 输入区 DOM | 方块标签插入位置(两者仍是直接父子关系) | 方块出现在错误位置 |
| 图片缩略图 `img[src^="blob:"]` | DSH 附件栏 DOM | **实时测量**缩略图尺寸,方块 1:1 对齐 | 方块尺寸与图片不一致 |

### 1.2 宿主侧(`lib/index.js`)

| 接口 | 位置 | 用途 | 失效信号 |
|---|---|---|---|
| `webServer` 服务 + `register({ kind: 'exact'\|'prefix', path, handler })` | `@deepseek-ai/dsh-host-webserver` | 挂载导入路由 | `GET /_dsh/drop-to-path/import` 返回 HTML(SPA 兜底)而非 405 JSON |
| `ctx.inject(['webServer'], cb)` | cordis 宿主 | 等待 webServer 可用 | 路由从未注册 |
| `workspaceRegistry` 服务(`list()` → `id/path/title/createdAt/updatedAt`) | `@deepseek-ai/dsh-workspace` | **首选**工作区注册表;`resolveByPath()` 亦可用于校验 | 上传返回 500 `no workspace registered` |
| `$DSH_HOME/storages/workspace.json`(`tables.workspaces.<id>.path / .updatedAt`) | `@deepseek-ai/dsh-workspace` 持久化 | 回退路径(无 `workspaceRegistry` 服务时)。注意 0.2.2 已包上 `{ unit, global, tables }` 的 v2 单元信封 | 上传返回 500 `cannot read workspace registry` |
| `llm` 服务 `resolveModelInfo(provider, model)` → `inputModalities` | `@deepseek-ai/dsh-llm` | `?modalities=` 预检,与 prompt 准入同规则 | 纯文本模型判定异常 |

### 1.3 宿主侧(了解即可,不直接依赖)

| 接口 | 位置 | 说明 |
|---|---|---|
| 图片准入预检 `attachment-error` / `MODEL_DOES_NOT_SUPPORT_IMAGES` | `@deepseek-ai/dsh-host-apiproxy` 的 `prompt` handler(`modelInfo.inputModalities` 不含 `image` 即拒绝) | 本插件绕过的就是它。若 DSH 未来把"不支持图片→自动降级/转换"做成内置能力,本插件可整体退役 |

## 2. 失效症状 → 定位 → 修复

| 症状 | 可能原因 | 定位 | 修复 |
|---|---|---|---|
| 发送后仍弹「当前模型不支持图片」 | `sendSession` 包装未生效 | F12 控制台:是否有 `[drop-to-path]` 报错;`conversation` 服务名或 `sendSession` 签名/调用路径变了 | 用 `__ModuleLoader__` 环境里 `console.log(Object.keys(ctx.conversation))` 核对方法;同步改 `client.js` 的包装点 |
| `GET /_dsh/drop-to-path/import` 返回 `<!doctype html>`(200) | 路由未注册 | 见上表 1.2 第一行 | 核对 `webServer` 服务名与 `register` 契约(**历史坑**:rc.6 之前/某些版本该服务曾叫 `httpServer`,见适配记录 #1) |
| 拖图发送后消息为空/无反应 | 转发时丢了原生签名参数 | 看会话消息流与 F12 | 核对 `sendSession` 当前参数(0.2.2 为 6 参,末位 `accept`);包装器统一走 `forward()` 透传 |
| 上传报 500 `cannot read workspace registry` | 存储格式或路径变化 | 打开 `$DSH_HOME/storages/workspace.json` 目视核对;或直接 `ctx.get('workspaceRegistry').list()` | 优先用 `workspaceRegistry` 服务;文件解析只作回退 |
| **文件写进了别的工作区**(agent 说找不到) | 客户端没带上工作区线索,host 回退到"最近更新的注册根" | beacon `drop`/`paste` 之后看上传返回的 path;`sessions.list.byId[id].cwd` 是否为空 | 0.2.2 起 `SessionListState` 无 `current`、`retainInfo` 无 `cwd`:确认 dock 槽位已捕获 `sessionId`(live 槽位树应有 `dsh-drop-to-path-dock`) |
| **图片上传失败后怎么都发不出去**(Enter 只弹 toast) | 0.2.2 的 `uploadsPending`(含 error)拦截发送 | F12 看 `conversation.fileUploads` 该 id 是否为 `error`(带 `reason` = 宿主拒收) | 插件的上传救援应把它转成 `.drops` chip 并摘掉草稿;若没有,查 `fileUploads.subscribe` 与 `inputActions.removeAttachment` |
| 插件完全无效果且无日志 | client bundle 未被宿主发现 | 重启后页面源码 `window.__DSH_BOOT__.entries` 是否含 `dsh-drop-to-path` | 核对 `package.json` 的 `dsh.client` 声明、`exports['./client']`、`cordis.patch.yml` 挂载行 |
| 拖入文件后**全屏蒙版残留**、页面卡住 | `dragend` 派发未生效或 DSH 不再监听 window `dragend` | F12 Console 看 `[drop-to-path]` 日志;`dsh-client-ui-attachment` 里找蒙版重置逻辑 | 更新 `client.js` 的蒙版关闭方式(当前:派发合成 `DragEvent('dragend')`) |
| 方块标签出现在错误位置/与图片不并排 | `[data-composer-card]` / `[data-input-scroll]` 不再是直接父子 | F12 检查两者关系与 display | 更新 `findCard()`/`findScroll()` 与插入点 |
| 方块尺寸与图片缩略图不一致 | 缩略图选择器 `img[src^="blob:"]` 失效或尺寸测量逻辑变化 | F12 看缩略图是否仍为 blob URL | 更新 `thumbnailSize()` |
| 桌面端重复上传整个文件夹 | `globalThis.__DSH_HOST_PATHS__` 检测失效,插件抢了原生目录引用 | Desktop 控制台看 `__DSH_HOST_PATHS__` 是否存在 | 修 `hasHostPathBridge()`,或直接删掉文件夹流 |

## 3. 验证清单(适配后必跑)

0. 离线回归:`node test-route.mjs && node test-workspace.mjs && node test-client.mjs`(host 路由与 client 包装的行为断言,不需要起服务);
1. 重启 Web profile(host 半改动必须;client 半刷新页面即可);
2. `curl -i http://127.0.0.1:8099/_dsh/drop-to-path/import` → 期望 `405` + JSON(`{"ok":false,...}`),**不是** HTML;
3. 浏览器 F12 → Network:粘贴图片后点发送,应看到一次 `POST /_dsh/drop-to-path/import`(200 JSON `{ok:true,value:{path}}`);
4. 会话消息流:发出的消息是**文本路径**(`D:\...\.drops\...`),无图片附件卡片;
5. F12 Console / `.beacon.log`:应看到 `deferred-install {patch:true, dock:true, rescue:true}`;
6. 拖入文件夹(Web 端)→ 上传返回的 path 必须在本会话工作区,不是"最近打开的工作区";
7. agent 回复应能描述图片内容(配合 dsh-vision-toolkit)。

> 激活方式:host 半(`lib/index.js`)只在 `dsh web` 启动时加载,必须重启;client 半(`lib/client.js`)由 clientModules 按请求下发,刷新页面即生效。

## 4. 适配记录

| # | 日期 | DSH 版本 | 改动 |
|---|---|---|---|
| 1 | 2026-08-14 | 0.1.0-rc.6 | 初版。注:本环境同时给 `dsh-vision-toolkit` v0.1.2 打过 `httpServer` → `webServer` 补丁(其 `lib/web.js` 与 `src/web.ts`);若该插件也失效,检查此补丁是否被覆盖 |
| 2 | 2026-08-14 | 0.1.0-rc.6 | 合并 PR #2(感谢 @SPYQWER1):`workspaceRoot()` 增加 `~/.dsh` 回退(不再强制 DSH_HOME);导入路由接受可选 `workspace` 字段(仅绝对路径受信任,否则回退注册表扫描);client 通过 `sessions` 服务解析活动会话 cwd 并随上传携带 |
| 3 | 2026-08-14 | 0.1.0-rc.6 | 合并 PR #4(感谢 @SPYQWER1):`peerDependenciesMeta` 将 `@deepseek-ai/cordis` 标记为 optional peer,消除 DSH profile(`autoInstallPeers: false`)安装时的 missing peer 告警;运行时无变化 |
| 4 | 2026-10-02 | 0.2.0-rc.2 | **大版本适配 + 多模态识别**(0.3.0–0.3.3):① `sendSession` 签名变为 `(session, text, attachmentIds, mode, signal)`,`draftImages`/`releaseDraftImages` 已删除,改用 `resolveDraftAttachments()`/`releaseDraftAttachment(s)()`;旧包装因此对每次带图发送都回退原生路径,纯文本模型重新被拒。② 转换后的消息改经**原生 sendSession** 发送(`beginSubmission`/本地回显/附件退休全保留),不再直接调 `session.prompt`。③ 新增多模态识别:client 以 `modelSelection` projection(→ 默认 `remote.session.modelCatalog().default`)解析当前模型,host 新增 `GET ?modalities=1&provider=&model=`(经 `llm.resolveModelInfo`,与 prompt 准入同规则)回答;多模态直传、纯文本转路径、失败兜底转路径,结果按模型缓存,`model-check` beacon 记录判定。④ 服务惰性解析(liveCtx):当前 DSH 在应用服务挂载前加载本模块。⑤ `sessions.list` 已不存在,工作区解析改 `retainInfo` 探测 + host 注册表回退。 |
| 5 | 2026-10-02 | 0.3.4 | **修正 catalogDefault 解包**:当前 DSH 的 `remote.session.modelCatalog()` 解析为 **Remote 响应包装** `{ ok, value }`,目录本体(含 `.default`)在 `value` 下。0.3.3 直接在包装上读 `.default` 恒为空 → 全新会话(未碰过选择器、`modelSelection` 的 `next`/`lastUsed` 皆空)判定 `unresolved`,多模态模型(如 glm-5.3-flash)图片被错转纯文本;用户一旦碰过选择器(如切档位)`next` 被填上才恢复直传——「default 当纯文本、max 正常」实为此 bug 的假象,多模态与思考档位无关(`sendSession` 的 `mode` 参数是 queue/steer 投递,亦与此无关)。修复:解包 `response.value` 再读 `.default`(兼容裸目录);`reasoningEffort` 仅进 `model-check` beacon 作诊断。 |
| 6 | 2026-10-02 | 0.3.5 | **@ 引用 token**:`dsh-file-reference` 的共享 @file 语法——`@path` / 含空格 `@"path"`、尾斜杠标记目录——已写入 agent 指令(`FILE_REFERENCE_PROMPT`),模型侧按显式引用处理。转换输出(图片+文件+文件夹 chips)统一经 `atToken()` 格式化,文件夹 chip 补 `/` 目录标记。 |
| 7 | 2026-10-02 | 0.3.6 | **审计第一批**（安全+数据丢失+超时）:① host 整路由前置 `requestAuthorized`(回环 Host + Origin 同源,防 DNS rebinding 与跨站 no-cors POST),POST 强制 `application/json`(415 否则),写根 `resolveRoot()` 只在注册工作区根中选择,`?file=` 限注册根 + `Cross-Origin-Resource-Policy: same-origin`,beacon 日志 512KB 截断。② client:入队统一 `trackEnqueue` 链,`sendSession` 入口有界等待(≤30s)结算再快照;成功后 `removeFilesByPaths` 只清快照路径;五处 fetch 全部 `fetchWithTimeout`(8s/5s/120s/8s/20s)。③ 新增 `test-route.mjs` 鉴权断言。 |
| 8 | 2026-10-05 | 0.3.7 | **发布规范补全**：按 `cordis-plugin-development` 技能与 `dsh-package-manifest` 声明补 `locale/en.json`+`zh.json`(meta.title/description,免激活展示)、`dsh.manifestVersion: 1`、`engines.dsh: ">=0.2.0-rc.2"`(本机装的是 0.2.0-rc.2),exports/files 相应纳入 locale;icon 缺省(规范允许)。host 导出形态 `apply(ctx)`、bundle patch(id+name 行)、client `dsh.client`(platform/inject)与 `./client` 导出均已合规,未动。 |
| 9 | 2026-10-09 | 0.4.0 | **行为收敛**：当前 DSH 作曲器原生支持文件草稿(`sendSession` 序列化 `type:"file"`+`receiptId`),散文件拖入/粘贴不再拦截(原 onDrop/onPaste 的 `others` 拦截分支删除,beacon 改 `drop-native`/`paste-native-files`);唯一转换 = 发送时纯文本模型的草稿图片(`modelAcceptsImages` 判定不变)。文件夹流保留(无原生管道)。剪贴板救援(直读/CF_BITMAP host 提取)改为合成纯图 drop 送原生栏,失败才落 chip——`hostClipboardFallback` 经 `?file=` 回取 PNG blob 再 `redispatchImages`。README/locale/package description 同步改写。 |
| 10 | 2026-11-06 | 0.2.2-rc.1 | **升级适配(0.4.1)**:① `sendSession` 加第 6 参 `accept`(宿主接收瞬间结算 composer),包装器统一 `forward()` 透传。② 会话身份来源变了:`sessions.list` 无 `current`、`retainInfo()` 无 `cwd` → 隐藏 dock 槽位捕获 `sessionId`/`inputActions`,工作区改读 `sessions.list.byId[id].cwd`;否则文件夹上传落到"最近更新的注册根"。③ 图片"进框即上传"(`fileUploads` + `uploadsPending` 门禁):被宿主拒收(`status:"error"` 且带 `reason`)的图片会永久堵住发送,新增救援——转 `.drops` chip 并 `inputActions.removeAttachment`(可重试的普通失败不抢)。④ 图片上限对齐 Host 默认 50 MiB(原 30 MiB)。⑤ 桌面端 `__DSH_HOST_PATHS__` 存在时目录拖放交还原生(`@folder/` 引用 chip),Web 端保留递归上传。⑥ host 注册表改读 `workspaceRegistry.list()`,文件解析只作回退;写入根保留注册根内的子目录(worktree 会话)。⑦ 隐藏槽位改两参 `register(options, Component)` 并由统一轮询延迟安装(apply 时 slots 尚未挂载)。新增 `test-workspace.mjs` / `test-client.mjs`。 |

## 5. 本机环境备注(调试用)

- 数据目录:`D:\DeepSeekHarness\dsh-home`(`C:\Users\<user>\.dsh` 是 junction 指向它);
- 服务器进程:`dsh web --host 127.0.0.1 --port 8099`,日志:`D:\DeepSeekHarness\dsh.log`;
- 插件安装形态:profile 的 `package.json` 用 `link:` 依赖 + `node_modules/dsh-drop-to-path` 为**目录拷贝**(pnpm 跨盘 link 退化为拷贝)——更新源码后需重新拷贝(见 README 安装方式二第 3 步)。
