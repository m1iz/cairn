# Cairn

Cairn 是一个本地运行的桌面 Agent 工作台，可以用于日常对话，也可以绑定项目目录完成开发任务。

## 功能

- 多会话对话与项目工作区
- Plan 与 Goal 长任务
- 文件、命令行、Git 和终端工具
- Skills、MCP、Hooks、Memory
- Subagent、Team 和 Scheduler
- 自定义模型与 OpenAI-compatible 接口

## 从源码运行

需要 Node.js 22 或更高版本。

```bash
npm ci
cd desktop
npm ci
npm run dev
```

首次启动后，在设置页面添加模型地址、模型 ID 和 API Key 即可使用。

## 构建

```bash
npm run typecheck
npm run build
npm --prefix desktop run package:verify
```

本地配置和会话数据默认保存在 `~/.cairn`，不会提交到仓库。

## License

[MIT](LICENSE)
