"""Original two-suite burst command using the existing declared Bun test runtime."""

load("//tools/bazel/bun:rules.bzl", "bun_command_test")


def declare_burst_test(name):
    """Declare the original burst command; generated WASM/runtime qualification stays pending."""
    bun_command_test(
        name = name,
        entry_point = "//tools/bazel/browser:burst.ts",
        bun_config = "//tools/bazel/bun:empty-bunfig.toml",
        data = [
            "//tools/bazel/browser:burst.ts",
            "//:burst_playwright_config",
            "//:node_modules/@playwright/test",
            "//tests:source__e2e__display-burst-paint.e2e.ts",
            "//tests:source__e2e__fence-poll-cadence.e2e.ts",
            "//apps/web:inputs__src__terminal-worker-display-owner.test.ts",
            "//apps/web:source__src__terminal__render-mailbox.ts",
            "//apps/web:source__src__wasm-loader.ts",
            "//apps/web:term_wasm_runtime",
            "//apps/web:graphics_wasm_runtime",
        ],
        tools = {"//tools/bazel/browser:chromium": "chromium"},
        tool_environment = {"chromium": "MERKUR_PLAYWRIGHT_CHROMIUM"},
        tags = ["manual", "unqualified-browser-runtime"],
    )


def _burst_config_impl(ctx):
    if ctx.label.package:
        fail("The burst config projection must occupy the original root config namespace")
    original = ctx.actions.declare_file(ctx.label.name + ".original.config.mjs")
    output = ctx.actions.declare_file("playwright.burst.config.mjs")
    ctx.actions.expand_template(template = ctx.file.original, output = original, substitutions = {})
    ctx.actions.write(output, """import { isAbsolute } from 'node:path';
import original from './%s';

const chromium = process.env.MERKUR_PLAYWRIGHT_CHROMIUM;
if (chromium === undefined || !isAbsolute(chromium)) {
  throw new Error('Burst requires its declared Chromium executable');
}
export default {
  ...original,
  use: {
    ...original.use,
    launchOptions: { ...original.use.launchOptions, executablePath: chromium },
  },
};
""" % original.short_path)
    return [DefaultInfo(files = depset([original, output]))]

burst_playwright_config = rule(
    implementation = _burst_config_impl,
    attrs = {"original": attr.label(default = "//:playwright.burst.config.mjs", allow_single_file = True)},
)
