/** Sai tài khoản/mật khẩu — worker sẽ đánh dấu npc_accounts, không coi là lỗi captcha. */
export class NpcLoginWrongCredentialsError extends Error {
  readonly code = "NPC_WRONG_PASSWORD" as const;
  constructor(message = "NPC: Tài khoản/mật khẩu không chính xác (SSR).") {
    super(message);
    this.name = "NpcLoginWrongCredentialsError";
  }
}

export function isNpcLoginWrongCredentialsError(err: unknown): err is NpcLoginWrongCredentialsError {
  return err instanceof NpcLoginWrongCredentialsError;
}
