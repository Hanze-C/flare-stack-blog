export type ApiContext = {
  headers: Headers;
  env: Env;
  executionCtx: ExecutionContext<unknown>;
  db: DB;
  /** Builds Better Auth on first use, so public procedures never pay for it. */
  getAuth: () => Auth;
};

export type AuthedApiContext = ApiContext & {
  session: Session;
};
