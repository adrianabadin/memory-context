interface Greetable {
  greet(): string;
}

@Injectable()
export class MyService<T> implements Greetable {
  greet() { return 'hello'; }
}

export function greetUser(name: string): void {
  console.log(name);
}

type Alias = string | number;

export const handler = async (req: Request): Promise<void> => {
  await Promise.resolve();
};

const localArrow = (x: number) => x * 2;

export enum Status {
  Active,
  Inactive,
}
