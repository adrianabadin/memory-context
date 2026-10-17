import { User } from '../models/user.model';
import { formatName } from '../utils/format';

export function renderUser(user: User): string {
  return `<div class="user-card">${formatName(user.name)}</div>`;
}
