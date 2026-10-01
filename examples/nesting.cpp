namespace demo {
struct Counter {
    int value;

    Counter() : value{} {};

    int next(int amount = [] { return 1; }()) {
        if (amount > 0) {
            value += amount;
        } else {
            value = 0;
        }
        return value;
    }
};
}
