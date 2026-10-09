# dsh-drop-to-path

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that turns draft images into **workspace file paths** — but only when the current model is text-only. Everything else passes through untouched.

Drop or paste images, PDFs, office documents, archives, video or audio into the composer and DSH drafts them natively, as always. At submit time the plugin checks whether the session's current model accepts image input (the exact chain prompt admission uses). A text-only model gets every draft image uploaded to `.drops/` and rewritten as an `@`-referenced **absolute path** the agent can read with its file tools; a multimodal model gets the real picture, and non-image files are never touched.

- **Images, text-only model** — uploaded at submit and replaced by `@<workspace>/.drops/xxx.png` reference tokens.
- **Everything else** — native: multimodal images go as real attachments, documents go through DSH's own file pipeline.
- **Folders** — recursive upload under `.drops/<batch>/` with one 📁 chip (no native folder pipeline exists).
- The host side registers a single exact route, `POST /_dsh/drop-to-path/import`, and performs the decode-and-write.

## Install

```sh
dsh plugin --profile web add github:gmugu/dsh-drop-to-path
```

## Usage

1. Drag files onto the composer, or paste an image from the clipboard.
2. Write your prompt and send it as usual.
3. Text-only model: the message carries workspace paths such as `<workspace>/.drops/xxx.png`. Multimodal model: the attachments go out unchanged.

## Requirements

- A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installation with the `web` profile
- `@deepseek-ai/cordis` ^4.0.1 (declared as a peer dependency)

## Third-party notices

This plugin has no third-party runtime dependencies. Everything it does is implemented against the DeepSeek Harness host and client APIs.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Community and support

- Report bugs and ask questions through [GitHub Issues](https://github.com/gmugu/dsh-drop-to-path/issues).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your own plugin repository for discoverability.
- Browse the wider ecosystem at [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Citation

```bibtex
@misc{dsh-drop-to-path,
  title={dsh-drop-to-path},
  author={gmugu},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/gmugu/dsh-drop-to-path}},
}
```

## License

[MIT](LICENSE)
