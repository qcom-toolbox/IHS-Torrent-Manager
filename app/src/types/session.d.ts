import 'express-session';

declare module 'express-session' {
  interface SessionData {
    userId?: number;
    username?: string;
    isAdmin?: boolean;
    csrfToken?: string;
  }
}
