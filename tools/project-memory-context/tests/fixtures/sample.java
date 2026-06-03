package com.example;

public interface Greetable {
    String greet();
}

public class Animal {
    public void speak() {}
    protected void breathe() {}
    private void sleep() {}
}

public enum Status {
    ACTIVE, INACTIVE
}

abstract class Base {
    public abstract void run();
}
