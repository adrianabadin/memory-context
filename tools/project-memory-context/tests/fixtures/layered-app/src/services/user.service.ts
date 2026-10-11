import { UserRepository } from '../repositories/user.repository';
import { formatName } from '../utils/format';
import { User } from '../models/user.model';

export class UserService {
  private userRepo: UserRepository;

  constructor(userRepo = new UserRepository()) {
    this.userRepo = userRepo;
  }

  async findById(id: string): Promise<User | null> {
    const user = await this.userRepo.findOne(id);
    if (!user) {
      return null;
    }
    return {
      ...user,
      name: formatName(user.name),
    };
  }
}
