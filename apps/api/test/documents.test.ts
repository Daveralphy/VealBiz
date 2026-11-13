import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { addMember, getApp, giveAccess, signUpWithOrg, type Client } from "./helpers";

/** Each request gets a random client IP so the per-IP sign-up rate limit doesn't trip across many test sign-ups. */
beforeAll(async () => {
  const app = await getApp();
  const orig = app.inject.bind(app) as (o: any) => any;
  const n = () => Math.floor(Math.random() * 250) + 1;
  (app as any).inject = (opts: any) => orig({ ...opts, headers: { "x-forwarded-for": `10.${n()}.${n()}.${n()}`, ...(opts?.headers ?? {}) } });
});

/** Uploads a file through POST /api/files using a hand-built multipart body. */
async function upload(app: FastifyInstance, c: Client, name: string, content: string | Buffer, query: Record<string, string> = {}, mime = "application/pdf") {
  const boundary = `----wv${randomUUID().replace(/-/g, "")}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`),
    Buffer.isBuffer(content) ? content : Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const qs = new URLSearchParams(query).toString();
  const res = await app.inject({
    method: "POST", url: `/api/files${qs ? `?${qs}` : ""}`, payload: body,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      cookie: Object.entries(c.cookies).map(([k, v]) => `${k}=${v}`).join("; "),
    },
  });
  return { status: res.statusCode, body: res.json() };
}

const uniq = (s: string) => `${s} ${randomUUID()}`;

describe("documents", () => {
  it("creates folders, uploads, detects duplicates and lists files", async () => {
    const app = await getApp();
    const { c: admin } = await signUpWithOrg(app);
    const f = await admin.post("/api/documents/folders", { name: "Suppliers" });
    expect(f.status).toBe(200);
    expect((await admin.post("/api/documents/folders", { name: "suppliers" })).status).toBe(409);
    const sub = await admin.post("/api/documents/folders", { name: "2026", parentId: f.body.id });
    expect(sub.body.parentId).toBe(f.body.id);

    const content = uniq("supplier terms");
    const up = await upload(app, admin, "supplier_terms.pdf", content, { folderId: f.body.id });
    expect(up.status).toBe(200);
    expect(up.body.file.folderId).toBe(f.body.id);

    const dup = await upload(app, admin, "copy.pdf", content, { folderId: sub.body.id });
    expect(dup.body.file).toBeNull();
    expect(dup.body.duplicateOf.id).toBe(up.body.file.id);
    const anyway = await upload(app, admin, "copy.pdf", content, { folderId: sub.body.id, allowDuplicate: "1" });
    expect(anyway.body.file.id).toBeTruthy();

    const bad = await upload(app, admin, "setup_tool.exe", "MZ", {}, "application/octet-stream");
    expect(bad.status).toBe(415);

    const list = await admin.get(`/api/documents/files?folderId=${f.body.id}`);
    expect(list.body.map((x: any) => x.name)).toEqual(["supplier_terms.pdf"]);
    expect(list.body[0].uploaderName).toBe("Amaka Okafor");

    const tree = await admin.get("/api/documents/folders");
    const node = tree.body.folders.find((x: any) => x.id === f.body.id);
    expect(node.fileCount).toBe(1);
    expect(node.totalCount).toBe(2);

    const search = await admin.get("/api/documents/files?q=supplier");
    expect(search.body.length).toBe(1);
    const pdfs = await admin.get("/api/documents/files?type=pdf&q=copy");
    expect(pdfs.body.length).toBe(1);

    // Rename, archive, unarchive
    const ren = await admin.patch(`/api/documents/files/${up.body.file.id}`, { name: "Supplier terms 2026.pdf", tags: ["terms"], category: "Supplier contract" });
    expect(ren.body.name).toBe("Supplier terms 2026.pdf");
    await admin.post(`/api/documents/files/${up.body.file.id}/archive`);
    expect((await admin.get("/api/documents/files?view=archive")).body.map((x: any) => x.id)).toContain(up.body.file.id);
    expect((await admin.get(`/api/documents/files?folderId=${f.body.id}`)).body).toHaveLength(0);
    await admin.post(`/api/documents/files/${up.body.file.id}/unarchive`);

    // Only empty folders can be deleted.
    expect((await admin.del(`/api/documents/folders/${f.body.id}`)).status).toBe(409);
    const empty = await admin.post("/api/documents/folders", { name: "Empty" });
    expect((await admin.del(`/api/documents/folders/${empty.body.id}`)).status).toBe(200);
  });

  it("hides restricted folders from people without access", async () => {
    const app = await getApp();
    const { c: admin } = await signUpWithOrg(app);
    const { c: member, email } = await addMember(app, admin, "member", "Kofi Mensah");
    await giveAccess(admin, email, { documents: "view" });
    const f = await admin.post("/api/documents/folders", { name: "Payroll" });
    expect((await member.patch(`/api/documents/folders/${f.body.id}`, { restricted: true, accessRoles: ["admin"] })).status).toBe(403);
    await admin.patch(`/api/documents/folders/${f.body.id}`, { restricted: true, accessRoles: ["admin"] });
    const up = await upload(app, admin, "payroll.pdf", uniq("payroll"), { folderId: f.body.id });

    const tree = await member.get("/api/documents/folders");
    const names = tree.body.folders.map((x: any) => x.name);
    expect(names).not.toContain("Payroll");
    expect(names).not.toContain("Employee files");
    expect(names).not.toContain("CVs and applications");
    expect(names).toContain("Contracts");
    expect((await member.get(`/api/documents/files/${up.body.file.id}`)).status).toBe(404);
    expect((await member.get(`/api/documents/files?q=payroll`)).body).toHaveLength(0);
    expect((await member.get(`/api/files/${up.body.file.id}/content`)).status).toBe(404);
    // With view access, they can look but not upload.
    expect((await upload(app, member, "mine.pdf", uniq("mine"))).status).toBe(403);

    const detail = await admin.get(`/api/documents/files/${up.body.file.id}`);
    expect(detail.body.access.restricted).toBe(true);
    expect(detail.body.access.rows.find((r: any) => r.who === "Members").level).toBe("No access");
  });

  it("keeps versions and restores an old one as a new version", async () => {
    const app = await getApp();
    const { c: admin } = await signUpWithOrg(app);
    const v1 = uniq("version one");
    const up = await upload(app, admin, "service_agreement.pdf", v1);
    const id = up.body.file.id;
    const v2 = await upload(app, admin, "service_agreement.pdf", uniq("version two"), { replaceFileId: id });
    expect(v2.body.file.currentVersion).toBe(2);

    const detail = await admin.get(`/api/documents/files/${id}`);
    expect(detail.body.versions.map((v: any) => v.version)).toEqual([2, 1]);
    const old = detail.body.versions.find((v: any) => v.version === 1);
    const r = await admin.post(`/api/documents/files/${id}/versions/${old.id}/restore`);
    expect(r.body.currentVersion).toBe(3);
    const content = await app.inject({ method: "GET", url: `/api/files/${id}/content`, headers: { cookie: Object.entries(admin.cookies).map(([k, v]) => `${k}=${v}`).join("; ") } });
    expect(content.body).toBe(v1);
    const after = await admin.get(`/api/documents/files/${id}`);
    expect(after.body.versions[0].note).toBe("Restored version 1");
    const current = after.body.versions.find((v: any) => v.current);
    expect(current.version).toBe(3);
  });

  it("links a file to a record and lists it", async () => {
    const app = await getApp();
    const { c: admin } = await signUpWithOrg(app);
    const task = await admin.post("/api/workflows/tasks", { title: "Renew service agreement" });
    const up = await upload(app, admin, "agreement.pdf", uniq("agreement"));
    const id = up.body.file.id;

    const targets = await admin.get("/api/documents/link-targets?q=renew");
    expect(targets.body.some((t: any) => t.type === "task" && t.id === task.body.id)).toBe(true);

    expect((await admin.post(`/api/documents/files/${id}/links`, { linkType: "task", linkId: randomUUID() })).status).toBe(400);
    const l = await admin.post(`/api/documents/files/${id}/links`, { linkType: "task", linkId: task.body.id });
    expect(l.status).toBe(200);

    const detail = await admin.get(`/api/documents/files/${id}`);
    expect(detail.body.links).toHaveLength(1);
    expect(detail.body.links[0].label).toBe("Renew service agreement");

    const linked = await admin.get("/api/documents/files?linked=task");
    expect(linked.body.map((x: any) => x.id)).toContain(id);
    expect(linked.body.find((x: any) => x.id === id).linkedTo.label).toBe("Renew service agreement");
    expect((await admin.get("/api/documents/files?linked=none")).body.map((x: any) => x.id)).not.toContain(id);

    const t = await admin.get(`/api/workflows/tasks/${task.body.id}`);
    expect(t.body.files.map((x: any) => x.id)).toContain(id);

    expect((await admin.del(`/api/documents/files/${id}/links/${l.body.id}`)).status).toBe(200);
    expect((await admin.get(`/api/documents/files/${id}`)).body.links).toHaveLength(0);
  });

  it("keeps files and folders inside their organisation", async () => {
    const app = await getApp();
    const a = await signUpWithOrg(app);
    const b = await signUpWithOrg(app);
    const folder = await a.c.post("/api/documents/folders", { name: "Private A" });
    const contentA = uniq("org a");
    const up = await upload(app, a.c, "a.pdf", contentA, { folderId: folder.body.id });
    expect((await b.c.get(`/api/documents/files/${up.body.file.id}`)).status).toBe(404);
    expect((await b.c.patch(`/api/documents/files/${up.body.file.id}`, { name: "x.pdf" })).status).toBe(404);
    expect((await b.c.get(`/api/documents/files?folderId=${folder.body.id}`)).status).toBe(404);
    expect((await b.c.patch(`/api/documents/folders/${folder.body.id}`, { name: "x" })).status).toBe(404);
    expect((await b.c.get("/api/documents/folders")).body.folders.map((f: any) => f.id)).not.toContain(folder.body.id);
    expect((await b.c.get("/api/documents/files?q=a.pdf")).body.map((f: any) => f.id)).not.toContain(up.body.file.id);
    // Same content in another org is not a duplicate.
    const same = await upload(app, b.c, "a.pdf", contentA);
    expect(same.body.duplicateOf).toBeNull();
  });

  it("dashboard counts files added this week and lists the next ones to expire", async () => {
    const app = await getApp();
    const { c: admin } = await signUpWithOrg(app);
    const day = (n: number) => { const d = new Date(Date.now() + n * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    const a = await upload(app, admin, "insurance.pdf", uniq("insurance"));
    const b = await upload(app, admin, "licence.pdf", uniq("licence"));
    const c = await upload(app, admin, "lease.pdf", uniq("lease"));
    await admin.patch(`/api/documents/files/${a.body.file.id}`, { expiresOn: day(20) });
    await admin.patch(`/api/documents/files/${b.body.file.id}`, { expiresOn: day(5) });
    await admin.patch(`/api/documents/files/${c.body.file.id}`, { expiresOn: day(90) });
    const r = await admin.get("/api/documents/dashboard");
    expect(r.status).toBe(200);
    expect(r.body.addedThisWeek).toBe(3);
    expect(r.body.expiringCount).toBe(2);
    expect(r.body.expiring.map((f: any) => f.name)).toEqual(["licence.pdf", "insurance.pdf"]);
    // Someone with only My Workspace can't see the business's files.
    const { c: none } = await addMember(app, admin, "member", "Ama Owusu");
    expect((await none.get("/api/documents/dashboard")).status).toBe(403);
  });
});
