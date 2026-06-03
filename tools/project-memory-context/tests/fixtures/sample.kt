interface Greetable {
    fun greet(): String
}

data class Animal(val name: String) : Greetable {
    override fun greet() = "Hello, I'm $name"
}

object Singleton {
    fun getInstance() = this
}

fun standaloneFunction(x: Int, y: Int): Int = x + y

private fun privateHelper(): Unit {}

sealed class Result<T>

enum class Status { ACTIVE, INACTIVE }
