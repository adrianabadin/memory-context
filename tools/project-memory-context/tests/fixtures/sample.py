class Animal:
    def speak(self):
        pass

class Dog(Animal):
    def speak(self):
        return "woof"

def standalone_function(x, y):
    return x + y

async def async_handler(request):
    pass

def _private_function():
    pass

@staticmethod
def decorated_func():
    pass
