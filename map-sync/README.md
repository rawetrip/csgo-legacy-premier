# 选图 → 游戏服务器切图

让「在比赛设置里选的图」真正落到游戏服务器上。

## 为什么不用「读 UI 选图」

客户端选图的信息**不会**传给 GC：

- `CMsgGCCStrike15_v2_MatchmakingStart`(9101) 的 proto 里**没有地图字段**
  （只有 `account_ids/game_type/prime_only/lobby_id/tv_control`）
- `lobby_id` 恒为 **0**
- `ISteamMatchmaking` 的 lobby API（`SetLobbyData`/`GetLobbyData`）**一次都没被调用过**
- `gameType` 编码的是**游戏模式**（`0x02000008` 这类，byte0 恒为 0x08），不是地图

UI 侧那条链（`GameInterfaceAPI.SetSettingString` → `+0x5a8900` → `+0x5a7dd0` →
`+0x5a7c60` → `+0x5a7a60` → `+0x99f560`）**每层都是 V8 或哈希**，native 层没有稳定的
C 字符串切入点。挂观察钩子实测：`0x9a2cf0`（名字→id 注册表，173 个调用者）只命中
`ar_screenglow_*` 这类 UI 素材名；`0x5a7a60` **零命中**。

所以改成**外部指定**：

| 来源 | 文件 | 写入方 |
|---|---|---|
| 手写 | `<游戏目录>\server_map.txt` | 你直接写地图名（如 `de_inferno`） |
| veto | `<游戏目录>\veto_map.txt` | csgc hook `server.dll+0x3E16C7`，手动进 veto 定图时自动写 |

GC（`Server_v3.js` 的 `pollMapFiles()`）每 2 秒轮询这两个文件，检测到变化就切图。
`applyServerMap()` 里按地图名去重，重复写入不会反复切。

**注意**：两个文件都在轮询，**值不同会来回切**。测试时只留一个。

## 链路

```
写 server_map.txt  →  GC 轮询(2s)  →  srvcmd.sh 注入 srcds  →  srcds changelevel  →  客户端跟随
```

**客户端跟随服务器**——实测：GC 的 9107 里写 `de_cache`、服务器跑 `de_inferno`，
客户端进了 `de_inferno`。所以 **9107 的 `map` 字段不用管，切服务器就够了**。

## ⚠️ 最大的坑：`echo > /dev/pts/N` 不是发送命令

srcds 被 `script -q -f -c ... srcds_run` 包在伪终端里，`/proc/<pid>/fd/0 -> /dev/pts/N`，
stdin 指向是对的。**但写 `/dev/pts/N` 是往那个终端「输出」字符**（等价 `echo > /dev/tty`）：

- 命令会被显示
- 会被 `script(1)` 记进 `srcds-run.log`
- **看起来完全成功了**，实际根本没进 srcds 的 stdin

**必须用 `TIOCSTI` ioctl 逐字符注入**（`srvcmd.sh` 干的就是这个，需 `CAP_SYS_ADMIN`
故整个脚本用 sudo 跑；内核 5.15 无 `legacy_tiocsti` 开关，TIOCSTI 可用）。

**验证方式**：必须看命令的**执行结果**（例如 `status` 打印的 `map :` 行），
**不能只看日志里有没有那行字**——这个假象骗过一次，让「通道已验证」的结论提前了好几轮。

## 用法

```bash
# 切到 de_dust2
echo "de_dust2" > "<游戏目录>/server_map.txt"

# 验证服务器真的切了
py vmssh.py 'sudo ./srvcmd.sh "status"'
```

VM 侧需要一份 `srvcmd.sh`（本目录里那份就是），放在 `/home/csgo/`：

```bash
py vmscp.py srvcmd.sh srvcmd.sh
py vmssh.py "chmod +x srvcmd.sh"
```

## veto 自动换图：srvfix v2 双补丁（已打通）

原本「能进服」和「会换图」互斥（`sv_lan 1` 能进服但不触发换图、`sv_lan 0` 换图触发但
连接被 cookie 检查拒绝）。**srvfix v2 用两个补丁同时解决**，`srvfix.c` 就在本目录：

| 补丁 | 位置 | 做法 |
|---|---|---|
| **cookie 无条件放行** | `engine.so+0x1d07b0` | 把 `je 1d2790` 改成无条件 `jmp` |
| **换图只发生一次** | `engine.so+0x1d82f5+0x85` | 那条 `map <map> reserved` 改成 `jmp <stub>`，stub 里执行换图后清 `[CGameServer+0x288]` |

实测：`sv_lan 0` + srvfix v2 → **客户端正常进服、只连一次、无 retry**。

> ⚠️ `je rel32` 是 6 字节、`jmp rel32` 只有 5 字节，**rel32 必须重算**，照抄位移会跳进
> 指令中间（`csgo-legacy-matchmaking` 记过这个坑）。

**两个诊断陷阱**（排查时浪费最多时间的地方）：
1. `pgrep -f srcds_linux` 会匹配到执行它的 bash 自己 → 「进程在跑」是假象
2. `setsid nohup ... &` 在 SSH 里起不住 → 必须 `tmux new-session -d`

详细试错记录见 `../csgo-match-handoff.md` §6.5。

## 目录

```
srvcmd.sh      VM 侧脚本：TIOCSTI 注入一行命令到 srcds 控制台
vmssh.py       在 VM 里执行命令（paramiko + 密码）
```

> `vmssh.py` / `vmscp.py` 里的凭据是硬编码的，换机器要改开头常量。
