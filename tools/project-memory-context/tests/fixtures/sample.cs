namespace Example;

public interface IGreetable
{
    string Greet();
}

public class Animal : IGreetable
{
    public string Greet() => "Hello";
    protected void Breathe() {}
    private void Sleep() {}
}

public enum Status
{
    Active,
    Inactive
}

public record PersonRecord(string Name, int Age);
