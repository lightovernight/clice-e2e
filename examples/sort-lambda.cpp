#include <algorithm>
#include <vector>

void sort_values(std::vector<int>& values) {
    auto cmp = [](int lhs, int rhs) {
        return lhs < rhs;
    };
    std::sort(values.begin(), values.end(), cmp);
}
