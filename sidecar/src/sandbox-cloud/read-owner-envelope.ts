import { open } from "node:fs/promises";
import { readVskHeader, type Envelope } from "@veesker/engine";

export async function readOwnerEnvelopeFromVsk(
  path: string,
): Promise<Envelope> {
  const header = readVskHeader(path);
  if (header.envelopeLength === 0n) {
    throw new Error(
      "read-owner-envelope: vsk has no embedded owner envelope (envelopeLength=0)",
    );
  }

  const offset = Number(header.envelopeOffset);
  const length = Number(header.envelopeLength);
  const buf = Buffer.allocUnsafe(length);

  const fh = await open(path, "r");
  try {
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    if (bytesRead < length) {
      throw new Error(
        `read-owner-envelope: short read at envelope region (got ${bytesRead}/${length})`,
      );
    }
  } finally {
    await fh.close();
  }

  // The .vsk envelope JSON also contains a `blobNonce` field used by the
  // blob encryption layer (consumed by readEncryptedVsk). Only nonce +
  // ciphertext are needed here to reconstruct the Envelope for openEnvelope.
  let parsed: { nonce?: unknown; ciphertext?: unknown };
  try {
    parsed = JSON.parse(buf.toString("utf-8")) as typeof parsed;
  } catch (err) {
    throw new Error(
      `read-owner-envelope: envelope JSON parse failed: ${(err as Error).message}`,
    );
  }
  if (
    typeof parsed.nonce !== "string" ||
    typeof parsed.ciphertext !== "string"
  ) {
    throw new Error(
      "read-owner-envelope: envelope missing 'nonce' or 'ciphertext' string fields",
    );
  }

  return {
    nonce: Uint8Array.from(Buffer.from(parsed.nonce, "base64")),
    ciphertext: Uint8Array.from(Buffer.from(parsed.ciphertext, "base64")),
  };
}
