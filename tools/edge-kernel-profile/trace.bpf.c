/* Diagnostic-only tracepoints loaded by Aya. No libbpf runtime is used.
 * Tracepoint field offsets are obtained from this kernel's tracefs format by
 * the loader, not guessed from architecture-specific struct layouts. */
typedef unsigned int u32;
typedef unsigned long long u64;
typedef long long i64;
#define SEC(name) __attribute__((section(name), used))
#define INLINE static __attribute__((always_inline)) inline
#define uint(name, val) int (*name)[val]
#define type(name, val) val *name
#define MAP_HASH 1
#define MAP_ARRAY 2
#define MAP_PERCPU_ARRAY 6
#define ANY 0
#define NOEXIST 1

static void *(*lookup)(void *, const void *) = (void *)1;
static long (*update)(void *, const void *, const void *, u64) = (void *)2;
static long (*remove_key)(void *, const void *) = (void *)3;
static u64 (*now_ns)(void) = (void *)5;
static u64 (*pid_tgid)(void) = (void *)14;
static long (*read_kernel)(void *, u32, const void *) = (void *)113;
struct pidns_info { u32 pid, tgid; };
static long (*namespace_pid)(u64, u64, struct pidns_info *, u32) = (void *)120;

/* The fixed map bounds are resource bounds, not measurements. 4096 thread
 * owners exceeds the fixture's thread count; refusal is counted and invalidates
 * the capture rather than silently evicting earlier observations. */
struct configuration { u64 ns_dev, ns_ino; u32 pid, syscall_offset, prev_offset, next_offset, wake_offset; u32 syscall_ids[4]; u32 reserved; };
struct state { u64 syscall_start, off_start, wake_start; u32 syscall_class; };
struct { uint(type, MAP_ARRAY); uint(max_entries, 1); type(key, u32); type(value, struct configuration); } CONFIG SEC(".maps");
struct { uint(type, MAP_HASH); uint(max_entries, 4096); type(key, u32); type(value, struct state); } THREADS SEC(".maps");
/* Seven metrics, 64 logarithmic nanosecond buckets each. */
struct { uint(type, MAP_PERCPU_ARRAY); uint(max_entries, 7 * 64); type(key, u32); type(value, u64); } HISTOGRAM SEC(".maps");
/* map refusals, read failures, unmatched exits */
struct { uint(type, MAP_PERCPU_ARRAY); uint(max_entries, 3); type(key, u32); type(value, u64); } DIAGNOSTICS SEC(".maps");

INLINE void diagnostic(u32 key) { u64 *value = lookup(&DIAGNOSTICS, &key); if (value) *value += 1; }
INLINE struct configuration *config(void) { u32 zero = 0; return lookup(&CONFIG, &zero); }
INLINE int target(struct configuration *cfg) {
    struct pidns_info owner = {};
    if (namespace_pid(cfg->ns_dev, cfg->ns_ino, &owner, sizeof(owner))) return 0;
    return owner.tgid == cfg->pid;
}
INLINE void sample(u32 metric, u64 elapsed) {
    u32 bucket = 0;
    /* Bounded unrolled bit search avoids an input-dependent BPF loop. */
    if (elapsed >> 32) { bucket += 32; elapsed >>= 32; }
    if (elapsed >> 16) { bucket += 16; elapsed >>= 16; }
    if (elapsed >> 8) { bucket += 8; elapsed >>= 8; }
    if (elapsed >> 4) { bucket += 4; elapsed >>= 4; }
    if (elapsed >> 2) { bucket += 2; elapsed >>= 2; }
    if (elapsed >> 1) bucket += 1;
    u32 key = metric * 64 + bucket;
    u64 *count = lookup(&HISTOGRAM, &key);
    if (count) *count += 1;
}
INLINE struct state *thread(u32 tid) {
    struct state *value = lookup(&THREADS, &tid);
    if (value) return value;
    struct state empty = {};
    if (update(&THREADS, &tid, &empty, NOEXIST)) { diagnostic(0); return 0; }
    return lookup(&THREADS, &tid);
}
INLINE int tid_field(void *ctx, u32 offset, u32 *tid) {
    if (read_kernel(tid, sizeof(*tid), ctx + offset)) { diagnostic(1); return 0; }
    return 1;
}
SEC("tracepoint/raw_syscalls/sys_enter") int enter(void *ctx) {
    struct configuration *cfg = config(); u64 owner = pid_tgid();
    if (!cfg || !target(cfg)) return 0;
    u32 tid = owner; struct state *value = thread(tid);
    if (!value) return 0;
    i64 id = 0;
    if (read_kernel(&id, sizeof(id), ctx + cfg->syscall_offset)) { diagnostic(1); return 0; }
    value->syscall_class = 4;
    #pragma unroll
    for (u32 i = 0; i < 4; i++) if (id == cfg->syscall_ids[i]) value->syscall_class = i;
    value->syscall_start = now_ns();
    return 0;
}
SEC("tracepoint/raw_syscalls/sys_exit") int leave(void *ctx) {
    struct configuration *cfg = config(); u64 owner = pid_tgid();
    if (!cfg || !target(cfg)) return 0;
    u32 tid = owner; struct state *value = lookup(&THREADS, &tid);
    if (!value || !value->syscall_start) { diagnostic(2); return 0; }
    sample(value->syscall_class, now_ns() - value->syscall_start);
    value->syscall_start = 0;
    return 0;
}
SEC("tracepoint/sched/sched_switch") int switch_thread(void *ctx) {
    struct configuration *cfg = config(); if (!cfg) return 0;
    u32 previous = 0, next = 0;
    if (!tid_field(ctx, cfg->prev_offset, &previous) || !tid_field(ctx, cfg->next_offset, &next)) return 0;
    u64 now = now_ns();
    struct state *value = target(cfg) ? thread(previous) : lookup(&THREADS, &previous);
    if (value) value->off_start = now;
    value = lookup(&THREADS, &next);
    if (value) {
        if (value->off_start) { sample(5, now - value->off_start); value->off_start = 0; }
        if (value->wake_start) { sample(6, now - value->wake_start); value->wake_start = 0; }
    }
    return 0;
}
SEC("tracepoint/sched/sched_wakeup") int wake_thread(void *ctx) {
    struct configuration *cfg = config(); if (!cfg) return 0;
    u32 tid = 0;
    if (!tid_field(ctx, cfg->wake_offset, &tid)) return 0;
    struct state *value = lookup(&THREADS, &tid);
    if (value && !value->wake_start) value->wake_start = now_ns();
    return 0;
}
SEC("tracepoint/sched/sched_process_exit") int exit_thread(void *ctx) {
    struct configuration *cfg = config(); u64 owner = pid_tgid();
    if (cfg && target(cfg)) { u32 tid = owner; remove_key(&THREADS, &tid); }
    return 0;
}
char LICENSE[] SEC("license") = "GPL";
