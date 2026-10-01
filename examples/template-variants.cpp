template <typename T>
class Box {
public:
    T get() const {
        return value;
    }

    void set(T next) {
        value = next;
    }

private:
    T value{};
};

template <typename T>
class Box<T*> {
public:
    T* get() const {
        return value;
    }

    void set(T* next) {
        value = next;
    }

private:
    T* value = nullptr;
};

template <>
class Box<int> {
public:
    int get() const {
        return value;
    }

    void set(int next) {
        value = next;
    }

private:
    int value = 0;
};

template <typename T>
T minimum(T lhs, T rhs) {
    return lhs < rhs ? lhs : rhs;
}

template <>
int minimum<int>(int lhs, int rhs) {
    if (lhs < rhs) {
        return lhs;
    }
    return rhs;
}
