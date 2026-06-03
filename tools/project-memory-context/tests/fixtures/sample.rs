pub struct Animal {
    pub name: String,
}

pub enum Status {
    Active,
    Inactive,
}

pub trait Speaker {
    fn speak(&self) -> String;
}

impl Animal {
    pub fn new(name: &str) -> Self {
        Animal { name: name.to_string() }
    }
}

pub fn standalone(x: i32) -> i32 {
    x * 2
}

fn private_helper() {}
