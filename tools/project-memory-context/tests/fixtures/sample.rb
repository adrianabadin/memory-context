module Greetable
  def greet
    "hello"
  end
end

class Animal
  include Greetable

  def initialize(name)
    @name = name
  end

  def speak
    "..."
  end
end

class Dog < Animal
  def speak
    "woof"
  end
end
