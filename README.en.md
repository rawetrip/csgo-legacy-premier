# CS:GO Legacy — Prime (Priority) Status Fix

> 中文原文见 [`README.md`](README.md)（Chinese original）。本文件是英文版，内容同步。

A patch set that makes the CS:GO Legacy client correctly display **Prime (priority) status**
when running a custom Game Coordinator
([CSGO-GC-Replacement](https://github.com/aka3257/CSGO-GC-Replacement)).

> ## ⚠️ Updated conclusion (2026-09-28 evening): fixing the GC is enough — the client needs no patch
>
> **In one line: the root cause is that the GC sent the SO cache's `owner_soid.id` as an
> accountId instead of a SteamID64.**
> The client could not match it against the local player's own SOID, so **the local player's
> SOCache never attached** (host `+0xB4` permanently NULL), and `GetElevatedState()` could only
> ever return `"none"`.
>
> After fixing `owner_soid` (`toSteamId64()` in `gc/Server_v3.js`), native returns `"elevated"`
> on its own — **neither the `csgc.dll` native hook nor the `client/party.js` JS patch is needed
> anymore**. Both hooks under `csgc-hook/` are retired (code kept for rollback; see the top of
> `csgc-hook/README.md`).
>
> Every paragraph below that assumes "the client-side API data source cannot be located, so we
> must bypass it" was **the conclusion at the time** and is kept for the record — the current
> answer is in "The real root cause and fix".

### Scope (important — read before filing issues)

| Dimension | Scope |
|---|---|
| **Server** | **Linux `srcds` only.** `map-sync/srvfix.c` hardcodes offsets into `engine.so` (32-bit ELF); Windows is not applicable |
| **Client build** | The **Operation Broken Fang** build |
| **Mode** | ★ **Only the Prime queue is implemented. Competitive/casual and other modes are not** |
| Hardcoded offsets | Based on the 2026-09-26 build (CS:GO is frozen, so this build is stable; other branches/regional builds need re-locating) |

## The problem

After replacing the official GC with a custom one, the client UI renders everything as a
"non-Prime account":

- Main menu shows an "Get Prime" button instead of the Prime toggle
- Match settings panel shows "Non-prime account player"
- Player cards show "Unfreeze your rank with Prime"
- A "Upgrade to Prime to unlock your rank" prompt hangs on the right

Matchmaking itself works fine (searches, connects, re-queues); only the Prime-related UI is wrong.

## Root cause

### GC side

**1. SO cache fields were named in snake_case**

`Server_v3.js` built the SO cache with keys like `type_id` / `object_data` / `owner_soid`, but
protobufjs converts proto field names to camelCase (`typeId` / `objectData` / `ownerSoid`) by
default, and `create()` / `fromObject()` **silently ignore** unknown keys — so the client
received an empty object and never got any econ account data at all.

**2. SO cache refresh requests went unanswered**

After receiving `outofdate_subscribed_caches`, the client replies with
`CMsgSOCacheSubscriptionRefresh` (message **28**) to ask for fresh data. The GC had not
registered that message — visible in the log as `[ERROR] Unknown message` — so the client never
got data.

**3. Wrong SO type number and value**

- SO type `1` is `CSOEconItem`; `CSOEconGameAccountClient` is **`7`**
- `elevated_state` value **`5`** means "has purchased Prime", not `1`

### Client side

Even with the GC sending correct data (`CSOEconGameAccountClient` type 7 / `elevated_state=5`,
`CSOPersonaDataPublic` type 2) and the client demonstrably receiving it (it stopped re-requesting
a refresh), `MyPersonaAPI.GetElevatedState()` still did not return `elevated`.

The data source for that API could not be located at the time, so the workaround was to bypass
it at the client API layer.

> **The above was the conclusion at the time and has since been refuted (2026-09-28 evening).**
> The data source was located: it is the type 7 object in the SO cache, and the client reads
> `obj[+0x18] == 5`. It was not failing because the API was a dead end, but because **the SO cache
> was never attached to the local player at all** — `owner_soid.id` was sent as an accountId.
> The field-name fix (snake_case → camelCase) was correct, but only solved half the problem.
> See "The real root cause and fix".

## What was changed

### GC side — `gc/Server_v3.js`

| Location | Change |
|---|---|
| `buildEconSOCache()` | field names snake_case → camelCase; populate `CSOEconGameAccountClient` (type 7, `elevated_state=5`) and `CSOPersonaDataPublic` (type 2) |
| `IDict` | register message 28 |
| `CMsgSOCacheSubscriptionRefresh` handler | added; replies with `CMsgSOCacheSubscribed` (24) |
| `CMsgGCCStrike15_v2_MatchmakingStart` handler | parse and log the client-reported `prime_only` (previously discarded) |
| `CMsgGCCStrike15_v2_MatchmakingStop`'s 9104 | drop `notes:[{ prime: true }]` (the proto's `Note` has no such field), use `[{}]` |

### Client side — two options, pick one

**Option A (recommended): the native fix in [`csgc-hook/`](csgc-hook/)**

`csgc.dll` hooks two functions in `client.dll` directly and **modifies no game files**.

**Option B (old): the JS patch in `client/party.js`**

Monkey-patches three native APIs to return Prime **for the local player only**:

- `MyPersonaAPI.GetElevatedState()` → `'elevated'`
- `PartyListAPI.GetFriendPrimeEligible()`
- `FriendsListAPI.GetFriendPrimeEligible()`

> A trap here: CS:GO has **two** identically named `GetFriendPrimeEligible`. The match settings
> panel goes through `PartyListAPI`, while player cards (`_IsPlayerPrime` in `playercard.js`) go
> through `FriendsListAPI` — patching only one produces a split state where "half the UI is fixed
> and half is not".

Friends' Prime status stays truthful and is never mislabeled as Prime.

> ⚠️ Do **not** use both options together. The JS patch replaces the native functions wholesale at
> the JS layer, so csgc's hook will never be called — you will see no logs even though it is
> installed.

## Usage

### GC

```bash
cp gc/Server_v3.js <your gc-replacement>/Server_v3.js
cp gc/config.example.json <your gc-replacement>/config.json
# then edit config.json: fill in matchServerIp and accountId
node Server_v3.js
```

**Verify `owner_soid` first — this is the crux of the whole thing.** Put `gc/verify-socache.js`
into your `gc-replacement/` directory (which has `./proto`), then:

```bash
node verify-socache.js <your SteamID64>
```

The `ownerSoid.id` it prints must be a **full SteamID64** (`7656119…`), not an accountId. If it
is the latter, the client will never attach the SO cache to the local player, and
`GetElevatedState()` will forever return `"none"` — the entire Prime UI renders as non-Prime.

### Client

**Option A: the csgc.dll native fix (recommended)**

Merge [`csgc-hook/prime_hook.cpp`](csgc-hook/prime_hook.cpp) into
`csgc-src/src/steam_hook_lite.cpp`, rebuild, and deploy `csgc.dll`. Full steps (including two
required modifications) are in [`csgc-hook/README.md`](csgc-hook/README.md).
**`code.pbin` needs no changes at all.**

**Option B: pbin patch**

`client/party.js` must be written into `csgo/panorama/code.pbin` as
`panorama/scripts/party.js`.

**The game must be closed while editing** — it reads resources into memory at startup, so
editing with the game running has no effect.

Always read back and verify after installing:

```bash
# write
pbin_tool.py put panorama/scripts/party.js client/party.js
# read back and byte-compare against the source
pbin_tool.py get panorama/scripts/party.js /tmp/readback.js
cmp /tmp/readback.js client/party.js
```

## Verification

After installing, launch the game and check these places flip over:

| Location | Before | After |
|---|---|---|
| Match settings panel | Non-prime account player | Prime matchmaking only (an extra "rank matchmaking" row) |
| Player card rank | Unfreeze your rank with Prime | Rank hidden / normal rank |
| Right-hand panel | Upgrade to Prime | gone |

The game console should show the patch load logs:

```
[csgc] GetElevatedState patched (direct assign)
[csgc] PartyListAPI.GetFriendPrimeEligible patched
[csgc] FriendsListAPI.GetFriendPrimeEligible patched
```

If it prints `patch FAILED`, the native API object is read-only and you need to modify the call
site directly instead.

**Option A verification** is via `csgc_full.log` (next to `csgo.exe`):

```
[PRIME] client.dll appeared after 3900 ms
[PRIME] elevation hook live: client.dll+0x6323f0 returns "elevated" (literal at client.dll+0xc76088)
[PRIME] local-player prime hook installed (client.dll+0x632370)
[PRIME] GetElevatedState: "none" -> "elevated"
[PRIME] local-player prime predicate -> true
```

## The full "fix it at the root" process (including the intermediate conclusions that were refuted)

The call chain of `MyPersonaAPI.GetElevatedState()`:

```
GetElevatedState()                      // JS API registered at client.dll:0x63df6e
  -> 0x643de0                           // JS wrapper: converts status string to a JS return value
  -> 0x6323f0                           // status code -> string (jmp table)
  -> 0x632300                           // computes the status code
       mov ecx, [0x152a92f8]            // global singleton (static init, jmp from 0xb33ac5)
       mov ecx, [ecx + 0xb4]            // take its member
       call 0x6cc520                    // ★ look up an entry by key in the SO cache
       cmp [eax + 0x18], 5
       ...
```

Status code to string mapping (jump table cases):

The jump table is at **RVA `0x632448`**; measured, indices 0..6 are:

| Code | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|
| String | `none` | `not_identifying` | `awaiting_cooldown` | `eligible` | `eligible_with_takeover` | **`elevated`** | `account_cooldown` |

> **Correction**: this previously read 1..6 =
> `not_identifying / awaiting_cooldown / account_cooldown / eligible /
> eligible_with_takeover / elevated` — **the order of 3~6 was wrong**; `5` is `elevated`
> (which is exactly why `cmp obj[+0x18], 5 ; mov eax, 5` inside `0x632300` is self-consistent).

**The key is `0x6cc520` — it looks up an entry by key in the SO cache:**

```asm
6cc533  mov eax, [esi + 0x10]      ; cache array base
6cc536  mov [ebp-4], 7             ; ★ lookup key = 7
6cc559  cmp [eax + 0x20], 7        ; entry type == 7
6cc563  cmp [eax + 0x18], 1        ; ★ the entry's flag, must == 1
6cc569  mov eax, [eax + 4]         ; entry -> object slot
6cc56d  mov eax, [eax]             ; slot -> the actual object
```

> ⚠️ **Do not confuse the two `+0x18`s**: `[eax+0x18]` inside `0x6cc520` is the **cache entry's**
> flag (must be `== 1`), whereas the `cmp [eax+0x18], 5` that `0x632300` then performs on the
> **returned object** is `elevated_state` (must be `== 5`). `0x6cc520` returns `*(entry[+4])`,
> i.e. the object itself — they are the same offset on two different structures.

**key = 7 is exactly `CSOEconGameAccountClient` among the SO types** — so `GetElevatedState()`
really does **read the type 7 object from the SO cache**, and the GC-side direction was correct
from the start.

At the time we thought "the missing last step is that the client requires that entry's
`[+0x18] == 1`, and we are not marking the entry valid". **That inference was wrong**:
`entry[+0x18]` is set by the client itself when it attaches the cache, and the GC needs to do
nothing about it. What was actually missing was that **the cache was never attached at all**
(host `+0xB4 == NULL`).

> **Correction (2026-09-28 evening)**: once the cache is attached, `entry[+0x18] == 1` and
> `obj[+0x18] == 5` **are already satisfied** (measured: `type 7 / flag=1 / obj[+0x18]=5`), so
> that "find who writes 1 into `[+0x18]`" lead was a dead end. `peek_socache.py` can read this
> row directly.

**Two paths** (the judgement at the time):
1. Supply the step that "makes the entry valid" (if it is driven by some GC-side message, it
   could be fixed properly from the GC)
2. Or have csgc.dll hook `0x632300` / `0x6cc520` and return `elevated` directly

**Result: path 1 was right**, and the obstacle was far smaller than expected — it was not "entry
validity", it was a mis-encoded `owner_soid`.

### ★ The real root cause and fix (2026-09-28 evening)

`getMSGdata()` in `gc/Server_v3.js` truncated the SteamID64 from the frame header into an
accountId (`steamId & 0xFFFFFFFFn`) before handing it to **all** event handlers, so
`buildEconSOCache()` sent it down as `ownerSoid.id`. The client uses `owner_soid` to match
**against the local player's own SOID** — that value (the `+0x08` of the host object at
`[client.dll+0x52A92F8]`) measures as `{ id: <your SteamID64>, type: 1 }`, a 64-bit number
carrying the `0x01100001` high bits.
**With the high 32 bits missing it can never match → the local player's SOCache never attaches.**

Fix: add an idempotent `toSteamId64(id)` and route `ownerSoid.id` through it (3 call sites).

After the fix, measured: `[host+0xB4]` goes from `NULL` to a valid pointer, the entry reaches
`type 7 / flag=1 / obj[+0x18]=5`, and **native `GetElevatedState()` returns `"elevated"` on its
own** — no client hook, no `code.pbin` changes.

Counter-evidence: the csgc log shows `[GC] SendMessage: type=0x8000238F, ..., steamId=<your SteamID64>`
— the SteamID64 was in the frame header all along; the GC is what threw away the high bits.

### The retired solution (historical, kept for rollback)

Path 2 also worked at the time, but the breakthrough was not the `0x632300` originally assumed —
it has a second caller `0x59cf05` with a `cmp eax, 5` that must not be touched. The real entry
point is its sibling function **`+0x6323F0`**: the **only caller in the entire binary is
`0x643de9`**, which is exactly `GetElevatedState`'s JS wrapper.

> **Status: retired.** Once `owner_soid` is fixed, native is already correct, and these two hooks
> return values identical to native (pure redundancy, and they would mask future GC-side
> regressions). They have been removed from `InstallSteamHooks()` —
> `kEnableNativePrimeHook = false` in `csgc-src/src/steam_hook_lite.cpp`. The code is kept; flip
> it to `true` and rebuild to roll back.

| Target | RVA | Approach |
|---|---|---|
| status code → string | `+0x6323F0` | return `client.dll+0xC76088` (the client's own `"elevated"` literal) |
| local-player Prime predicate | `+0x632370` | return `true` |

`+0x632370` is the shared tail-call target of the **local-player branch** of both identically
named `GetFriendPrimeEligible` (`PartyListAPI` / `FriendsListAPI`), so one hook covers both APIs;
the "other players" path forks away before reaching it and is entirely unaffected.

Measured logs:

```
[PRIME] GetElevatedState: "none" -> "elevated"
[PRIME] local-player prime predicate -> true
```

`"none"` is the **true native return value** — precisely the direct cause of everything Prime
being wrong under a custom GC, and proof that the override point was correct.

**Full analysis, code and integration steps are in [`csgc-hook/`](csgc-hook/).** With it
applied, `client/party.js` can stay untouched and `code.pbin` needs no modification.

## Map selection → game server level change

Once Prime status is fixed, one link remains: **the map chosen in match settings must actually
reach the game server.**

The client's map selection is **not** communicated to the GC (9101's proto has no map field,
`lobby_id` is always 0, the lobby API is never called), and the UI chain is all V8 with no native
entry point. So the approach is **external specification**: write the map name into
`server_map.txt`; when the GC polls it, it tells srcds to change level, and the client follows
automatically.

**Full description, `srvcmd.sh`, and the two traps hit in testing (`echo > /dev/pts/N` is not a
way to send commands; why automatic veto level-change could not be done) are in [`map-sync/`](map-sync/).**

**Update**: this description is now **outdated**. Measurement showed the level change is performed
by the `Map veto pick controller` entity inside the server process itself, with no GC
involvement. See `v3` in [`csgo-legacy-matchmaking`](https://github.com/rawetrip/csgo-legacy-matchmaking).
The external `server_map.txt` route is downgraded to a manual fallback.

(Incidental finding: `0x632300` contains a `-perfectworld` / `-forceperfectworld` branch — the
Chinese client's elevated determination uses a different code path entirely. Handling the Chinese
client would require a separate analysis.)

- **The popup's per-second beep is not implemented.** The official logic plays
  `popup_accept_match_beep` every second while the countdown runs and nobody has accepted; the
  `@` announcement path sets `m_hasPressedAccept` true, and the two are mutually exclusive —
  reproducing the beep would mean giving up the official slim form and closing path. Judged not
  worth it.

## LICENSE

GNU GPL 3.0.

This project is a derivative work of [CSGO-GC-Replacement](https://github.com/aka3257/CSGO-GC-Replacement)
(author aka3257, GPL 3.0); `gc/Server_v3.js` is modified from its `Server_v3.js`.
