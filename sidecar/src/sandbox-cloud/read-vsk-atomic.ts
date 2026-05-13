import { open } from "node:fs/promises";
import { constants } from "node:fs";
import type { Envelope } from "@veesker/engine";

export interface AtomicVskRead {
  envelope: Envelope;
  fileBytes: Uint8Array;
}

const HEADER_SIZE = 64;
const VSK_MAGIC = 0x56534b21;

// O_NOFOLLOW asks the kernel to fail with ELOOP if the path is a symlink,
// closing the TOCTOU symlink-replacement window between validateOutPath's
// path-based lstat and our open(). Windows has no equivalent flag (the
// constant is undefined there), so this hardening is POSIX-only — Windows
// continues to rely on the lstat check in validateOutPath, which has a
// known small race that is documented in the threat model.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

interface ParsedHeader {
  magic: number;
  version: number;
  envelopeOffset: bigint;
  envelopeLength: bigint;
}

function parseHeader(buf: Uint8Array): ParsedHeader {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    magic: view.getUint32(0, false),
    version: view.getUint16(4, true),
    envelopeOffset: view.getBigUint64(40, true),
    envelopeLength: view.getBigUint64(48, true),
  };
}

/**
 * Read the encryption envelope and full bytes of a .vsk file using a single
 * file handle, defending against TOCTOU races where a separate path-based
 * `validateOutPath` lstat could pass against one file and subsequent reads
 * against another (e.g. an attacker swapping the file between calls in the
 * trusted but not exclusively-ours `app_data/sandbox-builds/` directory).
 *
 * The handle is opened once, an fstat confirms it is a regular file, and
 * every subsequent byte read goes through the same handle. The path is no
 * longer reopened, so symlink/junction/file replacement races between
 * stat and reads cannot affect the bytes the publisher sends to R2.
 */
export async function readVskAtomic(path: string): Promise<AtomicVskRead> {
  const fh = await open(path, OPEN_FLAGS);
  try {
    const stat = await fh.stat();
    if (!stat.isFile()) {
      throw new Error("read-vsk-atomic: not a regular file (per fstat)");
    }
    const fileSize = stat.size;
    if (fileSize < HEADER_SIZE) {
      throw new Error(
        `read-vsk-atomic: file too small (${fileSize} bytes < ${HEADER_SIZE})`,
      );
    }

    const headerBuf = Buffer.allocUnsafe(HEADER_SIZE);
    let r = await fh.read(headerBuf, 0, HEADER_SIZE, 0);
    if (r.bytesRead < HEADER_SIZE) {
      throw new Error(
        `read-vsk-atomic: short read on header (${r.bytesRead}/${HEADER_SIZE})`,
      );
    }
    const header = parseHeader(
      new Uint8Array(headerBuf.buffer, headerBuf.byteOffset, HEADER_SIZE),
    );
    if (header.magic !== VSK_MAGIC) {
      throw new Error(
        `read-vsk-atomic: bad magic (expected 0x${VSK_MAGIC.toString(16)}, got 0x${header.magic.toString(16)})`,
      );
    }
    if (header.envelopeLength === 0n) {
      throw new Error(
        "read-vsk-atomic: vsk has no embedded owner envelope (envelopeLength=0)",
      );
    }
    const envOffset = Number(header.envelopeOffset);
    const envLength = Number(header.envelopeLength);
    if (envOffset + envLength > fileSize) {
      throw new Error(
        `read-vsk-atomic: envelope region extends past file (${envOffset}+${envLength} > ${fileSize})`,
      );
    }

    const envBuf = Buffer.allocUnsafe(envLength);
    r = await fh.read(envBuf, 0, envLength, envOffset);
    if (r.bytesRead < envLength) {
      throw new Error(
        `read-vsk-atomic: short read on envelope (${r.bytesRead}/${envLength})`,
      );
    }

    let parsed: { nonce?: unknown; ciphertext?: unknown };
    try {
      parsed = JSON.parse(envBuf.toString("utf-8")) as typeof parsed;
    } catch (err) {
      throw new Error(
        `read-vsk-atomic: envelope JSON parse failed: ${(err as Error).message}`,
      );
    }
    if (
      typeof parsed.nonce !== "string" ||
      typeof parsed.ciphertext !== "string"
    ) {
      throw new Error(
        "read-vsk-atomic: envelope missing 'nonce' or 'ciphertext' string fields",
      );
    }

    const fileBuf = Buffer.allocUnsafe(fileSize);
    r = await fh.read(fileBuf, 0, fileSize, 0);
    if (r.bytesRead < fileSize) {
      throw new Error(
        `read-vsk-atomic: short read on full file (${r.bytesRead}/${fileSize})`,
      );
    }

    const envelope: Envelope = {
      nonce: Uint8Array.from(Buffer.from(parsed.nonce, "base64")),
      ciphertext: Uint8Array.from(Buffer.from(parsed.ciphertext, "base64")),
    };
    return {
      envelope,
      fileBytes: new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileSize),
    };
  } finally {
    await fh.close();
  }
}
