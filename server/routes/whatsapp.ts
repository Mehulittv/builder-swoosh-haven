import { Router } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";

export const whatsappRouter = Router();
const upload = multer({ storage: multer.memoryStorage() });

const TEMP_UPLOAD_DIR = path.resolve(process.cwd(), "server", "uploads_tmp");
const MEDIA_SIGN_KEY = process.env.MEDIA_SIGN_KEY || "dev-secret";
const MEDIA_TTL_MS = Number(process.env.MEDIA_URL_TTL_MS || 5 * 60 * 1000);
const MEDIA_PUBLIC_BASE = process.env.MEDIA_PUBLIC_BASE || ""; // e.g. https://your-domain.com

function ensureTempDir() {
  if (!fs.existsSync(TEMP_UPLOAD_DIR)) {
    fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });
  }
}

function sanitizeFilename(name: string) {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function timestampedName(originalName: string) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safe = sanitizeFilename(originalName || "attendance.png");
  return `${ts}__${safe}`;
}

function saveBufferToTemp(buffer: Buffer, originalName = "attendance.png") {
  ensureTempDir();
  const filename = timestampedName(originalName);
  const full = path.join(TEMP_UPLOAD_DIR, filename);
  fs.writeFileSync(full, buffer);
  return filename;
}

function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; mime: string } {
  const [meta, base64] = (dataUrl || "").split(",");
  const mimeMatch = /data:([^;]+);base64/.exec(meta || "");
  const mime = mimeMatch ? mimeMatch[1] : "image/png";
  const buffer = Buffer.from(base64 || "", "base64");
  return { buffer, mime };
}

function getOrigin(req: any) {
  const xfProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0];
  const xfHost = String(req.headers["x-forwarded-host"] || "").split(",")[0];
  const protocol = xfProto || req.protocol || "http";
  const host = xfHost || req.get("host");
  return `${protocol}://${host}`;
}

function getPublicBase(req: any) {
  const base = MEDIA_PUBLIC_BASE.trim();
  if (base) return base.replace(/\/$/, "");
  return getOrigin(req);
}

function signMedia(filename: string, exp: string) {
  return crypto
    .createHmac("sha256", MEDIA_SIGN_KEY)
    .update(`${filename}:${exp}`)
    .digest("hex");
}

async function postJson(target: string, payload: any) {
  const resp = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { ok: resp.ok, status: resp.status, body: json } as const;
}

async function postFormUrlEncoded(
  target: string,
  payload: Record<string, string>,
) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(payload)) params.append(k, v);
  const resp = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const text = await resp.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { ok: resp.ok, status: resp.status, body: json } as const;
}

whatsappRouter.post("/send", upload.single("file"), async (req, res) => {
  try {
    const { endpoint, appkey, authkey, to, message, imageDataUrl } =
      req.body || {};
    if (!endpoint || !appkey || !authkey || !to || !message) {
      return res
        .status(400)
        .json({ error: "Missing endpoint/appkey/authkey/to/message" });
    }

    let buffer: Buffer | null = null;
    let originalName = "attendance.png";

    if (req.file && req.file.buffer) {
      buffer = Buffer.from(
        req.file.buffer.buffer,
        req.file.buffer.byteOffset,
        req.file.buffer.byteLength,
      );
      originalName = req.file.originalname || originalName;
    } else if (imageDataUrl) {
      const d = dataUrlToBuffer(String(imageDataUrl));
      buffer = d.buffer;
    }

    let tempUrl: string | undefined = undefined;
    if (buffer) {
      const filename = saveBufferToTemp(buffer, originalName);
      const base = getPublicBase(req);
      tempUrl = `${base}/uploads_tmp/${filename}`;
    }

    const basePayload: any = {
      appkey: String(appkey),
      authkey: String(authkey),
      to: String(to),
      message: String(message),
    };
    if ((req.body as any)?.template_id)
      basePayload.template_id = String((req.body as any).template_id);

    // Prefer sending x-www-form-urlencoded with URL in 'file'; never send multipart/binary
    const formPayload: Record<string, string> = { ...basePayload };
    if (tempUrl) formPayload.file = tempUrl;
    let result = await postFormUrlEncoded(String(endpoint), formPayload);

    // Fallback to JSON with 'file' URL
    if (!result.ok) {
      const jsonPayload = tempUrl
        ? { ...basePayload, file: tempUrl }
        : { ...basePayload };
      result = await postJson(String(endpoint), jsonPayload);
    }

    if (!result.ok) {
      return res
        .status(result.status || 502)
        .json({ error: "Remote API error", response: result.body });
    }

    res.json({ ok: true, response: result.body });
  } catch (e: any) {
    res
      .status(500)
      .json({
        error: "Failed to send WhatsApp",
        detail: e?.message || String(e),
      });
  }
});
