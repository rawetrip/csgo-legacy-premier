/*
 * srvfix.c — srcds 运行时补丁 v2（detour 版）
 *
 * 目标：让 srcds 的「按 reservation 换图」**只发生一次**，而不是每次客户端连接
 *       都重放一遍（那会导致 连上→重载关卡→被踢→重连→重载… 死循环）。
 *
 * ── 背景（v1 做了什么，为什么不够）────────────────────────────────────────
 *
 * engine.so 里那段「服务器已预留 → 直接开局」逻辑：
 *
 *   1d82f5  movzbl 0x288(%ebx),%eax     ; ebx = CGameServer，+0x288 = 「已预留」标志
 *   1d82fc  test   %al,%al
 *   1d82fe  je     1d7feb               ; 标志为 0 → 跳过整块
 *   ...
 *   1d837a  push   $0x2
 *   1d837c  call   1e7150               ; 执行 "map <map> reserved" → 重载关卡
 *
 * v1 的做法是把 1d837c 那条 call 直接 NOP 掉 —— **换图也就跟着没了**。
 *
 * ── v2 的做法 ─────────────────────────────────────────────────────────────
 *
 * 把 `push $2; call 1e7150`（7 字节）换成 `jmp <stub>`（5 字节 + 2 字节 NOP），
 * stub 在我们自己 mmap 出来的内存里：
 *
 *     push $2
 *     call <1e7150>              ; 真正执行换图（恢复 v1 砍掉的功能）
 *     mov  byte [ebx+0x288], 0   ; ★ 清「已预留」标志
 *     jmp  <site+7>              ; 回到原流程继续
 *
 * **第一次换图照常发生；标志被清零后，后续连接读到的就是 0 → 跳过整块 → 不再重放。**
 *
 * 注意 ebx 在这段里一直是 CGameServer（原代码 `0x288(%ebx)` / `0x10(%ebx)` 都用它），
 * stub 里不碰 ebx。
 *
 * 用法：LD_PRELOAD=/home/csgo/csgo_srvfix.so ./srcds_run ...
 * 构建：gcc -m32 -shared -fPIC -O2 -o csgo_srvfix.so srvfix.c -ldl
 * 关闭：环境变量 SRVFIX_OFF=1
 *
 * 本文件由我们自行编写，不加载任何第三方二进制。
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <link.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>

/* 25 字节签名：movzbl 0x288(%ebx),%eax / test %al,%al / je rel32 /
 *              mov (%ebx),%eax / mov 0x3c(%eax),%eax / cmp $vtbl,%eax
 * 其中两处 32 位立即数在装载时会被重定位（vtable 地址）或本就可变，
 * 用 MASK 排除掉，不做比对。 */
static const unsigned char SIG[25] = {
    0x0F, 0xB6, 0x83, 0x88, 0x02, 0x00, 0x00,   /* movzbl 0x288(%ebx),%eax */
    0x84, 0xC0,                                 /* test   %al,%al          */
    0x0F, 0x84, 0x00, 0x00, 0x00, 0x00,         /* je     rel32            */
    0x8B, 0x03,                                 /* mov    (%ebx),%eax      */
    0x8B, 0x40, 0x3C,                           /* mov    0x3c(%eax),%eax  */
    0x3D, 0x00, 0x00, 0x00, 0x00                /* cmp    $vtbl,%eax       */
};
static const unsigned char MASK[25] = {
    1, 1, 1, 1, 1, 1, 1,
    1, 1,
    1, 1, 0, 0, 0, 0,
    1, 1,
    1, 1, 1,
    1, 0, 0, 0, 0
};

#define JE_OFF   9      /* 签名内 "0F 84" 的位置 */
#define SITE_OFF 0x85   /* 锚点 → "push $2; call 1e7150" 的偏移 */
#define CALLREL_OFF 0x88 /* 锚点 → call 的 rel32 位置（= site + 3） */

static uintptr_t g_lo, g_hi;
static int g_done;

static int find_engine(struct dl_phdr_info *info, size_t sz, void *data)
{
    (void)sz; (void)data;
    if (!info->dlpi_name || !strstr(info->dlpi_name, "engine"))
        return 0;

    uintptr_t lo = (uintptr_t)-1, hi = 0;
    for (int i = 0; i < info->dlpi_phnum; i++) {
        const ElfW(Phdr) *ph = &info->dlpi_phdr[i];
        if (ph->p_type != PT_LOAD) continue;
        uintptr_t s = (uintptr_t)info->dlpi_addr + ph->p_vaddr;
        uintptr_t e = s + ph->p_memsz;
        if (s < lo) lo = s;
        if (e > hi) hi = e;
    }
    if (hi <= lo) return 0;

    g_lo = lo; g_hi = hi;
    fprintf(stderr, "[srvfix] 找到引擎 %s base=%p size=%#lx\n",
            info->dlpi_name, (void *)lo, (unsigned long)(hi - lo));
    return 1;
}

static int sig_match(const unsigned char *p)
{
    for (int i = 0; i < (int)sizeof(SIG); i++) {
        if (MASK[i] && p[i] != SIG[i]) return 0;
    }
    return 1;
}

static int make_writable(void *addr, size_t len)
{
    long pagesz = sysconf(_SC_PAGESIZE);
    uintptr_t pg = (uintptr_t)addr & ~((uintptr_t)pagesz - 1);
    size_t total = ((uintptr_t)addr + len) - pg;
    return mprotect((void *)pg, total, PROT_READ | PROT_WRITE | PROT_EXEC);
}

static int make_exec_only(void *addr, size_t len)
{
    long pagesz = sysconf(_SC_PAGESIZE);
    uintptr_t pg = (uintptr_t)addr & ~((uintptr_t)pagesz - 1);
    size_t total = ((uintptr_t)addr + len) - pg;
    return mprotect((void *)pg, total, PROT_READ | PROT_EXEC);
}

/* 返回 1 = 处理完毕（成功或确定放弃），0 = 引擎还没出现 */
static int try_patch(void)
{
    g_lo = g_hi = 0;
    dl_iterate_phdr(find_engine, NULL);
    if (!g_lo) return 0;

    uintptr_t hit = 0;
    int nhit = 0;
    for (uintptr_t a = g_lo; a + sizeof(SIG) <= g_hi; a++) {
        if (sig_match((const unsigned char *)a)) {
            if (!hit) hit = a;
            nhit++;
        }
    }
    if (!hit) return 0;
    fprintf(stderr, "[srvfix] 签名命中 %d 处，取第一处 %p\n", nhit, (void *)hit);

    unsigned char *je = (unsigned char *)(hit + JE_OFF);
    if (je[0] != 0x0F || je[1] != 0x84) {
        fprintf(stderr, "[srvfix] 意外：该处不是 6 字节 je（%02x %02x），放弃\n",
                je[0], je[1]);
        return 1;
    }

    /* 锚点即 1d82f5。第二个 "push $0x2; call 1e7150" —— 执行 "map <map> reserved"
     * 的地方 —— 固定在锚点 +0x85。 */
    unsigned char *site = (unsigned char *)(hit + SITE_OFF);
    if (site[0] != 0x6A || site[1] != 0x02 || site[2] != 0xE8) {
        fprintf(stderr, "[srvfix] 意外：锚点+0x85 不是 push $2; call（%02x %02x %02x），放弃\n",
                site[0], site[1], site[2]);
        return 1;
    }

    /* call 的目标地址（rel32 相对 call 指令末尾） */
    int32_t rel = *(int32_t *)(site + 3);
    uintptr_t target = (uintptr_t)(site + 7) + rel;      /* = 1e7150 */
    fprintf(stderr, "[srvfix] call 目标 %p\n", (void *)target);

    /* --- 分配 stub ---------------------------------------------------- */
    unsigned char *stub = mmap(NULL, 4096, PROT_READ | PROT_WRITE,
                               MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (stub == MAP_FAILED) {
        perror("[srvfix] mmap stub 失败");
        return 1;
    }

    unsigned char *w = stub;
    int32_t d;

    /* push $2 */
    *w++ = 0x6A; *w++ = 0x02;

    /* call <target>  —— e8 rel32，rel 相对下一条指令（= stub+7） */
    *w++ = 0xE8;
    d = (int32_t)((intptr_t)target - (intptr_t)(w + 4));
    memcpy(w, &d, 4); w += 4;

    /* mov byte ptr [ebx+0x288], 0   —— c6 83 88 02 00 00 00 */
    *w++ = 0xC6; *w++ = 0x83;
    *w++ = 0x88; *w++ = 0x02; *w++ = 0x00; *w++ = 0x00;
    *w++ = 0x00;

    /* jmp <site+7>  —— e9 rel32 */
    *w++ = 0xE9;
    d = (int32_t)((intptr_t)(site + 7) - (intptr_t)(w + 4));
    memcpy(w, &d, 4); w += 4;

    fprintf(stderr, "[srvfix] stub 位于 %p（%ld 字节）\n",
            (void *)stub, (long)(w - stub));
    __builtin___clear_cache((char *)stub, (char *)w);

    /* --- 把 site 处改成 jmp stub -------------------------------------- */
    if (make_writable(site, 7) != 0) {
        perror("[srvfix] mprotect(site) 失败");
        return 1;
    }

    unsigned char patch[7];
    patch[0] = 0xE9;                                    /* jmp rel32 */
    d = (int32_t)((intptr_t)stub - (intptr_t)(site + 5));
    memcpy(patch + 1, &d, 4);
    patch[5] = 0x90; patch[6] = 0x90;                   /* 补齐 7 字节 */

    memcpy(site, patch, sizeof(patch));

    if (make_exec_only(site, 7) != 0)
        perror("[srvfix] 恢复 site 保护属性失败");

    fprintf(stderr,
            "[srvfix] 已打补丁：%p 处改为 detour → 先执行 map <map> reserved，"
            "再清 [CGameServer+0x288]（换图只发生一次）\n", (void *)je);
    return 1;
}

/* ─────────────────────────────────────────────────────────────────────────
 * 补丁 2：绕过 reservation cookie 检查
 *
 * `sv_lan 0` 的 srcds 会从 Valve 侧拿到一个**非零**的 reservation cookie，
 * 而客户端 connect 包里带的是 GC 下发的 "Hello :)"（0x293A206F6C6C6548），
 * 两者不等 → 连接被静默拒绝（#Valve_Reject_Reserved_For_Lobby）。
 *
 * engine.so 里的判定（Addr == Off）：
 *
 *   1d0776  mov  eax, [esi+0x2ec]     ; 服务器 cookie 低 32
 *   1d077c  mov  edx, [esi+0x2f0]     ; 服务器 cookie 高 32
 *   1d078e  mov  ecx, eax
 *   1d0796  mov  ebx, edx
 *   1d079e  mov  edx, esi             ; 客户端 cookie 低
 *   1d07a0  xor  edx, eax
 *   1d07a2  mov  eax, edi             ; 客户端 cookie 高
 *   1d07a4  xor  eax, ebx
 *   1d07a6  or   edx, eax
 *   1d07a8  je   1d2790               ; 相等 → 放行
 *   1d07ae  or   ecx, ebx             ; ecx|ebx = 服务器 cookie
 *   1d07b0  je   1d2790               ; ★ 服务器 cookie == 0 → 放行
 *   1d07b6  ...                       ; 否则 → 拒绝
 *
 * 把 1d07b0 的 `je` 改成无条件 `jmp` —— 不管 cookie 是什么一律放行。
 *
 * ★ rel32 必须重算：`je rel32` 是 6 字节、`jmp rel32` 只有 5 字节，直接照抄
 *   位移会差 1 字节、跳进指令中间（README 记过这个坑）。
 * ───────────────────────────────────────────────────────────────────────── */
static const unsigned char CSIG[10] = {
    0x09, 0xD9,                     /* or  ecx, ebx            */
    0x0F, 0x84, 0x00, 0x00, 0x00, 0x00,  /* je rel32  (MASK 掉) */
    0x8B, 0x85                      /* mov eax, [ebp+...]      */
};
static const unsigned char CMASK[10] = {
    1, 1,
    1, 1, 0, 0, 0, 0,
    1, 1
};

static int cookie_patched;

static int try_patch_cookie(void)
{
    if (cookie_patched) return 1;
    if (!g_lo) return 0;

    uintptr_t hit = 0;
    for (uintptr_t a = g_lo; a + sizeof(CSIG) <= g_hi; a++) {
        const unsigned char *p = (const unsigned char *)a;
        int ok = 1;
        for (int i = 0; i < (int)sizeof(CSIG); i++) {
            if (CMASK[i] && p[i] != CSIG[i]) { ok = 0; break; }
        }
        if (ok) { hit = a; break; }
    }
    if (!hit) return 0;

    unsigned char *je = (unsigned char *)(hit + 2);      /* 指向 0F 84 */
    if (je[0] != 0x0F || je[1] != 0x84) {
        fprintf(stderr, "[srvfix] cookie: 意外，%p 不是 6 字节 je\n", (void *)je);
        cookie_patched = 1;
        return 1;
    }

    /* 原跳转目标 = je 指令末尾 + 原 rel32 */
    int32_t oldrel;
    memcpy(&oldrel, je + 2, 4);
    uintptr_t target = (uintptr_t)(je + 6) + oldrel;

    fprintf(stderr, "[srvfix] cookie: je 在 %p → 目标 %p\n", (void *)je, (void *)target);

    if (make_writable(je, 6) != 0) {
        perror("[srvfix] cookie: mprotect 失败");
        cookie_patched = 1;
        return 1;
    }

    unsigned char patch[6];
    patch[0] = 0xE9;                                     /* jmp rel32 */
    int32_t newrel = (int32_t)((intptr_t)target - (intptr_t)(je + 5));
    memcpy(patch + 1, &newrel, 4);
    patch[5] = 0x90;                                     /* 补齐 6 字节 */
    memcpy(je, patch, sizeof(patch));

    if (make_exec_only(je, 6) != 0)
        perror("[srvfix] cookie: 恢复保护属性失败");

    cookie_patched = 1;
    fprintf(stderr, "[srvfix] 已打补丁：%p 处 je → jmp（无条件放行，不再校验 reservation cookie）\n",
            (void *)je);
    return 1;
}

static void *worker(void *arg)
{
    (void)arg;
    for (int i = 0; i < 1200; i++) {        /* 最多 120 秒 */
        if (try_patch()) {
            try_patch_cookie();
            if (cookie_patched) { g_done = 1; return NULL; }
        }
        usleep(100 * 1000);
    }
    fprintf(stderr, "[srvfix] 放弃：120 秒内没等到引擎\n");
    return NULL;
}

__attribute__((constructor))
static void srvfix_init(void)
{
    if (getenv("SRVFIX_OFF")) {
        fprintf(stderr, "[srvfix] SRVFIX_OFF 已设置，跳过\n");
        return;
    }
    fprintf(stderr, "[srvfix] 已注入（v2 detour 版），等引擎加载..\n");

    pthread_t t;
    if (pthread_create(&t, NULL, worker, NULL) != 0) {
        fprintf(stderr, "[srvfix] 起线程失败\n");
        return;
    }
    pthread_detach(t);
}
