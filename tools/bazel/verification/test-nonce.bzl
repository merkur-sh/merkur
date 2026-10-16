"""Only per-test nonce Files enter test runfiles; no ledger enters compiler inputs."""

TestEpochsInfo = provider(fields = {
    "nonces": "Canonical test label to one declared nonce File.",
    "shared": "The one nonce File every test reads in a development build, or None.",
})

# A test used as another test's runtime dependency must not export its private nonce.
# Consumers use this explicit runtime closure; DefaultInfo remains the executable test's
# own runfiles, including its selected nonce.
TestRuntimeInfo = provider(fields = {"runfiles": "Runtime and fixture runfiles before the owning test nonce is merged."})

def _test_epochs_impl(ctx):
    files = {}
    for target, label in ctx.attr.nonces.items():
        if not label.startswith("//") or label.count(":") != 1 or label in files:
            fail("Epoch inputs require unique canonical main-repository test labels")
        selected = target[DefaultInfo].files.to_list()
        if len(selected) != 1 or selected[0].is_directory:
            fail("Each test epoch must be exactly one regular declared File")
        files[label] = selected[0]
    shared = ctx.file.shared
    if shared != None and files:
        fail("A development epoch set binds one shared nonce and no per-test nonce")
    return [TestEpochsInfo(nonces = files, shared = shared)]

test_epochs = rule(
    implementation = _test_epochs_impl,
    attrs = {
        "nonces": attr.label_keyed_string_dict(allow_files = True),
        # Development builds (`--config=development`) are ordinary cached builds: every
        # test reads this one constant File, so a test's action key is its inputs alone and
        # an unchanged test is a cache hit on any machine. Admission never uses them.
        "shared": attr.label(allow_single_file = True),
    },
)

def test_nonce_file(ctx):
    if ctx.label.workspace_root:
        fail("Verification epochs require a main-repository test target")
    label = "//" + ctx.label.package + ":" + ctx.label.name
    epochs = ctx.attr._revocation_epochs[TestEpochsInfo]
    nonce = epochs.nonces.get(label) or epochs.shared
    if nonce == None:
        fail("Test target has no declared revocation epoch: " + label)
    return nonce

# Rule owners add only test_nonce_file(ctx) to their test runfiles. Compiler/link actions,
# generated executables and fixture manifests must never consume this dependency.
TEST_EPOCH_ATTRIBUTE = attr.label(
    default = Label("@verification_revocations//:epochs"),
    providers = [TestEpochsInfo],
)
