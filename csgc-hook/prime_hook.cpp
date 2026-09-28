// ===========================================================================
// CS:GO Legacy -- native Prime fix for csgc.dll
// ---------------------------------------------------------------------------
// Drop-in code for src/steam_hook_lite.cpp. Requires two things already
// present in that file: HookFunction() (funchook wrapper) and GCLog().
//
// Two additions to existing code are also required -- see csgc-hook/README.md:
//   1. HookFunction(): guard the bridge out-param  (`if (bridge) *bridge = ...`)
//   2. InstallSteamHooks(): call EnsurePrimeElevationHook() at the top
//
// All RVAs below are for the CS:GO Legacy client.dll shipped 2026-09-26
// (16,377,192 bytes). Verify before trusting: the file checks that the
// "elevated" literal really sits at +0xC76088 and refuses to install if not.
// ===========================================================================

// 10. client.dll -- force MyPersonaAPI.GetElevatedState() to report "elevated"
// ============================================================================
// client.dll!0x6323f0 turns the prime-elevated state code into its string form:
//     6323f0  push esi
//     6323f1  mov  esi, 0x10bb7c94                   ; default "none"
//     6323f6  call 0x632300                          ; code = 0..6
//     6323fb  cmp  eax, 6 / ja default / jmp [eax*4 + 0x10632448]
// The jump table maps 1..6 to not_identifying / awaiting_cooldown /
// account_cooldown / eligible / eligible_with_takeover / elevated.
//
// A whole-binary scan for `call rel32` targeting 0x6323f0 finds exactly ONE
// caller: 0x643de9, inside 0x643de0 -- the JS wrapper that turns the returned
// C string into the value handed back by MyPersonaAPI.GetElevatedState()
// (`mov edi, eax` / `test edi, edi` / fall back to a default literal).
// No function-pointer table references it (no imm32 hits anywhere).
//
// Note the sibling path: 0x632300 has a SECOND caller at 0x59cf05 doing
// `cmp eax, 5 ; jne skip`, so hooking 0x632300 would perturb that code path.
// Hooking 0x6323f0 instead leaves it completely untouched.
//
// We return client.dll's OWN "elevated" literal rather than a string of our
// own, so the value is indistinguishable from a native one; if the literal is
// not where we expect it (client.dll build differs), the hook is not installed
// at all and behaviour stays native.
static const uint32_t kRvaElevatedStateToString = 0x006323F0;
static const uint32_t kRvaElevatedLiteral       = 0x00C76088;   // "elevated"

typedef const char* (__cdecl *ElevatedStateToStringFn)(void);
static ElevatedStateToStringFn Og_ElevatedStateToString = nullptr;
static const char* g_elevatedLiteral = nullptr;

static const char* __cdecl Hk_ElevatedStateToString(void)
{
    const char* native = Og_ElevatedStateToString ? Og_ElevatedStateToString() : nullptr;
    if (!g_elevatedLiteral) return native;      // resolution failed -> stay native

    if (!native || strcmp(native, g_elevatedLiteral) != 0) {
        static LONG logged = 0;
        if (InterlockedIncrement(&logged) <= 20) {
            GCLog("[PRIME] GetElevatedState: \"%s\" -> \"elevated\"\n",
                  native ? native : "(null)");
        }
    }
    return g_elevatedLiteral;
}

// ---------------------------------------------------------------------------
// 10b. client.dll -- make the LOCAL player report as Prime
// ---------------------------------------------------------------------------
// CS:GO exposes TWO same-named JS APIs (documented in the prime handoff):
//   PartyListAPI.GetFriendPrimeEligible   -- matchmaking settings, rank gating
//   FriendsListAPI.GetFriendPrimeEligible -- player cards
// Both are V8 FunctionCallbacks registered via v8::FunctionTemplate::New, and
// both split into a local-player path and an other-players path:
//
//   PartyList   +0x5a4420 (V8 cb) -> +0x5a6f30
//                 local   +0x59bf8e : call 0x632370 ; ret 4     (tail call)
//                 others  +0x59bfb4 : ... -> +0x6593f0
//   FriendsList +0x65d520 (V8 cb) -> +0x65fef0
//                 local   +0x65946a : call 0x632370 ; ret 4     (tail call)
//                 others  +0x659490 : ...
//
// +0x632370 is the game's own "is the local player Prime?" predicate: it looks
// up SO type 7 and tests entry[+0x18] == 5, returning a bool in al. (The global
// at +0x533479c is merely an "already initialised" flag -- 0x59bf9c/0x659478
// clear it, but the verdict always comes from 0x632370 regardless.)
//
// Pinning that single predicate therefore covers the local player on BOTH APIs
// in one hook, while every other-player path -- which branches away before the
// call -- is left completely untouched. Hooking 0x59bf10/0x6593f0 instead would
// have forced every player in the lobby to read as Prime.
//
// 0x632370 takes no stack arguments and ends in a bare `ret`, i.e. plain cdecl
// returning bool, and its prologue (`mov ecx,[0x152a92f8]`, 6 bytes) has ample
// room for funchook. It shares no code with 0x6323f0, so the elevation hook
// above is unaffected.
static const uint32_t kRvaLocalPlayerIsPrime = 0x00632370;

static bool __cdecl Hk_LocalPlayerIsPrime(void)
{
    static LONG logged = 0;
    if (InterlockedIncrement(&logged) <= 8) {
        GCLog("[PRIME] local-player prime predicate -> true\n");
    }
    return true;
}

static void InstallPrimeEligibilityHooks(uintptr_t base)
{
    void* target = reinterpret_cast<void*>(base + kRvaLocalPlayerIsPrime);
    if (!HookFunction("LocalPlayerIsPrime", target,
                      (void*)Hk_LocalPlayerIsPrime, nullptr)) {
        GCLog("[PRIME] !! local-player prime hook failed\n");
        return;
    }
    GCLog("[PRIME] local-player prime hook installed (client.dll+%#x)\n",
          kRvaLocalPlayerIsPrime);
}

static void InstallPrimeElevationHook();
static void EnsurePrimeElevationHook();
static bool g_primeElevationHooked = false;

// InstallGC(false) runs BEFORE the game's own modules are loaded, so at that
// point client.dll does not exist yet (observed: "[PRIME] client.dll not
// loaded"). Poll for it instead of giving up.
static DWORD WINAPI WaitForClientDllThread(LPVOID)
{
    for (int i = 0; i < 1200; i++) {          // up to 120 s, 100 ms steps
        if (GetModuleHandleA("client.dll")) {
            GCLog("[PRIME] client.dll appeared after %d ms\n", i * 100);
            EnsurePrimeElevationHook();
            return 0;
        }
        Sleep(100);
    }
    GCLog("[PRIME] gave up waiting for client.dll after 120 s\n");
    return 1;
}

static void EnsurePrimeElevationHook()
{
    if (GetModuleHandleA("client.dll")) {
        InstallPrimeElevationHook();
    } else {
        GCLog("[PRIME] client.dll not loaded yet, spawning waiter thread...\n");
        CreateThread(nullptr, 0, WaitForClientDllThread, nullptr, 0, nullptr);
    }
}

static void InstallPrimeElevationHook()
{
    if (g_primeElevationHooked) return;

    HMODULE client = GetModuleHandleA("client.dll");
    if (!client) {
        GCLog("[PRIME] client.dll not loaded, cannot install elevation hook\n");
        return;
    }

    uintptr_t base = reinterpret_cast<uintptr_t>(client);
    const char* lit = reinterpret_cast<const char*>(base + kRvaElevatedLiteral);
    if (strncmp(lit, "elevated", 9) != 0) {
        GCLog("[PRIME] !! \"elevated\" literal not found at client.dll+%#x "
              "(got \"%.16s\") -- different client.dll build, hook NOT installed\n",
              kRvaElevatedLiteral, lit);
        return;
    }
    g_elevatedLiteral = lit;

    void* target = reinterpret_cast<void*>(base + kRvaElevatedStateToString);
    if (!HookFunction("GetElevatedState_CodeToString", target,
                      (void*)Hk_ElevatedStateToString,
                      (void**)&Og_ElevatedStateToString)) {
        GCLog("[PRIME] !! elevation hook install failed, behaviour stays native\n");
        g_elevatedLiteral = nullptr;
        return;
    }
    g_primeElevationHooked = true;
    GCLog("[PRIME] elevation hook live: client.dll+%#x returns \"%s\" "
          "(literal at client.dll+%#x)\n",
          kRvaElevatedStateToString, g_elevatedLiteral, kRvaElevatedLiteral);

    InstallPrimeEligibilityHooks(base);
}

