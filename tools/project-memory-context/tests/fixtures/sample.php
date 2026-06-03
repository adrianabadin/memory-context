<?php

interface Greetable {
    public function greet(): string;
}

abstract class Animal {
    abstract public function speak(): string;
    public function breathe(): void {}
}

class Dog extends Animal {
    public function speak(): string {
        return "woof";
    }
}

trait Loggable {
    public function log(string $msg): void {}
}

function standaloneFunction(int $x, int $y): int {
    return $x + $y;
}
