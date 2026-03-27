import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const IV_LEN = 16;
const TAG_LEN = 16;
const SALT = "npc-credentials-v1";

function keyFromSecret(secret: string): Buffer {
  return scryptSync(secret, SALT, 32);
}

/** Mã hóa mật khẩu trước khi ghi Mongo (cần NPC_CREDENTIALS_SECRET). */
export function encryptNpcPassword(plain: string, secret: string): string {
  const key = keyFromSecret(secret);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptNpcPassword(encryptedB64: string, secret: string): string {
  const buf = Buffer.from(encryptedB64, "base64");
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error("npcCredentials: dữ liệu mã hóa không hợp lệ");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const key = keyFromSecret(secret);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
