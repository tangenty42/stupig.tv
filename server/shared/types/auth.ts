import type { User } from './user'

// No token: it is delivered as an httpOnly cookie the page cannot read.
export interface AuthResult {
  user: User
}
