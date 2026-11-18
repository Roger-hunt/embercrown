# 回归测试

```bash
bash tests/run.sh            # 全部，约 3 分钟
bash tests/run.sh scope      # 只跑某一组：scope / server / ult / client
```

每组都在**隔离实例**上跑：临时端口（3986、3987）、临时数据目录、固定测试口令，不碰线上进程和 `data/`。
浏览器测试里单人遥测上报被拦截，不会往任何服务器写数据。

| 组 | 文件 | 项数 | 守什么 |
| --- | --- | --- | --- |
| `scope` | `scope-check.js` | 2 | 客户端内联脚本与 `server.js` 语法正确；没有「先用后声明」的 `let`/`const`（TDZ）；没有局部变量遮蔽外层函数后被调用 |
| `server` | `server.test.sh` | 26 | 口令与令牌、限流（有效令牌不受限）、蜜罐不封 IP、`TRUST_PROXY` 只信任指定代理、分段请求、gzip、304、重启后令牌仍有效、随机口令不落库 |
| `ult` | `ult.test.js` | 14 | 大招在冷却中 / 资源不足时按下不会让游戏停止渲染；键盘 `4` 与手柄 `RB`、单人与联机各一遍 |
| `client` | `client.test.js` | 11 | 「超神」播报有语音且明显比普通击杀响、别人超神同样响、不削波；首领语音走 Web Audio；观众开关与登录状态刷新后保留；英文界面的口令错误提示；单人从第 1 波开始 |

## 依赖

不进 `package.json`（两仓的 `package.json` 要求逐字节一致）。按顺序查找，找不到的组**跳过**而不是失败：

| 工具 | 用于 | 怎么指定 |
| --- | --- | --- |
| `playwright-core` | `ult`、`client` | `EC_PLAYWRIGHT=/path/to/node_modules/playwright-core`，或 `EC_MODULE_DIRS=/path/to/node_modules` |
| Chromium | `ult`、`client` | `EC_CHROME=/path/to/chrome`；不设时用 `~/.cache/ms-playwright` 里已有的，或 playwright 自带的 |
| `espree`、`eslint-scope` | `scope` | 装了 eslint 的任何项目都有：`EC_MODULE_DIRS=/path/to/node_modules` |
| `curl`、`sqlite3` | `server` | 系统命令 |

`EC_ROOT` 可以让测试去测另一份代码（默认是 `tests/` 的上一级）。

## 写新测试时

- 用 `lib.js` 的 `startServer(port, env)` 起实例，它已带 `QUEUE_LOAD=99`：机器负载高时服务器会让联机排队，测试里要关掉。
- `openGame()` 默认**不做真实绘制**（软件渲染每秒只有约 2 帧），游戏逻辑照常逐帧运行；要截图或量渲染开销传 `{ render: true }`。
- 等待用 `gameWait(page, 秒)`（按游戏时钟）或 `frames(page, n)`，别用固定的 `sleep` 等逻辑。
- 新版本多了登录加载页：进主菜单一律走 `enter(page)`，刷新页面后也要再调一次。
- 页面暴露了 `window.__arena`（`game` / `net` / `player` / `spawnEnemy` 等）和 `window.__arenaCtl`，测试靠它们读状态。
- `tools/profile.js` 不是测试：`node tests/tools/profile.js - sp 6` 输出绘制调用数、场景网格统计和 CPU 热点，改渲染前后各跑一次做对比。

只覆盖单人段和 `server.js`。eccf 的 `P2PHost` 与 Cloudflare Worker 不在覆盖范围内。
