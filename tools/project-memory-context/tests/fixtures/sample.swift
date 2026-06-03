protocol Greetable {
    func greet() -> String
}

public class Animal: Greetable {
    public func greet() -> String { return "hello" }
    func privateMethod() {}
}

public struct Point {
    var x: Double
    var y: Double
    public func distance() -> Double { return 0.0 }
}

extension Animal {
    func extended() {}
}

public func standaloneFunction(x: Int, y: Int) -> Int {
    return x + y
}

enum Status {
    case active
    case inactive
}
