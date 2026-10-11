import { UserService } from '../src/services/user.service';

export async function testUserService(): Promise<void> {
  const service = new UserService();
  const user = await service.findById('user-1');
  if (!user) {
    throw new Error('User not found');
  }
}
