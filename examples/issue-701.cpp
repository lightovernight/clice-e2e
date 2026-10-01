#include <new>
#include <utility>
#include <cstddef>
using std::size_t;
template <typename TNow, typename... Res>
union mini_variant_impl {
    TNow value;
    mini_variant_impl<Res...> remain;
    template <size_t I, typename... Ts>
    explicit mini_variant_impl(std::in_place_index_t<I>, Ts &&...value)
        : remain(std::in_place_index<I - 1>, std::forward<Ts>(value)...) {};

    template <typename... Ts>
    explicit mini_variant_impl(std::in_place_index_t<0>, Ts &&...value) : value(std::forward<Ts>(value)...) {
    }

    template<size_t I, typename... Ts>
    decltype(auto) emplace(Ts&&... args) {
        if constexpr (I == 0) {
            new(&value) TNow(std::forward<Ts>(args)...);
        }
        else {
            new(&remain) mini_variant_impl();
        }
    }

    mini_variant_impl() : value() {};

    ~mini_variant_impl() {

    };
};
