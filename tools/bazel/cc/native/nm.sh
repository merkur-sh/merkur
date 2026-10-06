#!/bin/sh
set -eu
export PATH=/usr/local/bin:/usr/bin:/bin
unset GCC_EXEC_PREFIX COMPILER_PATH LIBRARY_PATH CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH
exec /usr/bin/nm "$@"
