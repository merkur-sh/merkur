#include <stdint.h>

_Static_assert(sizeof(void *) == 4, "the compiler must emit the wasm32 ABI");
_Static_assert(sizeof(uint64_t) == 8, "declared resource headers must supply C integer types");

uint64_t merkur_wasm_c_qualification(uint32_t value) {
  return (uint64_t)value * 17;
}
