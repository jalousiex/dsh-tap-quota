# dsh-tap-quota

Standalone sidebar quota widget for [DeepSeek Harness (dsh)](https://github.com/taikaikaikai-pixel/dsh-tap): displays CodeBuddy / TraeWork CN / Qoder CN account balances and consumed credits in the left sidebar footer.

## Features

- **三通道余量一览**：CodeBuddy（OAuth 额度 / API Key 估算）、TraeWork CN（IDE 池 + Work 池双池余额）、Qoder CN（用户配额 + 附加配额）
- **已消耗积分**：从 dsh-tap 的 usage meter 读取累计消耗 credits 与请求次数
- **状态色点 + 迷你进度条**：绿（充足）/ 黄（<30%）/ 红（<10%）/ 灰（未登录或无数据）
- **自动刷新**：每 60 秒轮询一次，支持手动刷新
- **深色主题**：使用宿主 `--dsw-alias-*` 设计令牌，自动跟随深色模式
- **零侵入**：纯展示插件，不修改任何通道配置或凭据

## 依赖

- **dsh-tap** 必须已安装并配置在同一 profile 中（本插件读取 dsh-tap 的 `/dsh-tap/settings` HTTP 路由获取余量数据）
- dsh ≥ 0.1.6（需要 `sidebar.footer.action` 槽位支持）

## 安装

### 方式一：plugin_manager 安装（推荐）

```bash
# 在 dsh profile 目录下安装
cd ~/.dsh/profiles/desktop
pnpm add dsh-tap-quota
```

然后在 dsh 的插件管理器中启用 `dsh-tap-quota`。

### 方式二：手动安装

将本包放入 profile 的 `node_modules` 目录，然后在 `cordis.patch.yml` 中添加：

```yaml
- insert:
    - id: dsh-tap-quota
      name: 'dsh-tap-quota'
```

## 数据来源

本插件不自行获取余量数据，而是复用 dsh-tap 插件的后端路由：

| 动作 | 端点 | 返回 |
| --- | --- | --- |
| `usage` | POST /dsh-tap/settings | CodeBuddy 额度快照 + usage meter 消耗统计 |
| `trae-quota` | POST /dsh-tap/settings | TraeWork CN 双池余额（IDE / Work） |
| `qoder-quota` | POST /dsh-tap/settings | Qoder CN 用户配额 + 附加配额 |

所有请求共享 dsh-tap 后端的 60 秒缓存，不会额外增加上游请求。

## 显示内容

在左侧菜单底部（Settings 按钮旁）显示一个紧凑的多行组件：

```
● CB     12.3K 剩余 / 50.0K
  ▓▓▓▓▓▓▓▓▓░░░░░░░░░░░  (周期用量进度条)
● Trae   8.5K IDE / 3.2K Work
  ▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░
● Qoder  450 / 1000
  ▓▓▓▓▓▓▓▓░░░░░░░░░░░░
─────────────────────
累计消耗: 1.2K credits / 34 次请求
↻ 刷新
```

色点含义：
- 🟢 绿色：余量充足（>30%）
- 🟡 黄色：余量偏低（10%–30%）
- 🔴 红色：余量危急（<10%）或获取失败
- ⚪ 灰色：未登录或无数据

## 开发

```bash
# 语法检查
node --check lib/client.js
node --check index.js
```

无构建步骤：纯 `React.createElement`，与 dsh-tap 的客户端模块同款模块加载器模式。

## License

MIT
