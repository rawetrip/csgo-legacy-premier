# csgc.dll 侧的 native Prime 修复

> ## ⚠️ 已退役（2026-09-28 晚）—— 先看这段再往下读
>
> **这份文档的核心结论「native 本来就返回 `none`、与 GC 下发的 SO 缓存无关」是错的。**
> 真正的根因在 GC 侧：`Server_v3.js` 把 SO 缓存的 `owner_soid.id` 发成了 accountId
> 而不是 SteamID64，客户端匹配不上本地玩家自己的 SOID，**本地玩家的 SOCache 从来没挂上**
> （host `+0xB4` 恒为 NULL），native 才只能返回 `"none"`。
>
> 修好 `owner_soid` 后，native `GetElevatedState()` 自己就返回 `"elevated"`，
> 本地玩家 Prime 判定也自己返回 `true` —— **这两个 hook 的返回值和 native 完全一致，
> 属于纯冗余**，只会掩盖 GC 侧将来的回归。因此已从 `InstallSteamHooks()` 里摘掉
> （`kEnableNativePrimeHook = false`，代码保留可回退），重新编译后二进制里已无这两个 hook。
>
> **下面关于 RVA / 调用链 / funchook 坑的内容仍然有效**，是值得留的逆向结论；
> 但凡是说「必须 hook 客户端才能修好 Prime」的地方，都已被推翻。
> 现状以 `csgo-prime-handoff.md` 为准。

> 2026-09-28 完成。这一层让「优先状态」在**原生层**生效，
> 从此不再需要在 `code.pbin` 里 patch `party.js`。

## 与 `client/party.js` 的关系

| | `client/party.js`（旧方案） | 本目录（新方案） |
|---|---|---|
| 做法 | 在 JS 层 monkey patch 三个 API | 在 `client.dll` 里 hook 两个函数 |
| 位置 | `code.pbin` → `panorama/scripts/party.js` | `csgc.dll` → `steam_hook_lite.cpp` |
| 风险 | 改游戏资源包，每次游戏更新/校验都可能被覆盖 | 只改进程内存，不动任何游戏文件 |
| 粒度 | 只对本地 xuid 返回 true | 同样只对本地玩家生效 |

**两者只需其一。** 采用本方案后 `party.js` 保持原样即可
（`code.pbin` 里应当是 13497 字节的原始版本）。

## 两个 hook 点

全部 RVA 基于 2026-09-26 的 `client.dll`（16,377,192 字节）。

### 1. `client.dll + 0x6323F0` —— `MyPersonaAPI.GetElevatedState()`

```
GetElevatedState()                // client.dll:0x63df6e 注册的 JS API
  -> 0x643de0                     // JS 包装：把 C 字符串转成 JS 返回值
  -> 0x6323f0                     // ★ 状态码 -> 字符串（唯一调用者 0x643de9）
  -> 0x632300                     // 算状态码（读 SO 缓存 key=7）
```

`0x6323f0` 的全部调用者**只有 `0x643de9` 一处**，且没有任何函数指针表引用它
（全二进制扫 `call rel32` + `imm32` 均为空）。它是纯粹的「状态码 → 字符串」转换：

```asm
6323f0  push esi
6323f1  mov  esi, 0x10bb7c94        ; 默认串 "none"
6323f6  call 0x632300               ; 状态码 0..6
6323fb  cmp  eax, 6
6323fe  ja   0x632442               ; > 6 走 "none"
632400  jmp  dword ptr [eax*4 + 0x10632448]
```

跳转表在 **RVA `0x632448`**，索引 0..6 实测依次映射到
`none` / `not_identifying` / `awaiting_cooldown` / `eligible` /
`eligible_with_takeover` / **`elevated`** / `account_cooldown`。

> **更正**：这里原先写的是 1..6 =
> `not_identifying / awaiting_cooldown / account_cooldown / eligible /
> eligible_with_takeover / elevated` —— **3~6 的顺序错了**。实测 **`5` 才是 `elevated`**
> （所以 `0x632300` 里 `cmp obj[+0x18], 5 ; mov eax, 5` 是自洽的）。

**客户端完整支持状态码 6**（表里就有那一格和对应字符串常量），
所以直接返回 6 对应的字符串是表内合法值，不会越界。

hook 后返回 `client.dll + 0xC76088` —— 即客户端**自己的** `"elevated"`
字面量，而不是我们造的字符串，因此返回值与原生值不可区分。

> 姊妹函数 `0x632300` 有第二个调用者 `0x59cf05`，它做 `cmp eax, 5 ; jne 跳过`
> 严格依赖 `== 5`。**所以不能 hook `0x632300`** —— 会扰动那条埋点路径。
> hook `0x6323f0` 则完全绕开它。

### 2. `client.dll + 0x632370` —— 本地玩家的 Prime 判定

CS:GO 有**两个同名**的 `GetFriendPrimeEligible`，各自是一条 V8 回调链：

```
PartyListAPI.GetFriendPrimeEligible  (比赛设置 / 段位门槛)
  +0x5a4420 (V8 FunctionCallback) -> +0x5a6f30
      本地玩家  +0x59bf8e : call 0x632370 ; ret 4    ← 尾调用
      其他玩家  +0x59bfb4 : ... -> +0x6593f0

FriendsListAPI.GetFriendPrimeEligible  (玩家卡片)
  +0x65d520 (V8 FunctionCallback) -> +0x65fef0
      本地玩家  +0x65946a : call 0x632370 ; ret 4    ← 尾调用
      其他玩家  +0x659490 : ...
```

`+0x5a6f30` 与 `+0x65fef0` 是**逐字节相同的双胞胎**：调用真正的判定函数拿到
`al`，再把结果对应的 V8 值写进回调的 `return_value_`：

```asm
; 取 V8 root table，+0x4c 是 true 单例，+0x50 是 false 单例
call dword ptr [edx + 0x204]
lea  ecx, [eax + 0x4c]
lea  ecx, [eax + 0x50]        ; test bl,bl / jne 之后走这支
mov  eax, [esi]               ; info->implicit_args_
mov  [eax + 0xc], ecx         ; 写回 return_value_
```

**关键：两条链路的本地玩家分支都是对 `+0x632370` 的尾调用。**

`+0x632370` 就是游戏自己的「本地玩家是否 Prime」判定器 —— 读 SO 缓存
type 7 并测试 `entry[+0x18] == 5`，返回 `al`（bool）。
（`+0x533479c` 那个全局只是个「已初始化」标志，`0x59bf9c` / `0x659478`
会把它清零，但结论始终来自 `0x632370`。）

**所以只 hook 它一个，就同时覆盖两条 API 的本地玩家，而每一个
「其他玩家」路径在到达它之前就已经分叉走了 —— 一律不受影响。**
反过来，如果去 hook `0x59bf10` / `0x6593f0`，会让大厅里**所有人**都读作 Prime。

`0x632370` 无栈参数、以裸 `ret` 结束（即 cdecl 无参、返回 bool），
序言 `mov ecx,[0x152a92f8]` 有 6 字节，够 funchook 写 jmp。
它与 `0x6323f0` 不共用任何代码，两个 hook 互不干扰。

## 集成步骤

把 [prime_hook.cpp](prime_hook.cpp) 的内容追加进 `src/steam_hook_lite.cpp`
（放在 `InstallSteamHooks()` 之前），再做两处改动：

**1. `HookFunction()` 必须容忍 `bridge == nullptr`**

```cpp
    if (bridge) *bridge = temp;   // 原来是无条件 *bridge = temp;
    GCLog("[HOOK] Hooked %s\n", name);
```

新方案的两个 hook 都不需要调用原函数，所以传 `nullptr`。
不改这一行的话，`funchook_install` 成功之后会**立刻空指针崩溃**（已实测）。

**2. `InstallSteamHooks()` 开头调用 `EnsurePrimeElevationHook()`**

```cpp
void InstallSteamHooks()
{
    GCLog("[HOOK] === InstallSteamHooks started ===\n");

    EnsurePrimeElevationHook();       // ← 新增

    HMODULE steamclient = GetModuleHandleA("steamclient.dll");
    ...
```

## 为什么需要轮询等待

`InstallGC(false)` 由 launcher 在**加载游戏本体之前**调用，
所以那一刻 `client.dll` 还不存在。实测日志：

```
[PRIME] client.dll not loaded yet, spawning waiter thread...
[PRIME] client.dll appeared after 3900 ms
```

`EnsurePrimeElevationHook()` 因此会起一个线程最多等 120 秒。

## 验证

启动游戏后，`csgc_full.log`（在 csgo.exe 同级目录）应出现：

```
[PRIME] client.dll appeared after 3900 ms
[HOOK] Hooked GetElevatedState_CodeToString
[PRIME] elevation hook live: client.dll+0x6323f0 returns "elevated" (literal at client.dll+0xc76088)
[HOOK] Hooked LocalPlayerIsPrime
[PRIME] local-player prime hook installed (client.dll+0x632370)
```

进入 UI 触发 JS 调用后，会看到那一行：

```
[PRIME] GetElevatedState: "none" -> "elevated"
[PRIME] local-player prime predicate -> true
```

`"none" -> "elevated"` 里的 `"none"` 是 **native 的真实返回值** —— 当时以为
「这就是根因、native 路径本身走不通」。**错了**：`"none"` 只是症状，根因是 GC 下发的
`owner_soid` 写错、SO 缓存从未挂上（见文件开头的退役说明）。

**（已退役，保留作参考）** 注意这条 hook 只在「native 值 ≠ `elevated`」时才打印，
所以修好 `owner_soid` 之后**日志反而会变安静** —— 一句话都不打才是好消息。

## 安全性

- 两个 hook 点都经过全二进制扫描确认调用面：`0x6323f0` 唯一调用者，
  `0x632370` 的 8 个调用者全部位于 Prime 相关链路内（另 4 处分别把结果
  写进 UI 对象的 `+0x14` / `+0x10`，语义一致）。
- `0x6323f0` 的 hook 在安装前会校验 `client.dll + 0xC76088` 处确实是
  `"elevated"` 字面量；不匹配（换版本）则**拒绝安装**，行为退回原生。
- 只改进程内存，不触碰任何游戏文件。

## 已知的坑

| 现象 | 原因 |
|---|---|
| 游戏启动即闪退，日志停在 `HookFunction` 成功之后 | `bridge == nullptr` 时 `*bridge = temp` 空指针解引用 |
| `[PRIME] client.dll not loaded` | `InstallGC` 早于游戏模块加载，需轮询 |
| hook 装上但日志无调用记录 | `party.js` 的 JS patch 仍在，native 函数根本不会被调用 —— 必须还原 |

## 附带发现

- `0x632300` 里有一条 `-perfectworld` / `-forceperfectworld` 分支，
  中国版客户端的 elevated 判定走另一套逻辑。若将来要处理中国版需另做分析。
- V8 的 `FunctionCallbackInfo` 在 32 位下的布局（由 `0x5a6f30` 反汇编印证）：
  `+0x00 implicit_args_` / `+0x04 values_` / `+0x08 length_` / `+0x0C return_value_`。
