#[cfg(target_os = "linux")]
mod linux {
    use aya::{
        Ebpf, Pod,
        maps::{Array, PerCpuArray},
        programs::TracePoint,
    };
    use std::{error::Error, fs, io, os::unix::fs::MetadataExt, path::Path};

    #[derive(Clone, Copy)]
    #[repr(C)]
    struct Configuration {
        ns_dev: u64,
        ns_ino: u64,
        pid: u32,
        syscall_offset: u32,
        prev_offset: u32,
        next_offset: u32,
        wake_offset: u32,
        syscall_ids: [u32; 4],
        reserved: u32,
    }
    // SAFETY: Configuration is repr(C), contains only integers and has no padding.
    unsafe impl Pod for Configuration {}

    fn field_offset(
        root: &Path,
        event: &str,
        field: &str,
        size: usize,
    ) -> Result<u32, Box<dyn Error>> {
        let format = fs::read_to_string(root.join("events").join(event).join("format"))?;
        for line in format.lines() {
            let parts: Vec<_> = line.trim().split(';').collect();
            if parts
                .first()
                .is_some_and(|declaration| declaration.ends_with(&format!(" {field}")))
            {
                let offset = parts
                    .get(1)
                    .ok_or("missing offset")?
                    .trim()
                    .strip_prefix("offset:")
                    .ok_or("bad offset")?
                    .parse()?;
                let actual: usize = parts
                    .get(2)
                    .ok_or("missing size")?
                    .trim()
                    .strip_prefix("size:")
                    .ok_or("bad size")?
                    .parse()?;
                if actual != size {
                    return Err(format!("unexpected field size: {event}/{field}: {actual}").into());
                }
                return Ok(offset);
            }
        }
        Err(format!("missing tracepoint field: {event}/{field}").into())
    }

    pub fn run() -> Result<(), Box<dyn Error>> {
        let args: Vec<_> = std::env::args().collect();
        if args.len() != 3 {
            return Err("usage: merkur-edge-kernel-profile <edge-pid> <trace.bpf.o>; stdin stop ends capture".into());
        }
        let pid: u32 = args[1].parse()?;
        let root = Path::new("/sys/kernel/tracing");
        let namespace = fs::metadata("/proc/self/ns/pid")?;
        let configuration = Configuration {
            ns_dev: namespace.dev(),
            ns_ino: namespace.ino(),
            pid,
            syscall_offset: field_offset(root, "raw_syscalls/sys_enter", "id", 8)?,
            prev_offset: field_offset(root, "sched/sched_switch", "prev_pid", 4)?,
            next_offset: field_offset(root, "sched/sched_switch", "next_pid", 4)?,
            wake_offset: field_offset(root, "sched/sched_wakeup", "pid", 4)?,
            syscall_ids: [
                libc::SYS_sendmsg as u32,
                libc::SYS_recvmsg as u32,
                libc::SYS_sendmmsg as u32,
                libc::SYS_recvmmsg as u32,
            ],
            reserved: 0,
        };
        fs::metadata(format!("/proc/{pid}"))?;
        let mut ebpf = Ebpf::load_file(&args[2])?;
        Array::<_, Configuration>::try_from(ebpf.map_mut("CONFIG").ok_or("missing CONFIG")?)?.set(
            0,
            configuration,
            0,
        )?;
        for (name, category, event) in [
            ("enter", "raw_syscalls", "sys_enter"),
            ("leave", "raw_syscalls", "sys_exit"),
            ("switch_thread", "sched", "sched_switch"),
            ("wake_thread", "sched", "sched_wakeup"),
            ("exit_thread", "sched", "sched_process_exit"),
        ] {
            let program: &mut TracePoint = ebpf
                .program_mut(name)
                .ok_or("missing tracepoint program")?
                .try_into()?;
            program.load()?;
            program.attach(category, event)?;
        }
        println!("@@edge-kernel-ready");
        let mut stop = String::new();
        io::stdin().read_line(&mut stop)?;
        if stop.trim() != "stop" {
            return Err("expected stop rendezvous".into());
        }
        // Detach before reading counters so the histogram is one consistent capture.
        for name in [
            "enter",
            "leave",
            "switch_thread",
            "wake_thread",
            "exit_thread",
        ] {
            let program: &mut TracePoint = ebpf
                .program_mut(name)
                .ok_or("missing program")?
                .try_into()?;
            program.unload()?;
        }
        let histogram =
            PerCpuArray::<_, u64>::try_from(ebpf.map("HISTOGRAM").ok_or("missing histogram")?)?;
        let mut metrics = serde_json::Map::new();
        for (metric, name) in [
            "sendmsg",
            "recvmsg",
            "sendmmsg",
            "recvmmsg",
            "other_syscalls",
            "off_cpu",
            "wake_to_run",
        ]
        .iter()
        .enumerate()
        {
            let mut buckets = Vec::with_capacity(64);
            for bucket in 0..64 {
                buckets.push(
                    histogram
                        .get(&((metric * 64 + bucket) as u32), 0)?
                        .iter()
                        .sum::<u64>(),
                );
            }
            metrics.insert((*name).into(), serde_json::json!({ "count": buckets.iter().sum::<u64>(), "log2_ns_buckets": buckets }));
        }
        let diagnostics =
            PerCpuArray::<_, u64>::try_from(ebpf.map("DIAGNOSTICS").ok_or("missing diagnostics")?)?;
        let diagnostics: Vec<u64> = (0..3)
            .map(|key| diagnostics.get(&key, 0).map(|values| values.iter().sum()))
            .collect::<Result<_, _>>()?;
        let complete = diagnostics[0] == 0 && diagnostics[1] == 0;
        println!(
            "@@edge-kernel-profile {}",
            serde_json::json!({
                "pid": pid, "complete": complete, "metrics": metrics,
                "map_refusals": diagnostics[0], "read_failures": diagnostics[1], "unmatched_exits": diagnostics[2],
                "boundary": "target process threads; syscall wall duration includes off-CPU wait; off_cpu includes sleeping; wake_to_run is scheduler delay; histograms have power-of-two resolution",
            })
        );
        if !complete {
            return Err("incomplete kernel capture".into());
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn tracepoint_offsets_come_from_the_running_kernel_format() {
            let root =
                std::env::temp_dir().join(format!("merkur-trace-format-{}", std::process::id()));
            let path = root.join("events/sched/sched_switch");
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("format"), "field:pid_t prev_pid; offset:28; size:4; signed:1;\nfield:pid_t next_pid; offset:60; size:4; signed:1;\n").unwrap();
            assert_eq!(
                field_offset(&root, "sched/sched_switch", "prev_pid", 4).unwrap(),
                28
            );
            assert!(field_offset(&root, "sched/sched_switch", "next_pid", 8).is_err());
            fs::remove_dir_all(root).unwrap();
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "linux")]
    {
        linux::run()
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err("edge kernel profiling requires Linux tracefs, BPF and perf-event access".into())
    }
}
