# v3 —— 优先状态修复 + 服务端换图补丁

2026-09-29

本仓库现在覆盖两块：**优先（Prime）状态修复**，以及**服务端换图相关的运行时补丁**。
完整匹配流程（含选/禁图）见另一个仓库
[`csgo-legacy-matchmaking`](https://github.com/rawetrip/csgo-legacy-matchmaking) 的 `v3`。

## 适用范围（重要）

| 维度 | 范围 |
|---|---|
| **服务端** | **仅限 Linux 端 srcds**。`map-sync/srvfix.c` 按 `engine.so`（32 位 ELF）的硬编码偏移写，Windows 端不适用 |
| **客户端版本** | **狂牙大行动（Operation Broken Fang）那一版构建** |
| **模式** | ★ **只实现了「优先」（Prime）这一个队列。竞技、休闲等其他模式尚未实现** |
| 构建偏移 | 基于 2026-09-26 的构建（CS:GO 已停止更新，该构建是冻结的；换分支/地区版仍需重新定位） |

---

## 一、优先状态：根因在 GC，不在客户端

**根因**：`Server_v3.js` 的 `getMSGdata()` 把帧头里的 SteamID64 用 `& 0xFFFFFFFF` 截成了
**accountId** 再交给所有事件处理器，`buildEconSOCache()` 于是把它当成 `ownerSoid.id` 下发。
而客户端拿 `owner_soid` 去匹配**本地玩家自己的 SOID**（内存里是
`{ id: SteamID64, type: 1 }`）——**少了高 32 位就永远匹配不上**，
本地玩家的 SOCache 从来没挂上（`host+0xB4 == NULL`），
`GetElevatedState()` 只好一路返回 `"none"`，优先相关 UI 全按非优先渲染。

反证：csgc 日志里 `[GC] SendMessage: type=0x8000238F, ..., steamId=76561199801834984`
—— SteamID64 本来就在帧头里，是 GC 自己丢掉的高位。

修法：幂等的 `toSteamId64(id)`，`ownerSoid.id` 走它（3 处）。
修完后 native 自己就返回 `"elevated"`，**不需要任何客户端 hook**。

**两个 native hook 已退役**（`csgc-src` 里 `kEnableNativePrimeHook = false`，代码保留可回退）。
`code.pbin` 里 `party.js` 是**原始版**（13497 字节）——注意：本仓库的
`client/party.js` 是**接受弹窗 + prime 的 JS 兜底**合用的一份（19898 字节），
两者别搞混。

> ⚠️ **踩过的坑**：prime 那条线为了 native hook 能被调用，一度把 `party.js` 还原成原始版。
> 而 `party.js` 同时承载着**接受弹窗**（触发/音效/关闭）——于是 hook 退役后没人把它放回去，
> **接受弹窗和音效一起消失了**。更隐蔽的是：`@` 公告式路径 1.9 秒后会调
> `SetLocalPlayerReady`，没这一步客户端**根本不排队连服**（控制台刷 `will not queue connect`），
> 表现为「卡在 retry」——看起来完全像服务器侧的问题。
> **改 `party.js` 前先想清楚谁还在依赖它。**

---

## 二、服务端换图：srvfix（五个补丁）

`map-sync/srvfix.c`，LD_PRELOAD 进 Linux srcds：

| 补丁 | 做法 |
|---|---|
| reservation cookie 无条件放行 | `engine.so+0x1d07b0` 的 `je` → `jmp` |
| 换图 detour 桩 | **默认关**（`SRVFIX_DETOUR=1` 才开） |
| **桩页设可执行** | `mmap(PROT_READ\|PROT_WRITE)` 出来的页是 NX 的，跳进去必崩 |
| NOP 掉 `Cbuf_Execute` | `site+0x0A` 那条——命令已入队，交给主循环 flush |
| 抹掉无效模式名 `reserved` | `"map %s reserved"` 里 8 字节改空格 |

其中**「桩页设可执行」是个埋了很久的雷**：原文件从头到尾没对 stub 调过 mprotect，
一旦那段代码真被执行就 SIGSEGV（`segfault at <mmap地址> ip <同一地址> error 15`）。
它一直没爆，只因为服务器此前从未进入「已预留」状态，那段路没跑起来。

> 顺带更正：本仓库 `map-sync/README.md` 里「换图靠外部写 `server_map.txt`」那套描述**已过时**。
> 实测换图是**服务器进程里的 `Map veto pick controller` 实体自己 changelevel**，
> 不需要 GC 参与。详见 `csgo-legacy-matchmaking` 的 `v3`。

---

## 三、本次附带

- `gc/Server_v3.js` 同步到完整流程版本，并**脱敏**
  （作者 SteamID64 / accountId / 主机 IP / 游戏服 SteamID 全为占位符；
  顺带修掉旧版里已经公开的真实游戏服 SteamID）。
- `map-sync/README.md` 加过时横幅 + 把 srvfix 描述从「v2 双补丁」更正为「v3 五补丁」。

---

仅用于**自建服务器 / 离线环境下的兼容性研究**，非 VAC secure。
