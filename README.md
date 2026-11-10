# dsh-session-delete · 删除会话 + 会话回收站

给 DeepSeek Harness 补上「删除会话」：会话行「⋯」菜单里多一项，位置紧跟**归档会话**；
删掉的会话先进**回收站**，能展开看它用过的附件，确认后再永久删除、连附件一起清掉。
同一动作绑了快捷键（默认 **Ctrl+Alt+D** / macOS **Command+Option+D**）。

> 上游 DSH 明确没有「删除会话」——会话只能归档，日志永远留在磁盘上。而附件子系统
> 更是写死了「永远不会自动删除，也没有任何 GC」。这个插件补的正是这两块。

## 它长什么样

**会话行「⋯」菜单**：

```
置顶会话
重命名
分叉会话
归档会话
删除会话      ← 本插件（order 420）
复制 Session ID
```

点「删除会话」先弹确认，确认后会话目录被**移动**进回收站（不是删除）。

**左侧全局面板**（与「插件 / 自动化任务」并列）：

```
插件
自动化任务
回收站          ← 已有的回收站插件
会话回收站      ← 本插件
```

点「会话回收站」进入整页：

- 每条显示标题、删除时间、占用大小、原目录、附件数；
- **点标题行展开** → 列出这个会话用过的每个附件（类型 / 文件名 / 大小）；
- 展开后可以 **复原**（挪回原目录）或 **永久删除**；
- 「永久删除」是行内二次确认，确认后才真正删盘。

## 附件怎么处理

这是本插件和普通「回收站」最大的区别：

1. **移入回收站时不动附件**。附件在 `<DSH_HOME>/attachments` 下是内容寻址的
   （`sha256:<hash>`），同一份字节只存一次，fork 出来的会话、重复上传的同一张图
   都会共享同一个对象。跟着会话一起挪会把别人的图挪坏。
2. **永久删除时按引用计数清理**。插件会扫描**所有现存会话日志** + **回收站里其他条目**
   的日志，只有「除它之外没人再引用」的附件才会被删：
   ```
   图片      <DSH_HOME>/attachments/v1/objects/<hash前2位>/<sha256>
   文件对象  <DSH_HOME>/attachments/v1/file-objects/<hash前2位>/<sha256>
   文件引用  <DSH_HOME>/attachments/v1/files/<hash前2位>/<sha256>/<name>
   ```
3. 扫描不到 / 读不动的日志一律当作「可能还引用着」，宁可留一个孤儿文件，也不删错。

## 安装

```
<DSH_HOME>\plugins\dsh-session-delete\                     ← 源码
<DSH_HOME>\profiles\desktop\node_modules\dsh-session-delete ← junction
<DSH_HOME>\profiles\desktop\package.json                    ← dependencies + dsh.profile.bundles
```

装完**完全退出 DSH 再启动**（Host 半侧只在启动时装载）。

**卸载 / 回滚**（两步都要做）：

1. 编辑 `<DSH_HOME>\profiles\desktop\package.json`：`dependencies` 与
   `dsh.profile.bundles` 里各删掉 `dsh-session-delete` 一行；
2. 删掉 `<DSH_HOME>\profiles\desktop\node_modules\dsh-session-delete`（junction 本身）。

## 设置页

账号菜单 → **设置** → **删除与回收站**：

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 自动清理 | 开 | 按保留期自动永久删除回收站里的会话 |
| 保留时长 | 30 天 | 7 / 30 / 90 / 365 天，或「永久保留」 |
| 立即清理一次 | — | 立刻按当前保留期扫一遍，并报告清掉了几个、释放多少 |
| 删除会话快捷键 | `Ctrl+Alt+D` | 点「修改」后直接按组合键录制；`Esc` 取消，冲突会告诉你是跟哪个命令撞了 |

设置存在 `<DSH_HOME>/session-delete/settings.json`（原子写入，损坏自动回退默认值），
改完立即生效，不用重启。

**自动清理的时机**：启动 8 秒后扫一次，之后每小时一次。它走的是和手动「永久删除」
**完全相同**的 `purgeSession` 路径，所以附件引用计数保护一样生效——不会因为自动清理
就把别的会话还在用的图删掉。

## HTTP 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/session-delete/trash` | 列出回收站（含每条会话的附件清单与总占用） |
| `POST` | `/session-delete/trash` | 移入回收站，body `{sessionId, title}` |
| `POST` | `/session-delete/restore` | 复原，body `{trashId}` |
| `POST` | `/session-delete/purge` | 永久删除（含独占附件），body `{trashId}` |
| `GET` | `/session-delete/settings` | 读设置 + 回收站用量 |
| `POST` | `/session-delete/settings` | 保存设置，body `{autoClean, retentionDays}` |
| `POST` | `/session-delete/sweep` | 立即按保留期清理一次 |

### 数据落在哪

```
<DSH_HOME>/session-delete/trash/<trashId>/        会话目录，原样
<DSH_HOME>/session-delete/trash/<trashId>.json    元数据
```

元数据里有原路径、标题、删除时间、大小和附件清单，所以复原是原样挪回，不需要重新推导路径。

### 错误码

| code | HTTP | 含义 |
| --- | --- | --- |
| `invalid` | 400 | id / trashId 格式不对 |
| `live` | 409 | 会话正在运行，先停止 |
| `unknown` | 409 | 磁盘上或回收站里找不到 |
| `conflict` | 409 | 原目录已存在同名会话，不能复原 |
| `unsupported` | 409 | 无法证明目录身份，已拒绝 |
| `move` / `rm` | 503 | 文件操作失败（可能被占用） |
| `storage` | 503 | 存储服务故障 |

## 版本规则（硬性约定）

**每次改动都要升版本号并补 CHANGELOG**，不许只改代码不动版本。幅度按改动性质：

| 改动性质 | 提升 |
| --- | --- |
| 修 bug / 文案 / 样式 | `patch` |
| 新增功能、设置项、入口 | `minor` |
| 破坏兼容（数据格式 / 接口 / 卸载方式） | `major` |

```sh
node tools/bump.mjs patch "修复键帽分隔符重复"
```

`package.json` 的 `version` 是唯一来源；设置页标题右侧显示的就是它（重启 DSH 后生效）。
详细规则见 [CHANGELOG.md](./CHANGELOG.md) 顶部。

## 开发与自检

```sh
node --check lib/client.js
node tests/smoke.mjs     # 四个 slot 注册 + 快捷键 + 组件渲染 + 服务晚到
node tests/host.mjs      # 移入/列表/复原/永久删除/共享附件保护/交付物/边界
node tests/settings.mjs  # 设置读写 + 自动清理
node tools/preflight.mjs # 装完之后的解析与加载预检
node tools/bump.mjs patch "说明"   # 升版本 + 补 CHANGELOG
```

## 已知边界

- **附件清单来自会话日志**，日志读不动（损坏 / 没有原生 zstd）时清单为空，但会话照常能删。
- **永久删除的引用扫描**会解压所有会话日志，会话特别多时会慢几秒；这是为了不误删共享附件。
- **复原后侧栏可能需要刷新才会出现**（依赖 Host 的工作区投影刷新）。
- 侧栏里已经有一个别的回收站插件（`dsh-session-purge`）时，两个入口会并存：
  一个是「回收站」，一个是「会话回收站」，互不干扰。

MIT License.
