"""Typed environment authority for complete immutable native SDK payloads."""
NativeSdkInfo = provider(fields = {
    "prefix_runfile": "Exact declared SDK root relative to the engine runfiles directory.",
    "binary": "Original checksum-pinned executable File.",
})

# Single provider identity shared by original archive producers and consumers.
DarwinCompilerSdkInfo = provider(fields = ["root", "files", "members", "sysroot", "resource_dir", "cxx_headers", "execution_cpu", "tools"])
