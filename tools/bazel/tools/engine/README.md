# Declared verification engine

`//tools/bazel/tools/engine:bazel` exposes the native Bazel 9.2.0 executable selected
for the configured platform. The module extension downloads official release bytes
using the four SHA256 pins in `.github/bazel/engine-pins.json`. Unsupported platforms
fail analysis. There is no Bazelisk, PATH discovery, HOME cache lookup or downloader
inside the executable rule.

`BazelEngineInfo` carries the original payload File and its acquisition metadata
File. The `payload` and `acquisition` output groups expose those same Files.
`//tools/bazel/tools/engine:acquisition` selects the metadata for the execution
platform. Bun launchers bind the executable through `tools` and map the tool name
to `MERKUR_VERIFICATION_BAZEL` through `tool_environment`. The frontend must retain
that configured File authority when proving executable bytes and runtime version.

`engine_test` checks the payload against the independent pin document, its native
header, and `--version` with an empty HOME and unavailable PATH. It also checks that
a missing exact executable refuses a PATH replacement. No test launches a nested
build, compiler action or test action. These checks qualify only the measured native
platform; they do not establish a four-platform execution matrix or final frontend
acceptance.
