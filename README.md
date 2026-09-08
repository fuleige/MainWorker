# MainWorker

一个基于 Codex App Server 的单用户个人工作台，当前包含永久对话、文章审核、个人规划和额度概览四个模块。界面适配桌面与移动端，所有业务数据都保存在本机。

## 局域网运行

前置条件：Node.js 22.13 或更新版本，以及已安装并登录的 `codex` CLI。

```bash
npm install
npm run dev
```

启动后终端会同时显示本机地址和局域网地址，例如：

```text
Local:   http://localhost:3000/
Network: http://192.168.x.x:3000/
```

第一次启动会自动生成访问口令。另开一个终端查看：

```bash
npm run token
```

在同一局域网的电脑或手机上打开 `Network` 地址，输入该口令即可。

## 当前功能

- 主对话：多会话并行执行、Codex 流式输出、停止任务、历史删除、快捷短语、长文本输入，以及刷新和服务重启后的历史恢复。
- Markdown 展示：流式容错渲染、常见语言语法高亮、代码行号，并在用户上滑后暂停自动跟随输出。
- 文章审核：聚合读取 Basic 文章、AlgorithmLearn 和“深度学习基础”书稿中的 Markdown，支持全局搜索、逻辑目录、公式、代码高亮、图片，以及当前文章/整个项目两级永久对话。
- 个人规划：使用“项目 → 任务 → 一层子任务”结构，由侧边 AI 助手维护内容；支持今日、本周、计划日期、截止日期、优先级，以及每天、工作日和每周指定星期的循环任务。
- 额度概览：并列展示 Codex 与 Spark 可用额度，采用十分钟缓存、并发请求合并和过期数据优先展示策略，避免频繁查询。
- 单 Token 鉴权：高强度随机 Token、HttpOnly Cookie、同源写入校验和登录限流。

## 本地数据

- 工作台数据库：`.data/mainworker.sqlite`
- 自动生成的访问口令：`.data/access-token`
- Codex 对话：SQLite 保存展示记录，Codex App Server 保存并恢复原生线程。
- 文章正文：直接读取各文章来源目录，不复制文档；修改文章时由对应的 AI 审核会话直接更新原 Markdown。

如需自定义文章路径或固定 Token，可复制 `.env.example` 为 `.env` 后修改。已有 shell 环境变量优先级高于 `.env`。

## 检查与构建

```bash
npm run check
npm run build
```

服务端支持通过环境变量配置 HTTPS；公网映射、反向代理和进程托管由实际部署环境负责。
