# dsh-drop-to-path

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：**仅当当前模型是纯文本时**，才把草稿图片转成**工作区文件路径**；其余情况一律放行原生。

把图片、PDF、Office 文档、压缩包、视频或音频拖入输入框（或直接粘贴），DSH 照常原生建草稿。发送时插件按 prompt 准入同款判定链检查当前模型是否接受图片：纯文本模型的每张草稿图片会上传到 `.drops/` 并改写为模型可读取的 `@` 引用**绝对路径**；多模态模型收到真图，非图片文件永远不被碰。

- **图片 + 纯文本模型** — 发送时上传，替换为 `@<workspace>/.drops/xxx.png` 引用 token。
- **其余一切** — 原生：多模态图片走真实附件，文档走 DSH 自己的文件管道。
- **文件夹** — 递归上传到 `.drops/<batch>/`，附件栏一枚 📁 chip（无原生文件夹管道）。
- host 侧只注册一条精确路由 `POST /_dsh/drop-to-path/import`，负责解码与落盘。

## 安装

```sh
dsh plugin --profile web add github:gmugu/dsh-drop-to-path
```

## 使用

1. 把文件拖到输入框上，或从剪贴板直接粘贴图片。
2. 正常写提示词并发送。
3. 纯文本模型：消息携带 `<workspace>/.drops/xxx.png` 这样的路径。多模态模型：附件原样发出。

## 环境要求

- 已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，并使用 `web` profile
- `@deepseek-ai/cordis` ^4.0.1（已声明为 peer 依赖）

## 第三方声明

本插件没有任何第三方运行时依赖，全部实现基于 DeepSeek Harness 的 host 与 client API。

See [THIRD_PARTY_NOTICES.zh.md](THIRD_PARTY_NOTICES.zh.md).

## 社区与支持

- Report bugs and ask questions through [GitHub Issues](https://github.com/gmugu/dsh-drop-to-path/issues).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your own plugin repository for discoverability.
- Browse the wider ecosystem at [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com).

## 参与贡献

See [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md).

## 引用

```bibtex
@misc{dsh-drop-to-path,
  title={dsh-drop-to-path},
  author={gmugu},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/gmugu/dsh-drop-to-path}},
}
```

## 许可证

[MIT](LICENSE)
