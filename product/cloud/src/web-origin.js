import { AsyncLocalStorage } from "node:async_hooks";

// Request Origin for Better Auth session.create hooks. Password sign-in on a
// trusted SPA origin writes a browser_sessions row; iOS (no that Origin)
// must not.
export const webOriginStore = new AsyncLocalStorage();
