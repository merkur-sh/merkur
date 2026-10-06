"""Declared browser Worker registration oracle consumed by native interoperability tests."""

load("@aspect_rules_js//js:defs.bzl", "js_library")
load("//tools/bazel/bun:rules.bzl", "bun_binary")

def declare_browser_registration_oracle():
    js_library(
        name = "browser_registration_sources",
        srcs = ["scripts/browser-registration-oracle.ts"],
        deps = [
            "//packages/auth:source__src__opaque.ts",
            "//packages/shared:source__src__opaque-password-policy.ts",
            "//packages/auth:node_modules/@serenity-kit/opaque",
            "//apps/web:source__src__auth__account-opaque.ts",
            "//apps/web:source__src__auth__account-opaque-finish.ts",
            "//apps/web:source__src__auth__account-opaque-worker.ts",
            "//apps/web:source__src__auth__encoding.ts",
            "//apps/web:node_modules/@serenity-kit/opaque",
        ],
    )
    bun_binary(
        name = "browser_registration_oracle",
        entry_point = ":browser_registration_sources",
        data = [":browser_registration_sources"],
        bun_config = "//tools/bazel/bun:empty-bunfig.toml",
    )
