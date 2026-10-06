"""Immutable TPM image producers; genuine feature harness qualification is separate."""

load("@debian_tpm_amd64//:defs.bzl", amd64_rootfs = "define_rootfs")
load("@debian_tpm_arm64//:defs.bzl", arm64_rootfs = "define_rootfs")
load(":tpm.bzl", "tpm_runtime_image")

def tpm_runtime_targets(name, **kwargs):
    for architecture, factory in [("amd64", amd64_rootfs), ("arm64", arm64_rootfs)]:
        factory(name = name + "_rootfs_" + architecture, **kwargs)
        tpm_runtime_image(name = name + "_image_" + architecture, rootfs = ":" + name + "_rootfs_" + architecture, architecture = architecture, **kwargs)
