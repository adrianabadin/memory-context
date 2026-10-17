import { User } from '../models/user.model';

export interface IUserRepository {
  findOne(id: string): Promise<User | null>;
}
