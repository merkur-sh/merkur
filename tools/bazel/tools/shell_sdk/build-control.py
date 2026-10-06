"""Exercise original configured tmux source File and tool boundaries."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile


def controls(builder, specification, action_root):
    module_spec = importlib.util.spec_from_file_location('tmux_build', builder)
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    original = json.loads(Path(specification).read_text())
    root = Path(action_root)
    module.tool_paths(original, root)
    with tempfile.TemporaryDirectory(prefix='merkur-original-tmux-source-control-') as temporary:
        destination = Path(temporary)
        module.source_files(original, root, destination / 'original')
        for reason, changed in [
            ('undeclared source', dict(original, inputs=[])),
            ('duplicate source', dict(original, source=original['source'] + original['source'][:1])),
            ('source escape', dict(original, source=[dict(original['source'][0], relative='../outside')])),
        ]:
            try:
                module.source_files(changed, root, destination / reason)
            except ValueError:
                pass
            else:
                raise AssertionError('Tmux admitted ' + reason)
        pins = json.loads((root / original['pins']).read_text())
        source_license = next(item for item in original['source'] if item['relative'] == pins['license']['path'])
        changed = copy.deepcopy(original)
        changed['source'] = [dict(item, path=original['source'][0]['path']) if item == source_license else item
                             for item in original['source']]
        try:
            module.source_files(changed, root, destination / 'foreign-license')
        except ValueError as error:
            assert 'original source license' in str(error), str(error)
        else:
            raise AssertionError('Tmux admitted a foreign source license')
    for name in ['shell', 'python', 'cxx', 'ar']:
        changed = dict(original, **{name: '/bin/sh'})
        try:
            module.tool_paths(changed, root)
        except ValueError as error:
            assert 'declared executable File closure' in str(error), str(error)
        else:
            raise AssertionError('Tmux admitted a foreign ' + name + ' File')
    print('Original tmux source controls: source replay, undeclared/duplicate/escape/license and four foreign tool Files passed')


if __name__ == '__main__':
    controls(*sys.argv[1:])
