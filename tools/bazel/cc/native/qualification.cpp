#include <cstdio>
#include <vector>

static_assert(__GNUC__ == 14 && __GNUC_MINOR__ == 3);
static_assert(sizeof(void*) == 8);

int main() {
  const std::vector<int> values{3, 5, 7};
  int sum = 0;
  for (const auto value : values) sum += value;
  if (sum != 15) return 1;
  std::printf("gcc=%s pointer=%zu sum=%d\n", __VERSION__, sizeof(void*), sum);
  return 0;
}
