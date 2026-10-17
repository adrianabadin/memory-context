import { UserService } from '../services/user.service';
import { User } from '../models/user.model';

function Controller() {
  return (target: any) => target;
}

@Controller()
export class UserController {
  private userService: UserService;

  constructor(userService = new UserService()) {
    this.userService = userService;
  }

  async getUser(id: string): Promise<User | null> {
    return this.userService.findById(id);
  }
}
