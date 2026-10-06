"""Original Node native File and transitive resource closure analysis controls."""
load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts")

def _impl(ctx):
    env = analysistest.begin(ctx)
    target = analysistest.target_under_test(env)
    original = ctx.attr.original[DefaultInfo]
    files = target[DefaultInfo].default_runfiles.files.to_list()
    expected = original.files.to_list()
    for runfiles in [original.default_runfiles, original.data_runfiles]:
        if runfiles != None:
            expected.extend(runfiles.files.to_list())
    missing = [file.path for file in expected + ctx.files.resources if file not in files]
    asserts.equals(env, 0, len(missing), "Original Node distribution File closure is retained: " + str(missing[:3]))
    actions = [action for action in analysistest.target_actions(env) if action.mnemonic == "ExecutableSymlink"]
    asserts.equals(env, 1, len(actions))
    asserts.true(env, ctx.file.native in actions[0].inputs.to_list(), "The direct native Node File is selected")
    return analysistest.end(env)

def node_binding_test_for_platform(platform = None):
    """Keep the control native while analysing the adapter for the chosen platform."""
    settings = {} if platform == None else {"//command_line_option:platforms": str(platform)}
    return analysistest.make(_impl, attrs = {
        "original": attr.label(mandatory = True),
        "native": attr.label(mandatory = True, allow_single_file = True),
        "resources": attr.label_list(allow_files = True),
    }, config_settings = settings)

node_binding_test = node_binding_test_for_platform()
