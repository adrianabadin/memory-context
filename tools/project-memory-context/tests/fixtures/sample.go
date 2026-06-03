package main

import "fmt"

type Animal struct {
    Name string
}

type Speaker interface {
    Speak() string
}

func (a Animal) Speak() string {
    return a.Name
}

func NewAnimal(name string) Animal {
    return Animal{Name: name}
}

func privateHelper(x int) int {
    return x * 2
}
