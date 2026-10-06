"""Materialize the exact original archive into declared per-member SDK artifacts."""
import importlib.util
import json
from pathlib import Path
import sys
import tarfile


def prepare_empty_output(root):
    if root.is_symlink():
        raise ValueError("SDK output cannot be an alias")
    if root.exists():
        # Bazel precreates parents of declared per-File outputs. No File or alias
        # may already exist; remove only those empty engine-created directories.
        directories = []
        for path in root.rglob("*"):
            if path.is_symlink() or not path.is_dir():
                raise ValueError("SDK output already contains a File or alias")
            directories.append(path)
        for path in sorted(directories, key=lambda path: len(path.parts), reverse=True):
            path.rmdir()


if __name__ == "__main__":
    specification = importlib.util.spec_from_file_location("compiler", sys.argv[5])
    compiler = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(compiler)
    request = json.loads(Path(sys.argv[1]).read_text())
    expected = json.loads(Path(sys.argv[2]).read_text())
    archive, root = Path(sys.argv[3]), Path(sys.argv[4])
    if compiler.archive_members(archive, request["strip_prefix"]) != expected:
        raise ValueError("Declared SDK output inventory differs from original archive")
    prepare_empty_output(root)
    compiler.extract(archive, root, request, compiler.load_loader(sys.argv[6]))
