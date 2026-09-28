# CS:GO Legacy 优先（Prime）匹配修复

自建 GC（[CSGO-GC-Replacement](https://github.com/aka3257/CSGO-GC-Replacement)）环境下，
让 CS:GO Legacy 客户端正确显示「优先状态」的修复补丁集。

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

## 关于「从根上解决」：已完成（2026-09-28）

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

| 码 | 字符串 |
|---|---|
| 1 | `not_identifying` |
| 2 | `awaiting_cooldown` |
| 3 | `account_cooldown` |
| 4 | `eligible` |
| 5 | `eligible_with_takeover` |
| 6 | **`elevated`** |

**关键在 `0x6cc520` —— 它是在 SO 缓存里按键查找条目：**

```asm
6cc533  mov eax, [esi + 0x10]      ; 缓存数组基址
6cc536  mov [ebp-4], 7             ; ★ 查找 key = 7
6cc559  cmp [eax + 0x20], 7        ; 条目 type == 7
6cc563  cmp [eax + 0x18], 1        ; ★ 条目状态 == 1
```

**key = 7 正是 SO 类型里的 `CSOEconGameAccountClient`** —— 所以
`GetElevatedState()` 的确是**从 SO 缓存读 type 7 的对象**，GC 侧这条方向从一开始就是对的。

缺的是最后一步：客户端要求该条目 `[+0x18] == 1`。我们把对象下发过去了、客户端也收下了
（不再重复请求刷新），但很可能**没有把这个条目标记成有效**，于是查找落空、状态停在默认值。

> `[+0x18]` 的确切语义**尚未确认** —— 上面"条目状态"是我的推断，没有别的佐证。
> 也可能是别的标志位。继续查的方向：看谁往 `[+0x18]` 写 1。

**两条路**（当时的判断）：
1. 补上"让条目变为有效"的那一步（若它由 GC 侧的某个消息驱动，就能真正从 GC 生效）
2. 或者 csgc.dll hook `0x632300` / `0x6cc520`，直接返回 `elevated`

### 已完成的解法

第 2 条走通了，但突破点不是当初设想的 `0x632300` —— 它有个 `cmp eax, 5`
的第二调用者 `0x59cf05`，动不得。真正的入口是它的姊妹函数 **`+0x6323F0`**：
全二进制**唯一调用者 `0x643de9`**，正是 `GetElevatedState` 的 JS 包装。

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
