#include <string>

namespace Animals {

class Animal {
public:
    virtual std::string speak() = 0;
    void breathe() {}
};

struct Point {
    double x;
    double y;
};

} // namespace Animals

int standaloneFunction(int x, int y) {
    return x + y;
}

void helperVoid(const std::string& msg) {}
