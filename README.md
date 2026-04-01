# Codex Attention Desk

一个基于 Electron 的桌面桌宠，用来实时跟踪本机 Codex 会话状态，并在 Codex 需要你注意时主动弹出提醒。

这个仓库基于开源项目 `G-ShiSi/codex-on-desk` 做了本地定制，重点补强了 Windows + 本地 `.codex/sessions` 工作流：

- 更完整地解析本机 Codex JSONL 会话记录，而不只是粗略的开始/结束事件
- 自动识别需要人工注意的场景
  - `request_user_input`
  - Plan mode 下的提问或 `<proposed_plan>`
  - 普通模式下明显在等你回复的 assistant 问句
- 常驻本地 hook 服务
  - `POST /api/attention`
  - `POST /api/attention/clear`
  - `POST /api/open`
- 支持在提醒出现时直接运行命令来“弹出 Codex”，默认会尝试打开对应工作目录的 VS Code
- 托盘里可配置自动弹出、打开命令、手动测试提醒

## 看板预览

![Codex Attention Desk dashboard](docs/screenshots/dashboard.png)

## 功能

- 实时状态感知
  - 根据 Codex 当前会话状态驱动桌宠动画和气泡文本
- 注意力提醒
  - 当 Codex 在等你审批、等你回答 plan 问题、或发出明确追问时，桌宠会进入提醒状态
  - 可选自动运行“打开 Codex”命令
- 三种连接模式
  - `auto`：扫描 `~/.codex/sessions/**/*.jsonl`
  - `managed`：由应用自行启动 `codex app-server`
  - `external`：连接外部已有的 `codex app-server`
- 多来源聚合
  - 支持同时监听多个外部 `app-server`
  - 多个来源会聚合为单个桌宠状态
- 状态气泡
  - 可显示或隐藏
  - 支持 `简略` / `详细`
  - 支持与机器人距离数值调节
- 外观配置
  - 机器人大小 `S / M / L`
  - 主题颜色预设
  - 自定义十六进制颜色
- 交互体验
  - 透明桌面窗口
  - 支持拖拽
  - 支持双击触发互动反馈
- 本地 Hook
  - 内置 HTTP 服务默认优先监听 `http://127.0.0.1:4580`
  - 可被 PowerShell、快捷键工具、自动化脚本直接调用
- 设置持久化
  - 常用 UI 配置会保存在本地 `settings.json`
- 打包与分发
  - 支持本地打包 macOS / Windows
  - 支持 GitHub Actions 自动构建

## 快速开始

安装依赖：

```bash
npm install
```

如果你在 Windows PowerShell 里遇到 `npm.ps1` 执行策略限制，可以改用：

```bash
npm.cmd install
```

默认安装会保留 `electron` 运行时，但不再预装 `electron-builder`。
只有执行 `npm run dist` / `npm run dist:*` 时，才会按需下载固定版本的 `electron-builder`，这样能缩短日常 `npm install`。

仓库内的 `.npmrc` 已默认关闭 `audit` / `fund` / `progress`，并开启 `prefer-offline` 与更高的并发连接数。

如果是 Electron 二进制下载慢，可以在安装前临时指定镜像：

```bash
$env:ELECTRON_MIRROR="https://your-electron-mirror/electron/"
npm.cmd install
```

把 `https://your-electron-mirror/electron/` 替换成你实际可用的 Electron 镜像地址即可。

启动桌宠：

```bash
npm run electron
```

PowerShell 同理可写成：

```bash
npm.cmd run electron
```

默认行为：

- 如果没有显式配置外部地址，会优先进入 `auto` 模式
- `auto` 模式会尝试发现最近活跃的本机 Codex 会话
- 本地 hook / dashboard 服务会在应用启动时一起启动
- UI 相关设置在重启后会保留

## Hook 用法

应用启动后，会默认监听：

```text
http://127.0.0.1:4580
```

手动触发提醒：

```powershell
.\scripts\hook-attention.ps1 -Title "Codex needs input" -Detail "Plan question waiting" -Open
```

直接调用 HTTP：

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:4580/api/attention `
  -ContentType "application/json" `
  -Body '{"title":"Codex needs input","detail":"Review the proposed plan","open":true}'
```

清除手动提醒：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4580/api/attention/clear
```

只执行“打开 Codex”命令：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4580/api/open
```

如需固定端口，可设置：

```bash
CODEX_ATTENTION_PORT=4580
```

如需覆盖默认打开命令，可设置：

```bash
CODEX_ATTENTION_OPEN_COMMAND=code -r "C:\path\to\repo"
```

## 连接模式

### Auto

默认模式，自动扫描本机 Codex session 文件。

适合：

- 直接跟随你当前在终端里运行的 Codex

限制：

- 这是基于 session 文件的启发式监听，不是官方 app-server 自动发现协议
- 偶尔可能把最近活跃但已结束的会话也算进去

### Managed

应用自己启动并托管 `codex app-server`。

适合：

- 需要从桌宠里直接运行测试 Prompt
- 需要一条完全由应用控制的会话链路

### External

连接你手工提供的外部 WebSocket 地址。

环境变量：

```bash
CODEX_APP_SERVER_URL=ws://127.0.0.1:8765
CODEX_APP_SERVER_URLS=ws://127.0.0.1:8765,ws://127.0.0.1:8766
```

## 托盘配置

托盘里当前可配置：

- 显示/隐藏桌宠
- 显示/隐藏状态对话框
- 对话框信息：`简略` / `详细`
- 对话框距离：按 `10px` 步进增减，支持重置和自定义输入
- 大小：`S` / `M` / `L`
- 主题颜色：预设色或自定义十六进制颜色
- 连接模式切换
- 自动弹出 Codex 开关
- 自定义“打开 Codex”命令
- 手动测试 / 清除 attention hook
- 测试 Prompt 触发
  - 仅 `managed` 模式可用

## 状态映射

当前会把 Codex 状态映射为桌宠视觉状态：

| Codex 状态 | 桌宠表现 | 对应 SVG | 预览 |
| --- | --- | --- | --- |
| `idle` | 待命 | `clawd-idle-follow.svg` | ![idle](src/electron/assets/svg/clawd-idle-follow.svg) |
| `thinking` | 思考中 | `clawd-working-thinking.svg`，忙碌线程 `>= 3` 时切换为 `clawd-working-ultrathink.svg` | ![thinking](src/electron/assets/svg/clawd-working-thinking.svg) |
| `typing` | 输出中 | `clawd-working-typing.svg` | ![typing](src/electron/assets/svg/clawd-working-typing.svg) |
| `working` | 执行中 | `clawd-working-typing.svg`，忙碌线程 `>= 2` 时切换为 `clawd-working-building.svg` | ![working](src/electron/assets/svg/clawd-working-building.svg) |
| `editing` | 改文件中 | `clawd-working-carrying.svg` | ![editing](src/electron/assets/svg/clawd-working-carrying.svg) |
| `subagent_one` | 单代理忙碌 | `clawd-working-juggling.svg` | ![subagent one](src/electron/assets/svg/clawd-working-juggling.svg) |
| `subagent_many` | 多代理忙碌 | `clawd-working-conducting.svg` | ![subagent many](src/electron/assets/svg/clawd-working-conducting.svg) |
| `approval` | 提醒 / 关注 | `clawd-notification.svg` | ![approval](src/electron/assets/svg/clawd-notification.svg) |
| `error` | 错误 | `clawd-error.svg` | ![error](src/electron/assets/svg/clawd-error.svg) |
| `success` | 完成 | `clawd-happy.svg` | ![success](src/electron/assets/svg/clawd-happy.svg) |
| `sleeping` | 休眠 | `clawd-sleeping.svg` | ![sleeping](src/electron/assets/svg/clawd-sleeping.svg) |

实际映射逻辑在 [src/electron/main.ts](src/electron/main.ts) 中完成，并会结合最近线程事件生成状态气泡内容。

## 调试与测试

### 终端监听器

```bash
npm run monitor
```

带测试 Prompt：

```bash
npm run monitor -- --prompt "只回复 OK。"
```

连接外部 app-server：

```bash
npm run monitor -- --listenUrl ws://127.0.0.1:8765
```

录制事件：

```bash
npm run monitor -- --record events/phase0-demo.jsonl
```

### 本地状态面板

```bash
npm run dashboard
```

默认地址：

```text
http://127.0.0.1:4580
```

### 质量检查

```bash
npm run typecheck
npm run build:electron
```

## 打包

`dist` 系列脚本会在首次执行时按需下载 `electron-builder@26.8.1`，后续通常会直接命中 npm 缓存。

本机目录包：

```bash
npm run dist:dir
```

适合先本地验证资源路径和运行是否正常，不生成安装包。

### macOS

默认打包：

```bash
npm run dist:mac
```

会在当前 mac 环境下生成：

- `.dmg`
- `.zip`

如果要区分不同芯片：

Apple Silicon `arm64`：

```bash
npm run dist:mac -- --arm64
```

Intel `x64`：

```bash
npm run dist:mac -- --x64
```

Universal：

```bash
npm run dist:mac -- --universal
```

说明：

- `arm64` 适合 Apple Silicon 芯片，例如 M1 / M2 / M3 / M4
- `x64` 适合 Intel Mac
- `universal` 同时包含两种架构，体积更大，但分发更方便

### Windows

默认打包：

```bash
npm run dist:win
```

会生成：

- `.exe`，NSIS 安装包
- `.zip`

显式指定 `x64`：

```bash
npm run dist:win -- --x64
```

说明：

- Windows 安装包更建议在 Windows 环境或 GitHub Actions 上打
- 当前仓库已经有自动打包 workflow

### 产物路径

默认输出目录：

```text
release/
```

常见产物示例：

```text
release/*.dmg
release/*.zip
release/*.exe
release/mac-arm64/
```

## GitHub Actions

仓库包含自动打包工作流 [.github/workflows/build-desktop.yml](.github/workflows/build-desktop.yml)：

- 手动触发 `Build Desktop Apps`
- 或推送 `v*` tag 自动构建
- 会分别构建 macOS / Windows
- 产物会作为 workflow artifacts 上传
- 推送 `v*` tag 时，也会自动附加到 GitHub Release 供下载

### GitHub Release 下载

如果你准备把仓库公开并让别人直接下载安装包，推荐用 tag 触发发布：

```bash
git tag v0.1.0
git push origin main
git push origin v0.1.0
```

触发后工作流会：

- 构建 macOS 和 Windows 安装包
- 保留 Actions artifacts 方便排查
- 自动创建或更新同名 GitHub Release
- 把 `.dmg`、`.zip`、`.exe` 上传到 Release 页面

如果是 fork 仓库，请先在 GitHub 上确认该 fork 已启用 Actions。

## 工作方式

本项目当前有两条主要监听链路：

1. `auto` 模式
   - 扫描 `~/.codex/sessions/**/*.jsonl`
   - 持续增量读取事件
   - 映射为统一的 monitor 事件和线程状态

2. `managed` / `external` 模式
   - 连接一个或多个 `codex app-server`
   - 接收线程、turn、item 级别事件
   - 聚合成桌宠最终状态

之后主进程会把聚合结果发送给 renderer，由 renderer 更新：

- SVG 状态
- 气泡内容
- 大小和配色
- 气泡与机器人的相对布局

## 项目结构

```text
src/electron/            Electron 主进程、preload、renderer
src/main/codex/          app-server / session 文件监听
src/main/state/          状态聚合
src/shared/              共享类型
src/dashboard/           本地调试面板静态资源
scripts/                 monitor / dashboard 启动脚本
.github/workflows/       CI 打包工作流
```

## 已知边界

- `auto` 模式依赖本地 session 文件结构，稳健性不如官方 app-server 事件流
- `external` 模式下不会主动创建会话，只负责监听
- `runPrompt` 只在 `managed` 模式可用
- 当前打包配置未接入 macOS 公证和 Windows 代码签名

## LICENSE

本项目源码采用 [MIT License](LICENSE) 发布。

### 使用的第三方资源

本项目在开发过程中使用了来自以下项目和作者的资源，所有相关资源和设计都保留原作者的版权声明：

- **SVG 素材**：使用了来自 [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) 的 26 个 SVG 素材（仅进行了颜色的修改，结构保持不变）。
- **状态机设计**：使用了原项目中的状态机参数，包括状态映射和处理逻辑，特别是睡眠序列的时长设置等。
- **眼球追踪系统**：直接使用了原项目的眼球追踪像素量化参数和相关算法。
- **Mini 模式**：原项目的 Mini 模式设计和相关配置在本项目中得到了复用。

本项目对上述资源进行了自定义和扩展，但原作者的设计和代码在本项目中仍然发挥着核心作用。所有这些资源的版权归原作者所有，遵循 MIT 协议进行使用。

## 致谢

特别感谢以下项目和作者的贡献：

- **[rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)**：本项目基于原项目的美术素材、状态机设计、眼球追踪系统、Mini 模式等核心代码进行开发。原项目中的设计和代码（包括但不限于 SVG 素材、状态机参数、眼球追踪系统和 IPC 接口命名）被直接引用，并在本项目中进行了修改和扩展。特别感谢原作者为该项目所做的贡献。

原项目作者信息：

- GitHub：`rullerzhou-afk`
- 小红书账号：`鹿鹿🦌`

我们深感荣幸能够在原项目的基础上构建新的功能与体验，并且在此对原项目的设计和代码表示由衷的感谢。所有原始设计和代码的版权归原作者所有。
