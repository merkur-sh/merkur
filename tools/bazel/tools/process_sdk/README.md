# Declared TestRunner process utilities

`declared_process_sdk` builds original process utilities with the configured native
Cc toolchain. It reuses the source utility archive, executable membership, flag
normalization and output ownership controls. Its runtime retains the original
sources' licenses and installed resources. Native controls use only an owned fresh
process group with the exact stock TestRunner commands: `ps -p PID` and
`pgrep -a -g GROUP`. An exited group must return no match. No ambient process binary,
loader environment or modified watcher is used.

The Darwin source is Apple `adv_cmds-237`. It selects the original unsigned
`ps_lowpriv` source target and original pgrep entrypoint. The selected public SDK
does not contain the original `sysmon.h` or `System/sys/proc.h`/persona headers
required by these sources. Compilation must fail until the exact original header
and interface closure is supplied through the configured compiler; declarations
are never inferred or replaced. This provider is not qualified or complete.

The Linux source is original procps-ng 4.0.7. Configure retains upstream feature
defaults; the private libproc2 representation is static so selected binaries do
not depend on a loader path. Its actual native build and runtime qualification
must run on declared Linux executors. The source factory and boundary controls
alone do not qualify a TestRunner SDK or permit cutover.
