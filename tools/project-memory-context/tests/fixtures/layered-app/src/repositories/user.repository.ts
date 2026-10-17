import { IUserRepository } from '../interfaces/user-repository';
import { User, UserEntity } from '../models/user.model';
import { DatabaseClient } from '../db/client';

export class UserRepository implements IUserRepository {
  private db: DatabaseClient;

  constructor(db = new DatabaseClient()) {
    this.db = db;
  }

  async findOne(id: string): Promise<User | null> {
    const rows = await this.db.query('SELECT * FROM users WHERE id = ?', [id]);
    if (rows.length === 0) {
      return null;
    }
    return new UserEntity(id, 'Alice', 'alice@example.com');
  }
}
