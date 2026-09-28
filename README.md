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

### 客户端侧 —— `client/party.js`

Monkey patch 三个 native API，**只对本地玩家**返回优先：

- `MyPersonaAPI.GetElevatedState()` → `'elevated'`
- `PartyListAPI.GetFriendPrimeEligible()`
- `FriendsListAPI.GetFriendPrimeEligible()`

> 注意这里有个坑：CS:GO 里有**两个**同名的 `GetFriendPrimeEligible`。
> 比赛设置面板走 `PartyListAPI`，而玩家卡片（`playercard.js` 的 `_IsPlayerPrime`）
> 走的是 `FriendsListAPI` —— 只 patch 一个会出现「一半变对、一半没变」的分裂状态。

好友的 Prime 状态保持真实，不会被误标成优先。

## 使用

### GC

```bash
cp gc/Server_v3.js <你的 gc-replacement>/Server_v3.js
cp gc/config.example.json <你的 gc-replacement>/config.json
# 然后编辑 config.json：填 matchServerIp 与 accountId
node Server_v3.js
```

### 客户端

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

## 未解决

- **`MyPersonaAPI.GetElevatedState()` 的数据来源未能最终定位。**
  SO 缓存这个方向是对的（`CsgoWelcome` 的字段构成 —— `bonus_xp_usedflags` /
  `elevated_state` / `items` —— 指向 `CSOEconGameAccountClient` + 库存），
  但客户端收下数据后没有据此更新状态。若将来要回到「从根上解决」，
  可以从客户端接受 SO 缓存的时机、version 校验、或 owner_soid 匹配入手。
- **弹窗的每秒 beep 未实现**。官方逻辑是「倒计时在走且没人按接受」时每秒播
  `popup_accept_match_beep`；而 `@` 公告式路径会把 `m_hasPressedAccept` 置真，
  两者互斥 —— 复刻 beep 就得放弃官方精简形态与关闭路径，判定不值得做。

## LICENSE

GNU GPL 3.0。

本项目是 [CSGO-GC-Replacement](https://github.com/aka3257/CSGO-GC-Replacement)
（作者 aka3257，GPL 3.0）的衍生作品，`gc/Server_v3.js` 基于其 `Server_v3.js` 修改。
