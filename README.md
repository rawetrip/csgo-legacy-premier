# CS:GO Legacy 优先（Prime）匹配修复

> **English version: [README.en.md](README.en.md)** ← 英文读者请看这里

自建 GC（[CSGO-GC-Replacement](https://github.com/aka3257/CSGO-GC-Replacement)）环境下，
让 CS:GO Legacy 客户端正确显示「优先状态」的修复补丁集。

> ## ⚠️ 结论已更新（2026-09-28 晚）：改 GC 就够了，客户端不用动
>
> **一句话：根因是 GC 把 SO 缓存的 `owner_soid.id` 发成了 accountId 而不是 SteamID64。**
> 客户端匹配不上本地玩家自己的 SOID，**本地玩家的 SOCache 从来没挂上**
> （host `+0xB4` 恒为 NULL），`GetElevatedState()` 于是只能返回 `"none"`。
>
> 修好 `owner_soid`（`gc/Server_v3.js` 里的 `toSteamId64()`）之后，native 自己就返回
> `"elevated"` —— **`csgc.dll` 的 native hook 与 `client/party.js` 的 JS patch 都不再需要**。
> `csgc-hook/` 下的两个 hook 已退役（代码保留可回退，见 `csgc-hook/README.md` 开头）。
>
> 下面凡是以「客户端 API 数据来源无法定位、只能绕过」为前提的段落，都是**当时**的结论，
> 保留作记录 —— 现在的解法见本文的「真正的根因与解法」一节。

## 问题

自建 GC 替换官方 GC 后，客户端 UI 一路按「非优先帐号」渲染：

- 主菜单显示「获取优先」按钮，而不是 Prime 开关
- 比赛设置面板显示「非优先帐户玩家」
- 玩家卡片的段位显示「优先状态下，解冻你的段位」
- 右侧挂着「购买升级成优先状态，可解锁你的段位」的提示

匹配功能本身是正常的（能搜索、能进服、能反复匹配），只是 Prime 相关的 UI 全错。

## 根因

### GC 侧

**1. SO 缓存字段名用了 snake_case**

`Server_v3.js` 里用 `type_id` / `object_data` / `owner_soid` 这类键名构造 SO 缓存，
但 protobufjs 默认把 proto 字段名转成驼峰（`typeId` / `objectData` / `ownerSoid`），
`create()` / `fromObject()` 对未知键名是**静默忽略**的 —— 于是客户端收到的是一个
空对象，从来没拿到过任何 econ 账号数据。

**2. SO 缓存刷新请求无人应答**

客户端收到 `outofdate_subscribed_caches` 后会回一条
`CMsgSOCacheSubscriptionRefresh`（消息 **28**）来要新鲜数据。GC 没有登记这条消息，
日志里表现为 `[ERROR] Unknown message`，客户端因此永远拿不到数据。

**3. SO 类型号与取值写错**

- SO 类型 `1` 是 `CSOEconItem`；`CSOEconGameAccountClient` 是 **`7`**
- `elevated_state` 的值 **`5`** 表示「已购买优先」，不是 `1`

### 客户端侧

即便 GC 把数据正确下发（`CSOEconGameAccountClient` type 7 / `elevated_state=5`、
`CSOPersonaDataPublic` type 2），并且客户端也确实收下了（不再重复请求刷新），
`MyPersonaAPI.GetElevatedState()` 仍然不返回 `elevated`。

该 API 的数据来源未能最终定位，因此改为在客户端 API 层绕过。

> **以上是当时的结论，已被推翻（2026-09-28 晚）。** 数据来源定位到了：就是 SO 缓存
> 里 type 7 的对象，客户端读 `obj[+0x18] == 5`。它读不到 **不是**因为 API 走不通，
> 而是因为 **SO 缓存根本没挂到本地玩家身上** —— `owner_soid.id` 发成了 accountId。
> 参数字段名（snake_case / 驼峰）那次修复是对的，但只修好了一半。
> 详见「真正的根因与解法」。

## 修复内容

### GC 侧 —— `gc/Server_v3.js`

| 位置 | 改动 |
|---|---|
| `buildEconSOCache()` | 字段名 snake_case → 驼峰；填入 `CSOEconGameAccountClient`(type 7, `elevated_state=5`) 与 `CSOPersonaDataPublic`(type 2) |
| `IDict` | 登记消息 28 |
| `CMsgSOCacheSubscriptionRefresh` handler | 新增；回 `CMsgSOCacheSubscribed`(24) |
| `CMsgGCCStrike15_v2_MatchmakingStart` handler | 解析并记录客户端上报的 `prime_only`（原来直接丢弃） |
| `CMsgGCCStrike15_v2_MatchmakingStop` 的 9104 | 去掉 `notes:[{ prime: true }]`（proto 的 `Note` 没有这个字段），改为 `[{}]` |

### 客户端侧 —— 两种方案，二选一

**方案 A（推荐）：[`csgc-hook/`](csgc-hook/) 的 native 修复**

csgc.dll 直接 hook `client.dll` 的两个函数，**不改任何游戏文件**。

**方案 B（旧）：`client/party.js` 的 JS patch**

Monkey patch 三个 native API，**只对本地玩家**返回优先：

- `MyPersonaAPI.GetElevatedState()` → `'elevated'`
- `PartyListAPI.GetFriendPrimeEligible()`
- `FriendsListAPI.GetFriendPrimeEligible()`

> 注意这里有个坑：CS:GO 里有**两个**同名的 `GetFriendPrimeEligible`。
> 比赛设置面板走 `PartyListAPI`，而玩家卡片（`playercard.js` 的 `_IsPlayerPrime`）
> 走的是 `FriendsListAPI` —— 只 patch 一个会出现「一半变对、一半没变」的分裂状态。

好友的 Prime 状态保持真实，不会被误标成优先。

> ⚠️ 两个方案**不要同时用**。JS patch 会在 JS 层把 native 函数整个替换掉，
> 于是 csgc 的 hook 永远不会被调用 —— 装上了也看不到任何日志。

## 使用

### GC

```bash
cp gc/Server_v3.js <你的 gc-replacement>/Server_v3.js
cp gc/config.example.json <你的 gc-replacement>/config.json
# 然后编辑 config.json：填 matchServerIp 与 accountId
node Server_v3.js
```

**装完先自证 `owner_soid` 对了**（这是整件事的关键）—— 把 `gc/verify-socache.js`
放到你的 `gc-replacement/` 下（那个目录有 `./proto`），然后：

```bash
node verify-socache.js <你的 SteamID64>
```

输出的 `ownerSoid.id` 必须是**完整的 SteamID64**（`7656119…`），
不是 accountId。如果是后者，客户端永远不会把 SO 缓存挂到本地玩家身上，
`GetElevatedState()` 就一直是 `"none"` —— 优先 UI 全按非优先渲染。

### 客户端

**方案 A：csgc.dll 的 native 修复（推荐）**

把 [`csgc-hook/prime_hook.cpp`](csgc-hook/prime_hook.cpp) 合进
`csgc-src/src/steam_hook_lite.cpp`，重新构建并部署 `csgc.dll`。
完整步骤（含两处必要的改动）见 [`csgc-hook/README.md`](csgc-hook/README.md)。
**`code.pbin` 完全不用动。**

**方案 B：pbin patch**

`client/party.js` 需要写进 `csgo/panorama/code.pbin` 内的
`panorama/scripts/party.js`。

**改的时候游戏必须关着** —— 游戏在启动时会把资源读进内存，开着游戏改等于没改。

装完务必回读校验：

```bash
# 写入
pbin_tool.py put panorama/scripts/party.js client/party.js
# 回读并与源文件做字节比对
pbin_tool.py get panorama/scripts/party.js /tmp/readback.js
cmp /tmp/readback.js client/party.js
```

## 验证要点

装好后启动游戏，看这几处是否翻正：

| 位置 | 修复前 | 修复后 |
|---|---|---|
| 比赛设置面板 | 非优先帐户玩家 | 仅选择优先匹配（多出「段位匹配」一行） |
| 玩家卡片段位 | 优先状态下，解冻你的段位 | 段位已隐藏 / 正常段位 |
| 右侧面板 | 购买升级成优先状态 | 消失 |

游戏控制台里应能看到补丁的装载日志：

```
[csgc] GetElevatedState patched (direct assign)
[csgc] PartyListAPI.GetFriendPrimeEligible patched
[csgc] FriendsListAPI.GetFriendPrimeEligible patched
```

如果打印的是 `patch FAILED`，说明 native API 对象是只读的，需要改为直接修改调用点。

**方案 A 的验证**看 `csgc_full.log`（csgo.exe 同级目录）：

```
[PRIME] client.dll appeared after 3900 ms
[PRIME] elevation hook live: client.dll+0x6323f0 returns "elevated" (literal at client.dll+0xc76088)
[PRIME] local-player prime hook installed (client.dll+0x632370)
[PRIME] GetElevatedState: "none" -> "elevated"
[PRIME] local-player prime predicate -> true
```

## 「从根上解决」的完整过程（含已被推翻的中间结论）

`MyPersonaAPI.GetElevatedState()` 的调用链：

```
GetElevatedState()                      // client.dll:0x63df6e 注册的 JS API
  -> 0x643de0                           // JS 包装：把状态字符串转成 JS 返回值
  -> 0x6323f0                           // 状态码 -> 字符串（jmp 跳转表）
  -> 0x632300                           // 计算状态码
       mov ecx, [0x152a92f8]            // 全局单例（静态初始化，jmp 自 0xb33ac5）
       mov ecx, [ecx + 0xb4]            // 取其成员
       call 0x6cc520                    // ★ 在 SO 缓存里按键查找条目
       cmp [eax + 0x18], 5
       ...
```

状态码到字符串的映射（跳转表 case）：

跳转表在 **RVA `0x632448`**，实测索引 0..6 依次是：

| 码 | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|
| 字符串 | `none` | `not_identifying` | `awaiting_cooldown` | `eligible` | `eligible_with_takeover` | **`elevated`** | `account_cooldown` |

> **更正**：这里原先写的是 1..6 =
> `not_identifying / awaiting_cooldown / account_cooldown / eligible /
> eligible_with_takeover / elevated` —— **3~6 的顺序错了**，`5` 才是 `elevated`
> （正因如此 `0x632300` 里 `cmp obj[+0x18], 5 ; mov eax, 5` 才自洽）。

**关键在 `0x6cc520` —— 它是在 SO 缓存里按键查找条目：**

```asm
6cc533  mov eax, [esi + 0x10]      ; 缓存数组基址
6cc536  mov [ebp-4], 7             ; ★ 查找 key = 7
6cc559  cmp [eax + 0x20], 7        ; 条目 type == 7
6cc563  cmp [eax + 0x18], 1        ; ★ 条目的标志位，必须 == 1
6cc569  mov eax, [eax + 4]         ; 条目 -> 对象槽
6cc56d  mov eax, [eax]             ; 槽 -> 真正的对象
```

> ⚠️ **别把两个 `+0x18` 搞混**：`0x6cc520` 里的 `[eax+0x18]` 是**缓存条目**的标志位
> （要求 `== 1`）；而 `0x632300` 紧接着在**返回的对象**上做的
> `cmp [eax+0x18], 5` 是 `elevated_state`（要求 `== 5`）。
> `0x6cc520` 返回的是 `*(entry[+4])`，即对象本身，两者是不同结构上的同偏移字段。

**key = 7 正是 SO 类型里的 `CSOEconGameAccountClient`** —— 所以
`GetElevatedState()` 的确是**从 SO 缓存读 type 7 的对象**，GC 侧这条方向从一开始就是对的。

当时以为"缺的是最后一步：客户端要求该条目 `[+0x18] == 1`，我们没把这个条目标记成有效"。
**这个推断是错的**：`entry[+0x18]` 是客户端自己挂缓存时置的，不需要 GC 做任何事。
真正缺的是**缓存压根没挂上**（host `+0xB4 == NULL`）。

> **更正（2026-09-28 晚）**：缓存挂上之后 `entry[+0x18] == 1` 与 `obj[+0x18] == 5`
> **本来就是满足的**（实测 `type 7 / flag=1 / obj[+0x18]=5`），所以那条
> "看谁往 `[+0x18]` 写 1"的线索是死路。`peek_socache.py` 可直接读出这一行来。

**两条路**（当时的判断）：
1. 补上"让条目变为有效"的那一步（若它由 GC 侧的某个消息驱动，就能真正从 GC 生效）
2. 或者 csgc.dll hook `0x632300` / `0x6cc520`，直接返回 `elevated`

**结果：第 1 条才对**，而且障碍比预想的小得多 —— 不是"条目有效性"，是 `owner_soid` 写错了。

### ★ 真正的根因与解法（2026-09-28 晚）

`gc/Server_v3.js` 的 `getMSGdata()` 把帧头里的 SteamID64 截成了 accountId
（`steamId & 0xFFFFFFFFn`）再交给**所有**事件处理器，`buildEconSOCache()` 于是把它
当成 `ownerSoid.id` 下发。而客户端拿 `owner_soid` 去匹配**本地玩家自己的 SOID** ——
那个值（`[client.dll+0x52A92F8]` 宿主对象的 `+0x08`）实测是
`{ id: <你的 SteamID64>, type: 1 }`，是带 `0x01100001` 高位的 64 位数。
**id 少了高 32 位 → 匹配不上 → 本地玩家的 SOCache 从来没挂上。**

修法：加一个幂等的 `toSteamId64(id)`，`ownerSoid.id` 走它（共 3 处）。

修完后实测：`[host+0xB4]` 从 `NULL` 变成有效指针，条目达到
`type 7 / flag=1 / obj[+0x18]=5`，**native `GetElevatedState()` 自己就返回 `"elevated"`**
—— 不需要任何客户端 hook、不需要改 `code.pbin`。

反证：csgc 日志里 `[GC] SendMessage: type=0x8000238F, ..., steamId=<你的 SteamID64>`
—— SteamID64 本来就在帧头里，是 GC 自己丢掉的高位。

### 已退役的解法（历史，保留可回退）

第 2 条当时也走通了，但突破点不是当初设想的 `0x632300` —— 它有个 `cmp eax, 5`
的第二调用者 `0x59cf05`，动不得。真正的入口是它的姊妹函数 **`+0x6323F0`**：
全二进制**唯一调用者 `0x643de9`**，正是 `GetElevatedState` 的 JS 包装。

> **状态：已退役。** 修好 `owner_soid` 后 native 自己就对，这两个 hook 的返回值与 native
> 完全一致（纯冗余，还会掩盖 GC 侧将来的回归），已从 `InstallSteamHooks()` 里摘掉
> —— `csgc-src/src/steam_hook_lite.cpp` 里 `kEnableNativePrimeHook = false`，
> 代码保留，改成 `true` 重新编译即可回退。

| 目标 | RVA | 做法 |
|---|---|---|
| 状态码 → 字符串 | `+0x6323F0` | 返回 `client.dll+0xC76088`（客户端自己的 `"elevated"` 字面量） |
| 本地玩家 Prime 判定 | `+0x632370` | 返回 `true` |

`+0x632370` 是两条同名 `GetFriendPrimeEligible`（`PartyListAPI` /
`FriendsListAPI`）**本地玩家分支的共同尾调用目标**，所以一个 hook 就覆盖了
两种 API；而「其他玩家」路径在到达它之前就已经分叉走了，完全不受影响。

实测日志：

```
[PRIME] GetElevatedState: "none" -> "elevated"
[PRIME] local-player prime predicate -> true
```

`"none"` 是 **native 的真实返回值** —— 这正是自制 GC 环境下优先状态全错的
直接原因，也证明覆盖点抓准了。

**完整分析、代码与集成步骤见 [`csgc-hook/`](csgc-hook/)。** 采用之后
`client/party.js` 保持原样即可，`code.pbin` 不再需要任何修改。

## 选图 → 游戏服务器切图

优先级状态修好之后，还差一环：**在比赛设置里选的图，要真的落到游戏服务器上**。

客户端选图的信息**不会**传给 GC（9101 的 proto 里没有地图字段、`lobby_id` 恒为 0、
lobby API 从未被调用），UI 侧那条链又全程是 V8，native 层没有切入点。所以改用
**外部指定**：往 `server_map.txt` 写地图名，GC 轮询到就让 srcds 切图，客户端会自动跟随。

**完整说明、`srvcmd.sh` 和两个实测踩过的坑（`echo > /dev/pts/N` 不是发送命令、
veto 自动换图为何做不到）见 [`map-sync/`](map-sync/)。**

（附带发现：`0x632300` 里有一条 `-perfectworld` / `-forceperfectworld` 分支 ——
中国版客户端的 elevated 判定走的是另一套逻辑。若将来要处理中国版，需另做分析。）
- **弹窗的每秒 beep 未实现**。官方逻辑是「倒计时在走且没人按接受」时每秒播
  `popup_accept_match_beep`；而 `@` 公告式路径会把 `m_hasPressedAccept` 置真，
  两者互斥 —— 复刻 beep 就得放弃官方精简形态与关闭路径，判定不值得做。

## LICENSE

GNU GPL 3.0。

本项目是 [CSGO-GC-Replacement](https://github.com/aka3257/CSGO-GC-Replacement)
（作者 aka3257，GPL 3.0）的衍生作品，`gc/Server_v3.js` 基于其 `Server_v3.js` 修改。
