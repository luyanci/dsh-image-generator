# dsh-image-generator

DeepSeek Harness 生图插件：在设置里配置多个生图供应商 / 模型，对话里通过 `image_generate` 调用当前选中的那一个模型。

结合了官方 `@deepseek-ai/dsh-tool-image-generation`（对话生图工具）和 `dsh-plugin-subscriptions`（设置页可配置）的思路，面向 **API Key + Base URL** 的网关，而不是订阅登录。

## 功能

- **设置 → 生图配置**（左侧导航）：添加多个供应商。每个供应商有名称、Base URL、API 格式、API Key，以及一组生图模型。配置存在 profile 的 `image-gen` 插件条目里（DSH ≥ 0.1.6 为 volatile 字段、保存即热生效；≤ 0.1.5 写入 `settings.yaml` 的 `image-gen` 段），密钥走凭据服务，不进设置文件。
- **设置 → 插件 → 本插件详情 → 图形生成**（≤ 0.1.5 为 设置 → 插件 → 插件配置）：从上面配置过的模型里**只选一个**作为对话生图模型，可开关工具、设置默认尺寸 / 质量。
- **对话工具 `image_generate`**：Agent 需要出图时调用当前选中的模型；图片写到工作区 `generate/image/`，并在对话里内联显示（240px 缩略图 + Lightbox 全屏预览）。
- **图像编辑**：4 种 API 格式全部支持 `referenceImages`（1–5 张参考图）。OpenAI / xAI 格式会切到 `/images/edits`，Gemini / chat 格式把参考图一并放进请求。
- **改图方式可配**（0.2.0 起）：设置 → 插件 → 图形生成 → **改图方式**。网关对 `/images/edits` 的要求不一样，选错就一定失败，所以给成开关：
  - `auto`（默认）：先按 OpenAI 规范用 `multipart/form-data` 上传参考图，被拒再退回旧的 JSON data-url 传法；
  - `multipart`：只走标准表单上传（官方 OpenAI、按规范实现的网关）；
  - `json`：只走 0.2.0 之前的 JSON 传法（老网关已经在用就别动）；
  - `chat`：把参考图塞进 `/chat/completions`（只开放 chat 端点的网关）；
  - `off`：关掉改图，只保留纯生图。
- **中英双语界面**，无构建步骤，要求 Node >= 22.19。

## API 格式

按模型 / 网关选择，不要用聊天用的 Anthropic Messages：

| 格式 | 适用 | 请求 |
|------|------|------|
| **OpenAI Images** (`/v1/images/generations`) | `gpt-image-2`、`gpt-image-1`、DALL·E，以及兼容 OpenAI Images 的网关 | `POST {base}/images/generations`（编辑走 `/images/edits`），`response_format: b64_json`；网关拒绝该参数时自动去掉重试一次 |
| **xAI Images** (`/v1/images/generations`) | `grok-imagine-image-2.0` | 同上路径，但用 `aspect_ratio`；`quality` 按 xAI 能力映射（`high`→`medium`，`auto` 不下发） |
| **Gemini / Imagen** | `gemini-*-image`、`imagen-*` | 按模型名自动分流：`imagen-*` 走 `:predict`，其余走 `:generateContent`；官方 host 自动换 `x-goog-api-key` 头 |
| **OpenAI Chat Completions** | 在 chat 响应里返回图片的聚合网关 | `POST {base}/chat/completions` |

Base URL 填到 `/v1`（或 Gemini 的 `/v1beta`）这一层，插件会补上后面的路径。例如：

- OpenAI：`https://api.openai.com/v1`
- xAI：`https://api.x.ai/v1`
- Gemini 官方：`https://generativelanguage.googleapis.com/v1beta`
- 本地网关：`http://127.0.0.1:8317/v1`

API Key 通过凭据服务存储，环境变量名按 `IMAGE_GEN_<供应商ID大写>_API_KEY` 规则引用，不会写进设置文件。

## 安装

npm：

```sh
dsh plugin --profile <name> add dsh-image-generator
```

> [!WARNING]
> 0.2.0 把包名从 `dsh-image-generation` 改成了 `dsh-image-generator`（同时把 client 的 `__ModuleLoader__` id 一起改了，两者必须一致否则 DSH 拒绝启动）。**从旧包升级要先卸载**：
>
> ```sh
> dsh plugin --profile <name> remove dsh-image-generation
> dsh plugin --profile <name> add github:luyanci/dsh-image-generator
> ```
>
> 两个包会注册同名的 `image_generate` 工具，不要同时安装。

GitHub：

```sh
dsh plugin --profile <name> add github:luyanci/dsh-image-generator
```

本地检出：

```sh
dsh plugin --profile <name> add /绝对路径/dsh-image-generator
```

> [!IMPORTANT]
> DSH 在进程**启动时**组合插件。先启动再安装时，必须完全退出并重新打开 DSH（不是刷新页面）。

装完后可用：

```sh
dsh --profile <name> --dump-config | grep image-gen
```

## 使用

1. 打开 **设置 → 生图配置**，添加供应商和模型，填 Base URL / API 格式 / API Key，点保存。
2. 打开 **设置 → 插件 → 插件配置**，展开 **图形生成**，选择刚才配置的某一个模型并保存。
3. 在对话里让 Agent 生图，它会调用 `image_generate`。

可选参数：`prompt`（必填）、`size`（`1024x1024` / `1024x1536` / `1536x1024` / `auto`）、`quality`（`low` / `medium` / `high` / `auto`）、`referenceImages`（1–5 张已有图片引用，用于编辑；本地文件先 `read_image`）。

## 配置项默认值

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `enabled` | `true` | 是否启用 `image_generate` 工具（关闭时工具仍注册，调用会被拒绝） |
| `providerId` / `modelId` | 空 | 当前选中的生图供应商与模型 |
| `defaultSize` | `1024x1024` | 工具未显式传 `size` 时的默认尺寸 |
| `defaultQuality` | `auto` | 工具未显式传 `quality` 时的默认质量 |
| `editFormat` | `auto` | 改图的传输方式：`auto` / `multipart` / `json` / `chat` / `off` |
| `apiFormat`（供应商级） | `openai-images` | 新建供应商时的默认 API 格式 |

## 来源

本仓库是 [whiteS18/dsh-image-generation](https://github.com/whiteS18/dsh-image-generation) 的 fork（起点 `0.1.3`），改动集中在一件自有需求上：**让改图能按网关的实际要求发送**。原版对 OpenAI / xAI 格式一律只发 JSON 体（`images: [{ image_url }]`），而按 OpenAI 规范实现 `/images/edits` 的网关只吃 `multipart/form-data`，于是改图恒定失败、生图却正常。0.2.0 加了 `editFormat` 配置项并实现了标准表单上传，`auto` 保留旧路径作为回退。

## 与现有插件的关系

- 官方 `@deepseek-ai/dsh-tool-image-generation` 只有工具、没有设置页；本插件自带设置页，一般不必再装官方包。
- 上游 `whiteS18/dsh-image-generation` 仍然可用；两个包会注册同名 `image_generate` 工具，同时安装会抢同一个工具名。
- `dsh-plugin-subscriptions` 走的是 ChatGPT / Grok **订阅登录**，也会注册名为 `image_generate` 的工具。两边同时安装可能抢同一个工具名。需要 API 网关生图时用本插件；需要订阅生图时用 subscriptions。

## 卸载

```sh
dsh plugin --profile <name> remove dsh-image-generator
```

---

## English

Image-generation plugin for DeepSeek Harness. Configure providers and models under **Settings → Image generation**, pick exactly one model on the plugin detail page (**Settings → Plugins → this plugin → Image generation**; on DSH ≤ 0.1.5: Settings → Plugins → Plugin configuration), then conversations call `image_generate` with that model.

All four API formats (OpenAI Images, xAI Images, Gemini/Imagen, OpenAI chat-completions gateways) support image editing via `referenceImages` (1–5 images). API keys are stored through the credentials service. Generated files land in `generate/image/` of the session workspace and are shown inline in the conversation. Chinese and English UI. Requires Node >= 22.19.

Install:

```sh
dsh plugin --profile <name> add dsh-image-generator
```

`0.2.0` renames the package to `dsh-image-generator` and the client factory id with it, so upgrading from `dsh-image-generation` needs a remove first:

```sh
dsh plugin --profile <name> remove dsh-image-generation
dsh plugin --profile <name> add github:luyanci/dsh-image-generator
```

`editFormat` (Settings → Plugins → Image generation → Edit method) picks how reference images travel: `auto` (multipart first, legacy JSON as fallback), `multipart`, `json`, `chat`, or `off`.
