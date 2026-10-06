"""Native exec driver for original CMake's pre-toolchain uname dependency."""

load("@rules_rust//rust:defs.bzl", "rust_binary", "rust_test")

def declared_cmake_driver(name):
    rust_binary(
        name = name,
        srcs = ["//tools/bazel/rust:cmake-driver.rs"],
        crate_name = "declared_cmake_driver",
        native_link_map = True,
        edition = "2024",
        rustc_flags = ["--check-cfg=cfg(make_driver)"],
        visibility = ["//visibility:public"],
        tags = ["manual"],
    )
    rust_test(
        name = name + "_test",
        crate = ":" + name,
        rustc_flags = ["--check-cfg=cfg(make_driver)"],
        tags = ["manual"],
    )
    rust_binary(
        name = name + "_make",
        srcs = ["//tools/bazel/rust:cmake-driver.rs"],
        crate_name = "declared_cmake_make_driver",
        edition = "2024",
        rustc_flags = ["--cfg=make_driver", "--check-cfg=cfg(make_driver)"],
        visibility = ["//visibility:public"],
        tags = ["manual"],
    )
    rust_test(
        name = name + "_make_test",
        crate = ":" + name + "_make",
        rustc_flags = ["--cfg=make_driver", "--check-cfg=cfg(make_driver)"],
        tags = ["manual"],
    )
