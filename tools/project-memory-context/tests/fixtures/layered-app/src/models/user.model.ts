export interface User {
  id: string;
  name: string;
  email: string;
}

export class UserEntity implements User {
  id: string;
  name: string;
  email: string;

  constructor(id: string, name: string, email: string) {
    this.id = id;
    this.name = name;
    this.email = email;
  }
}
