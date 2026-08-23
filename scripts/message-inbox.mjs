import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const MESSAGE_TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function ingestMessageInbox({
  inbox,
  db,
  audit = () => {},
  now = () => new Date().toISOString(),
  json = (value) => JSON.stringify(value ?? {}),
}) {
  let imported = 0;
  for (const name of fs.readdirSync(inbox)) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(inbox, name);
    let envelope;
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
        throw new Error("message envelope must be a regular file no larger than 1 MiB");
      }
      envelope = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (typeof envelope.id !== "string" || !MESSAGE_ID.test(envelope.id) ||
          name !== `${envelope.id}.json` ||
          typeof envelope.sender !== "string" || envelope.sender.length > 256 ||
          typeof envelope.recipient !== "string" || envelope.recipient.length > 256 ||
          typeof envelope.subject !== "string" || envelope.subject.length > 4096 ||
          typeof envelope.body !== "string" || Buffer.byteLength(envelope.body) > 512 * 1024) {
        throw new Error("missing or inconsistent required envelope fields");
      }
      if (envelope.target_bot_id !== undefined && envelope.target_bot_id !== null &&
          !MESSAGE_TARGET_ID.test(envelope.target_bot_id)) {
        throw new Error("target_bot_id is invalid");
      }
      if (envelope.notify_receiver !== undefined &&
          typeof envelope.notify_receiver !== "boolean") {
        throw new Error("notify_receiver must be a boolean");
      }
      if (envelope.metadata !== undefined &&
          (!envelope.metadata || typeof envelope.metadata !== "object" ||
           Array.isArray(envelope.metadata))) {
        throw new Error("message metadata must be an object");
      }
      const metadataTarget = envelope.metadata?.target_bot_id;
      const metadataNotify = envelope.metadata?.notify_receiver;
      if (metadataTarget !== undefined && !MESSAGE_TARGET_ID.test(metadataTarget)) {
        throw new Error("metadata.target_bot_id is invalid");
      }
      if (metadataNotify !== undefined && typeof metadataNotify !== "boolean") {
        throw new Error("metadata.notify_receiver must be a boolean");
      }
      if (Object.hasOwn(envelope, "target_bot_id") && metadataTarget !== undefined &&
          envelope.target_bot_id !== metadataTarget) {
        throw new Error("top-level and metadata target_bot_id disagree");
      }
      if (Object.hasOwn(envelope, "notify_receiver") && metadataNotify !== undefined &&
          envelope.notify_receiver !== metadataNotify) {
        throw new Error("top-level and metadata notify_receiver disagree");
      }
      const metadata = { ...(envelope.metadata || {}) };
      if (envelope.target_bot_id) metadata.target_bot_id = envelope.target_bot_id;
      if (envelope.notify_receiver !== undefined) {
        metadata.notify_receiver = envelope.notify_receiver;
      }
      const existing = db.prepare(`
        SELECT created_at,sender,recipient,kind,subject,body,correlation_id,
               delivered_via,metadata_json
        FROM messages WHERE id=?
      `).get(envelope.id);
      if (existing) {
        const duplicate = {
          created_at: envelope.created_at || null,
          sender: envelope.sender,
          recipient: envelope.recipient,
          kind: envelope.kind || "message",
          subject: envelope.subject,
          body: envelope.body,
          correlation_id: envelope.correlation_id || null,
          delivered_via: envelope.delivered_via || null,
          metadata,
        };
        const canonical = {
          ...existing,
          metadata: JSON.parse(existing.metadata_json || "{}"),
        };
        delete canonical.metadata_json;
        if (!isDeepStrictEqual(duplicate, canonical)) {
          throw new Error("duplicate message ID disagrees with the durable canonical envelope");
        }
        continue;
      }
      db.prepare(`
        INSERT INTO messages
          (id,created_at,sender,recipient,kind,subject,body,correlation_id,
           direction,state,envelope_path,delivered_via,metadata_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        envelope.id,
        envelope.created_at || now(),
        envelope.sender,
        envelope.recipient,
        envelope.kind || "message",
        envelope.subject,
        envelope.body,
        envelope.correlation_id || null,
        "inbound",
        envelope.kind === "acknowledgement" ? "acknowledged" : "received",
        filePath,
        envelope.delivered_via || null,
        json(metadata),
      );
      if (envelope.kind === "acknowledgement" && envelope.correlation_id) {
        db.prepare(`
          UPDATE messages
          SET state='acknowledged', acknowledged_at=?
          WHERE id=? AND direction='outbound'
        `).run(envelope.created_at || now(), envelope.correlation_id);
      }
      audit("ingest", "message", envelope.id, "received", { file_path: filePath });
      imported += 1;
    } catch (error) {
      audit("ingest", "message", name, "rejected", { error: String(error) });
    }
  }
  return imported;
}
