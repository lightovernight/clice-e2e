struct Counter {
    int next() {
        return ++value;
    }

    void reset() {
        value = 0;
    }

    int value;
};
