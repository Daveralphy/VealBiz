import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type Mail = { to: string; subject: string; text: string; link?: string; code?: string };

/**
 * Email adapter. In development, emails are written to apps/api/.mailbox and shown at
 * /api/dev/mailbox (and the app's "Dev mailbox" page) so codes and links can be used
 * without a real email provider. A real provider (SMTP / API) plugs in here later.
 */
const MAILBOX = path.resolve(".mailbox");
const memory: (Mail & { id: string; sentAt: string })[] = [];

export async function sendMail(mail: Mail): Promise<void> {
  const entry = { ...mail, id: randomUUID(), sentAt: new Date().toISOString() };
  memory.unshift(entry);
  // Tests send a lot (every WindVeal staff account they made gets new-business emails), so keep more there.
  if (memory.length > (process.env.VITEST ? 20_000 : 200)) memory.pop();
  if (process.env.VITEST) return;
  try {
    await fs.mkdir(MAILBOX, { recursive: true });
    await fs.writeFile(path.join(MAILBOX, `${Date.now()}-${entry.id}.json`), JSON.stringify(entry, null, 2));
  } catch {
    /* mailbox is best-effort in dev */
  }
  console.log(`\n📧  To: ${mail.to}\n    ${mail.subject}${mail.code ? `\n    Code: ${mail.code}` : ""}${mail.link ? `\n    Link: ${mail.link}` : ""}\n`);
}

export function recentMail(to?: string) {
  return to ? memory.filter((m) => m.to === to) : memory;
}
