import type { NodeGetCharacterManifestResult } from "@tylerwarburton/sprite-core-schema";
import { authHeader } from "../api/auth.js";

// Decode raw asset bytes into a blob URL the browser can render in <img>.
// Cache the URL so decodes aren't repeated; revoke on player replacement /
// unmount to avoid leaking blob URLs.
export type DecodedImage = { url: string; revoke: () => void };

export function decodeToImage(bytes: Uint8Array): DecodedImage | null {
  // Infer MIME from magic bytes. The UI only supports formats the plugin's
  // sprite pipeline actually emits (png/webp/jpg/gif), so a narrow sniffer is
  // enough. If we miss, the browser will render nothing — not a crash.
  const mime = sniffMime(bytes);
  if (!mime) return null;
  // TS 5.7+ types Uint8Array as <ArrayBufferLike>, which won't assign to
  // Blob's BlobPart (wants ArrayBuffer-backed). The runtime contract is
  // identical so the cast is safe; a copy would work too but is wasted.
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  return { url, revoke: () => URL.revokeObjectURL(url) };
}

export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export async function fetchManifest(
  agentId: string,
): Promise<NodeGetCharacterManifestResult | null> {
  const res = await fetch(
    `/sprite-core/character-manifest?agentId=${encodeURIComponent(agentId)}`,
    { credentials: "same-origin", headers: { ...authHeader() } },
  );
  if (!res.ok) return null;
  return (await res.json()) as NodeGetCharacterManifestResult;
}

export async function fetchAsset(relativePath: string): Promise<Uint8Array | null> {
  const res = await fetch(`/openclaw-assets/${relativePath}`, {
    credentials: "same-origin",
    headers: { ...authHeader() },
  });
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}
