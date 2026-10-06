"""Copied per-file source providers for Bun's declared Rust source contracts."""

load("@aspect_rules_js//js:defs.bzl", "js_library")

def declare_runtime_sources():
    declare_runtime_files(native.glob(["**/*.rs"], exclude = ["target/**", "node_modules/**"]) + native.glob(["entrypoint.sh"], allow_empty = True))

def declare_runtime_files(files):
    for file in files:
        js_library(name = "source__" + file.replace("/", "__"), srcs = [file])
