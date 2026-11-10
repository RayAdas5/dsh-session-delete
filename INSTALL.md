# 安装到其他 DSH 客户端

这个包是标准 npm 包（`dsh-session-delete-<version>.tgz`），宿主是 **DSH 0.2.1-rc.2**，
需要 Node ≥ 20（DSH 自带运行时即可）。

## 包里有什么

```
package/package.json
package/cordis.patch.yml     ← bundle 补丁层，DSH 靠它把插件挂进 profile
package/lib/index.js         ← 宿主侧：路由 + 自动清理
package/lib/client.js        ← 浏览器侧：菜单项 / 回收站页 / 设置页
package/lib/*.js             ← 会话定位、回收站、附件、设置、zstd
package/README.md
package/CHANGELOG.md
```

---

## 方式 A：`dsh plugin` 命令（有 CLI 时最快）

```sh
dsh plugin --profile desktop add /绝对路径/dsh-session-delete-1.0.1.tgz
```

装完**重启 DSH**。卸载：

```sh
dsh plugin --profile desktop remove dsh-session-delete
```

> 不同 DSH 版本的 profile 名可能是 `desktop` 或 `web`，用你实际的 profile 目录名。

---

## 方式 B：手动安装（没有 CLI 也能用）

**1. 解压**

```sh
tar -xzf dsh-session-delete-1.0.1.tgz
```

得到一个 `package/` 目录。

**2. 放进 profile 的 node_modules**

```text
<DSH_HOME>/profiles/desktop/node_modules/dsh-session-delete/
```

`<DSH_HOME>` 一般是 `C:\Users\<你>\.dsh`；profile 目录名可能是 `desktop` 或 `web`，
看你机器上实际有的那个（里面有 `package.json`）。

Windows 上可以复制，也可以建目录联接：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-session-delete" -Target "C:\path\to\package"
```

**3. 在 profile 的 `package.json` 里登记 bundle**

编辑 `<DSH_HOME>\profiles\desktop\package.json`，在 `dsh.profile.bundles` 数组里加一行：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "...",
        "dsh-session-delete"
      ]
    }
  }
}
```

**只需要这一行**，不需要改 `dependencies`——包已经直接在 `node_modules` 里了。

**4. 重启 DSH**

Host 半侧只在启动时装载。重启后：

- 会话行 `⋯` 菜单里出现「删除会话」
- 左侧出现「会话回收站」
- 账号菜单 → 设置 → 「删除与回收站」

---

## 卸载

1. 从 `dsh.profile.bundles` 里删掉 `"dsh-session-delete"`；
2. 删掉 `node_modules/dsh-session-delete`（或那个 junction）；
3. 重启 DSH。

`<DSH_HOME>/session-delete/`（回收站数据 + 设置）不会自动删除，想清干净就手动删。

## 数据落在哪

| 内容 | 位置 |
| --- | --- |
| 回收站 | `<DSH_HOME>/session-delete/trash/` |
| 设置 | `<DSH_HOME>/session-delete/settings.json` |
| 被删除会话用过的附件 | `<DSH_HOME>/attachments/v1/`（永久删除时按引用计数清理） |

## 常见问题

**装完没反应？** 先确认重启过 DSH；再看 `<DSH_HOME>/logs/desktop-next.log` 有没有
`[session-delete]` 或 cordis 报错。

**启动卡住？** 把 `dsh.profile.bundles` 里那行删掉再启动——插件加载失败会让 DSH 卡在
启动阶段。
