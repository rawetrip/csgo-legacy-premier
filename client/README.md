# 接受弹窗补丁：用**你自己的** `party.js` 生成

这个目录**不再提供成品 `party.js`**。

原因：`party.js` 是 **Valve Corporation** 的 `csgo/panorama/scripts/party.js`（构建 1575，
原始 **13497 字节**）的修改版 —— 而 Valve 在 2018 年确实为「从 `code.pbin` 反编译出来的
Panorama JS 与 layout」发过 DMCA 通知（[github/dmca 2018-06-21](https://github.com/github/dmca/blob/master/2018/2018-06-21-Valve.md)）。
本仓库不再替你把这份文件转手分发。

**生成脚本在另一个仓库**：
`csgo-legacy-matchmaking/tools/make_party.py`

## 怎么生成（三步）

```bash
# 1. 从你自己的 code.pbin 里取出原始 party.js（游戏必须关着）
py tools/pbin_tool.py get panorama/scripts/party.js party_orig.js
#    原始版应当是 13497 字节 —— 不是的话你取错文件了

# 2. 生成（用法就是「原始件 → 输出件」）
py tools/make_party.py party_orig.js party_patched.js
#    输出应当是 17464 字节

# 3. 写回去，回读校验
py tools/pbin_tool.py put panorama/scripts/party.js party_patched.js
py tools/pbin_tool.py get panorama/scripts/party.js readback.js
cmp readback.js party_patched.js && echo OK
```

**判据**：`party.js` 从 **13497** → **17464** 字节。

> 这个「原始件 → 17464」的复现是**逐字节验证过的**，不是推测。

## 它负责什么

`party.js` 被**两个功能**占用，改之前先想清楚谁还在依赖它：

| 功能 | 状态 |
|---|---|
| **接受弹窗**（触发 / 音效 / 关闭） | **需要**。`@` 公告式路径 1.9 秒后会调 `SetLocalPlayerReady`，**没有这一步客户端根本不排队连服**（控制台刷 `will not queue connect`），表现为「卡在 retry」 |
| **prime 的 JS 兜底** | **已废弃**。prime 现在由 GC 侧修 `owner_soid.id` 解决（见根 README），JS 与 native 两条 hook 都已退役 |

所以 `make_party.py` 生成的 **17464** 版就够用了 —— 它只含弹窗块。早先发出去的
**19898** 版是在此之上又叠了一个 prime 块，那个块现在**没有任何作用**，不必再装。

> ⚠️ 踩过的坑：prime 那条线为了 native hook 能被调用，一度把 `party.js` **还原成原始版**，
> 而弹窗没人放回去 —— 于是**接受弹窗和音效一起静默消失**。改这个文件前先确认谁还在用它。

## 用途限制

本项目仅用于**自建服务器 / 离线环境下的兼容性研究**，所有测试都在非 VAC secure 的自建服
上完成，请勿用于官方服务器或任何在线竞技环境。

---

# Accept-popup patch: generate it from **your own** `party.js`

This directory **no longer ships a ready-made `party.js`**. That file is a modified copy of
**Valve Corporation's** `csgo/panorama/scripts/party.js` (build 1575, original **13497
bytes**) — and Valve has in fact issued a DMCA notice over "decompiled … CS:GO javascript
source code and layouts for Panorama UI" extracted from `code.pbin`
([github/dmca 2018-06-21](https://github.com/github/dmca/blob/master/2018/2018-06-21-Valve.md)).
This repository will not pass that file on for you.

The generator lives in the other repository:
`csgo-legacy-matchmaking/tools/make_party.py`

```bash
py tools/pbin_tool.py get panorama/scripts/party.js party_orig.js   # pristine, 13497 bytes
py tools/make_party.py party_orig.js party_patched.js               # output, 17464 bytes
py tools/pbin_tool.py put panorama/scripts/party.js party_patched.js
py tools/pbin_tool.py get panorama/scripts/party.js readback.js
cmp readback.js party_patched.js && echo OK
```

The game must be closed while editing `code.pbin`. The 13497 → 17464 reproduction is
**verified byte-for-byte**, not assumed.

`party.js` carries two things: the **accept popup** (still required — its
`SetLocalPlayerReady` call is what makes the client actually queue-connect; without it you get
stuck on "retry") and a **Prime JS fallback** (obsolete — Prime is now fixed on the GC side via
`owner_soid.id`). The generated 17464-byte version contains only the popup block; the older
19898-byte version added a Prime block that no longer does anything.

Intended solely for **compatibility research on self-hosted servers / offline environments**;
all testing was done on non-VAC-secure self-hosted servers.
