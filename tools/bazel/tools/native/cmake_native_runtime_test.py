"""Actual Darwin API controls for the original CMake runtime source repair.

The declared SDK specification and repaired original source root are supplied by
the caller. No host compiler, shell, or process-table command is selected here.
"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


def absolute_flags(flags, execroot):
    result = []
    for flag in flags:
        if flag.startswith(("external/", "bazel-out/")):
            flag = str(execroot / flag)
        else:
            for prefix in ("--sysroot=", "--ld-path=", "-fuse-ld="):
                if flag.startswith(prefix) and flag[len(prefix):].startswith(("external/", "bazel-out/")):
                    flag = prefix + str(execroot / flag[len(prefix):])
                    break
        result.append(flag)
    return result


class NativeRuntimeControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if sys.platform != "darwin":
            raise RuntimeError("CMake Darwin controls require a native Darwin executor")
        cls.spec = json.loads(Path(os.environ["MERKUR_CMAKE_NATIVE_CONTROL_SPEC"]).read_text())
        cls.execroot = Path(os.environ["MERKUR_CMAKE_NATIVE_CONTROL_EXECROOT"])
        cls.source = Path(os.environ["MERKUR_CMAKE_NATIVE_CONTROL_SOURCE"])
        if not cls.execroot.is_absolute() or not cls.source.is_absolute():
            raise RuntimeError("Native controls require explicit declared absolute roots")
        cls.temporary = tempfile.TemporaryDirectory(prefix="merkur-cmake-native-api-")
        cls.directory = Path(cls.temporary.name)
        cls.environment = {"PATH": "", "LC_ALL": "C", "ZERO_AR_DATE": "1"}

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def compile(self, name, source, cxx=False, frameworks=()):
        text = self.directory / (name + (".cxx" if cxx else ".c"))
        binary = self.directory / name
        text.write_text(source)
        flags = absolute_flags(self.spec["cxx_flags" if cxx else "compile_flags"], self.execroot)
        flags += absolute_flags(self.spec["link_flags"], self.execroot)
        command = [str(self.execroot / self.spec["cxx" if cxx else "cc"]), *flags]
        for framework in frameworks:
            command += ["-framework", framework]
        subprocess.run([*command, str(text), "-o", str(binary)], env=self.environment, check=True)
        return binary

    def test_original_version_fields_and_invalid_switch(self):
        header = self.source / "Source/kwsys/SystemVersionDarwin.hxx"
        binary = self.compile("version", '#include ' + json.dumps(str(header)) + r'''
#include <iostream>
int main(int argc, char** argv) {
  if (argc != 2) return 3;
  std::string value;
  if (!kwsysSystemVersionDarwin(argv[1], value)) return 2;
  std::cout << value << '\n';
  return 0;
}
''', cxx=True, frameworks=("CoreFoundation",))
        # The publisher-owned public OS facts file is the native API's source.
        import plistlib
        facts = plistlib.loads(Path("/System/Library/CoreServices/SystemVersion.plist").read_bytes())
        for argument, field in (("-productName", "ProductName"), ("-productVersion", "ProductVersion"), ("-buildVersion", "ProductBuildVersion")):
            with self.subTest(argument=argument):
                completed = subprocess.run([str(binary), argument], env=self.environment, capture_output=True, check=True)
                self.assertEqual(completed.stdout.decode(), facts[field] + "\n")
                self.assertEqual(completed.stderr, b"")
        invalid = subprocess.run([str(binary), "-unknown"], env=self.environment, capture_output=True)
        self.assertEqual(invalid.returncode, 2)
        self.assertEqual(invalid.stdout, b"")
        self.assertEqual(invalid.stderr, b"")

    def test_original_recursive_cleanup_only_own_tree(self):
        text = (self.source / "Source/kwsys/ProcessUNIX.c").read_text()
        start = text.index("static void kwsysProcessKill(pid_t process_id)\n{")
        end = text.index("\n}\n", start) + 3
        function = text[start:end]
        self.assertNotIn("popen(", function.split("#else", 1)[0])
        binary = self.compile("cleanup", r'''
#include <errno.h>
#include <limits.h>
#include <libproc.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/proc_info.h>
#include <sys/wait.h>
#include <unistd.h>
''' + function + r'''
int main(void) {
  int ready[2], live[2];
  if (pipe(ready) || pipe(live)) return 1;
  pid_t sibling = fork();
  if (sibling == 0) {
    close(ready[0]); close(ready[1]); close(live[0]); close(live[1]);
    for (;;) pause();
  }
  if (sibling < 0) return 2;
  pid_t root = fork();
  if (root == 0) {
    close(ready[0]); close(live[0]);
    /* More than the initial API buffer, plus a second generation. */
    for (int index = 0; index < 24; ++index) {
      pid_t child = fork();
      if (child < 0) _exit(3);
      if (child == 0) {
        pid_t leaf = -1;
        if (index == 0) {
          leaf = fork();
          if (leaf < 0) _exit(4);
          if (leaf == 0) {
            pid_t me = getpid();
            if (write(ready[1], &me, sizeof(me)) != sizeof(me)) _exit(5);
            for (;;) pause();
          }
        }
        pid_t me = getpid();
        if (write(ready[1], &me, sizeof(me)) != sizeof(me)) _exit(6);
        for (;;) pause();
      }
    }
    for (;;) pause();
  }
  if (root < 0) return 7;
  close(ready[1]); close(live[1]);
  for (int index = 0; index < 25; ++index) {
    pid_t child;
    if (read(ready[0], &child, sizeof(child)) != sizeof(child) || child <= 0) return 8;
  }
  close(ready[0]);
  kwsysProcessKill(root);
  int status;
  if (waitpid(root, &status, 0) != root || !WIFSIGNALED(status) || WTERMSIG(status) != SIGKILL) return 9;
  /* EOF requires every owned descendant to release its live write descriptor. */
  char byte;
  if (read(live[0], &byte, 1) != 0) return 10;
  close(live[0]);
  if (kill(sibling, 0) != 0) return 11;
  kill(sibling, SIGKILL);
  if (waitpid(sibling, &status, 0) != sibling) return 12;
  puts("owned descendants retired; unrelated owned sibling survived");
  return 0;
}
''')
        completed = subprocess.run([str(binary)], env=self.environment, capture_output=True, timeout=20, check=True)
        self.assertEqual(completed.stdout, b"owned descendants retired; unrelated owned sibling survived\n")
        self.assertEqual(completed.stderr, b"")


if __name__ == "__main__":
    unittest.main()
