import { UserController } from '../controllers/user.controller';

export async function main(): Promise<void> {
  const controller = new UserController();
  const user = await controller.getUser('user-1');
  console.log(user);
}
