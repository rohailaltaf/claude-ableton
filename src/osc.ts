/**
 * Thin OSC client for talking to AbletonOSC.
 *
 * Sends commands to 127.0.0.1:11000 and receives replies on 127.0.0.1:11001.
 * Reply correlation is by OSC address: a query registers a one-shot handler
 * for the expected reply address, sends the request, and awaits. Concurrent
 * queries to the same address are not supported (MCP stdio serializes tool
 * calls and our handlers await sequentially, so this is fine).
 *
 * OSC 1.0 wire format is hand-rolled (encode/decode) over Node's dgram. We
 * only need int32 / float32 / string / bool, which is all AbletonOSC ever
 * sends or receives. JavaScript has a single `number` type with no int/float
 * distinction, so call sites MUST wrap numeric args with `i()` (int32) or
 * `f()` (float32) — bare numbers are a compile error in `SendArg`.
 */

import dgram from "node:dgram";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_SEND_PORT = 11000;
export const DEFAULT_RECV_PORT = 11001;
export const DEFAULT_TIMEOUT_MS = 500;

/** An explicitly-typed numeric OSC argument. */
export type TypedArg = { type: "i" | "f"; value: number };

/** Force an int32 OSC argument. */
export const i = (v: number): TypedArg => ({ type: "i", value: Math.trunc(v) });
/** Force a float32 OSC argument. */
export const f = (v: number): TypedArg => ({ type: "f", value: v });

/**
 * What a tool may pass as an OSC argument. Bare `number` is intentionally
 * excluded: callers must choose `i()` or `f()` so the wire type is unambiguous
 * (mirrors python-osc's runtime int-vs-float inference).
 */
export type SendArg = TypedArg | string | boolean;

/** A value decoded from an OSC reply. */
export type OscValue = number | string | boolean;

export class BridgeUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeUnreachable";
  }
}

export class QueryTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryTimeout";
  }
}

// --- OSC encoding ---------------------------------------------------------

/** Encode an OSC string: UTF-8 bytes + null terminator, zero-padded to 4. */
function encodeString(s: string): Buffer {
  const raw = Buffer.from(s, "utf8");
  const padded = Math.ceil((raw.length + 1) / 4) * 4;
  const buf = Buffer.alloc(padded); // zero-filled → includes the null terminator
  raw.copy(buf, 0);
  return buf;
}

function encodeMessage(address: string, args: SendArg[]): Buffer {
  let typeTags = ",";
  const argBufs: Buffer[] = [];
  for (const a of args) {
    if (typeof a === "string") {
      typeTags += "s";
      argBufs.push(encodeString(a));
    } else if (typeof a === "boolean") {
      typeTags += a ? "T" : "F"; // booleans carry no data bytes
    } else if (a.type === "i") {
      typeTags += "i";
      const b = Buffer.alloc(4);
      b.writeInt32BE(Math.trunc(a.value));
      argBufs.push(b);
    } else {
      typeTags += "f";
      const b = Buffer.alloc(4);
      b.writeFloatBE(a.value);
      argBufs.push(b);
    }
  }
  return Buffer.concat([encodeString(address), encodeString(typeTags), ...argBufs]);
}

// --- OSC decoding ---------------------------------------------------------

function decodeString(buf: Buffer, offset: number): [string, number] {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  const s = buf.toString("utf8", offset, end);
  const next = Math.ceil((end + 1) / 4) * 4; // past the null, up to 4-byte boundary
  return [s, next];
}

function decodeMessage(buf: Buffer): { address: string; args: OscValue[] } {
  let offset = 0;
  let address: string;
  [address, offset] = decodeString(buf, offset);
  const args: OscValue[] = [];
  if (offset >= buf.length) return { address, args };

  let typeTags: string;
  [typeTags, offset] = decodeString(buf, offset);
  if (!typeTags.startsWith(",")) return { address, args };

  for (let k = 1; k < typeTags.length; k++) {
    const t = typeTags[k];
    if (t === "i") {
      args.push(buf.readInt32BE(offset));
      offset += 4;
    } else if (t === "f") {
      args.push(buf.readFloatBE(offset));
      offset += 4;
    } else if (t === "s" || t === "S") {
      const [s, next] = decodeString(buf, offset);
      args.push(s);
      offset = next;
    } else if (t === "T") {
      args.push(true);
    } else if (t === "F") {
      args.push(false);
    } else if (t === "d") {
      args.push(buf.readDoubleBE(offset));
      offset += 8;
    } else if (t === "h") {
      args.push(Number(buf.readBigInt64BE(offset)));
      offset += 8;
    } else if (t === "b") {
      const size = buf.readInt32BE(offset);
      offset += 4 + Math.ceil(size / 4) * 4; // skip blob payload + padding
    } else {
      // Unknown tag: we can't know its width, so stop parsing safely.
      break;
    }
  }
  return { address, args };
}

// --- Client ---------------------------------------------------------------

export interface AbletonClientOptions {
  host?: string;
  sendPort?: number;
  recvPort?: number;
  /** Bind the receive socket (needed for queries). Set false for send-only. */
  bind?: boolean;
}

export class AbletonClient {
  private socket: dgram.Socket;
  private handlers = new Map<string, (args: OscValue[]) => void>();
  private host: string;
  private sendPort: number;
  private ready: Promise<void>;

  constructor(opts: AbletonClientOptions = {}) {
    this.host = opts.host ?? DEFAULT_HOST;
    this.sendPort = opts.sendPort ?? DEFAULT_SEND_PORT;
    const recvPort = opts.recvPort ?? DEFAULT_RECV_PORT;
    const bind = opts.bind ?? true;

    this.socket = dgram.createSocket("udp4");
    this.socket.on("message", (msg) => this.onReply(msg));
    this.socket.on("error", (err) => {
      // Surface socket errors on stderr; never stdout (it's the MCP channel).
      console.error(`[osc] socket error: ${err.message}`);
    });

    if (bind) {
      this.ready = new Promise<void>((resolve, reject) => {
        this.socket.once("listening", () => resolve());
        this.socket.once("error", reject);
        this.socket.bind(recvPort, this.host);
      });
    } else {
      this.ready = Promise.resolve();
    }
  }

  private onReply(msg: Buffer): void {
    let decoded: { address: string; args: OscValue[] };
    try {
      decoded = decodeMessage(msg);
    } catch {
      return; // ignore malformed packets
    }
    const handler = this.handlers.get(decoded.address);
    if (handler) handler(decoded.args);
  }

  /** Fire-and-forget: send a message without waiting for a reply. */
  send(address: string, ...args: SendArg[]): void {
    const buf = encodeMessage(address, args);
    this.socket.send(buf, this.sendPort, this.host);
  }

  /** Send a message and wait for a reply on the same address. */
  async query(
    address: string,
    args: SendArg[] = [],
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<OscValue[]> {
    await this.ready;
    return new Promise<OscValue[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handlers.delete(address);
        reject(new QueryTimeout(`No reply to ${address} within ${timeoutMs}ms`));
      }, timeoutMs);

      this.handlers.set(address, (replyArgs) => {
        clearTimeout(timer);
        this.handlers.delete(address);
        resolve(replyArgs);
      });

      this.socket.send(encodeMessage(address, args), this.sendPort, this.host);
    });
  }

  /** Verify the bridge is reachable; raise BridgeUnreachable if not. */
  async pingOrRaise(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<void> {
    try {
      await this.query("/live/test", [], timeoutMs);
    } catch (e) {
      if (e instanceof QueryTimeout) {
        throw new BridgeUnreachable(
          `Ableton Live not reachable at the OSC bridge (${e.message}). ` +
            "Is Live running with AbletonOSC selected as a Control Surface?",
        );
      }
      throw e;
    }
  }

  close(): void {
    this.socket.close();
  }
}
