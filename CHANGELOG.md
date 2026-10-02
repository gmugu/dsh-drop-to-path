# Changelog

本项目的所有重要变更都会记录在此文件。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
