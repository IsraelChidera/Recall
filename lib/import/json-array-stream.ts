/**
 * Splits a JSON document whose root is an array into its top-level elements,
 * reading the document as a stream of byte chunks.
 *
 * Only one element is ever buffered, so memory use is bounded by the largest
 * element, not by the size of the file. That is what lets a multi-hundred
 * megabyte conversations.json be parsed in a browser tab.
 *
 * The scanner works on bytes. All JSON structural characters are ASCII and
 * UTF-8 never uses ASCII byte values inside a multi-byte character, so chunk
 * boundaries may fall anywhere, including inside a character.
 */
const enum State {
  BeforeArray,
  BetweenElements,
  InElement,
  AfterArray,
}

const enum Kind {
  Container,
  String,
  Primitive,
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

export class JsonArrayStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonArrayStreamError";
  }
}

export class JsonArrayElementSplitter {
  private state = State.BeforeArray;
  private kind = Kind.Container;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private parts: Uint8Array[] = [];
  private buffered = 0;
  private bytesSeen = 0;

  /** Largest number of bytes held for a single element so far. */
  peakBufferedBytes = 0;

  constructor(private readonly maxElementBytes: number = 64 * 1024 * 1024) {}

  /** Feeds a chunk and returns the elements completed by it, as UTF-8 bytes. */
  push(chunk: Uint8Array): Uint8Array[] {
    const completed: Uint8Array[] = [];
    let elementStart = this.state === State.InElement ? 0 : -1;

    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index] as number;
      const position = this.bytesSeen + index;

      switch (this.state) {
        case State.BeforeArray: {
          // Tolerate a UTF-8 byte order mark at the very start.
          if (position < 3 && (byte === 0xef || byte === 0xbb || byte === 0xbf)) break;
          if (isWhitespace(byte)) break;
          if (byte !== OPEN_BRACKET) {
            throw new JsonArrayStreamError("Expected the file to contain a JSON array.");
          }
          this.state = State.BetweenElements;
          break;
        }

        case State.BetweenElements: {
          if (isWhitespace(byte) || byte === COMMA) break;
          if (byte === CLOSE_BRACKET) {
            this.state = State.AfterArray;
            break;
          }
          this.state = State.InElement;
          elementStart = index;
          this.depth = 0;
          this.inString = false;
          this.escaped = false;
          if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
            this.kind = Kind.Container;
            this.depth = 1;
          } else if (byte === QUOTE) {
            this.kind = Kind.String;
            this.inString = true;
          } else {
            this.kind = Kind.Primitive;
          }
          break;
        }

        case State.InElement: {
          let endExclusive = -1;
          let closesArray = false;

          if (this.inString) {
            if (this.escaped) this.escaped = false;
            else if (byte === BACKSLASH) this.escaped = true;
            else if (byte === QUOTE) {
              this.inString = false;
              if (this.kind === Kind.String) endExclusive = index + 1;
            }
          } else if (this.kind === Kind.Primitive) {
            if (byte === COMMA || isWhitespace(byte)) endExclusive = index;
            else if (byte === CLOSE_BRACKET) {
              endExclusive = index;
              closesArray = true;
            }
          } else if (byte === QUOTE) {
            this.inString = true;
          } else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
            this.depth++;
          } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
            this.depth--;
            if (this.depth === 0) endExclusive = index + 1;
          }

          if (endExclusive !== -1) {
            this.buffer(chunk.subarray(elementStart, endExclusive));
            completed.push(this.take());
            elementStart = -1;
            this.state = closesArray ? State.AfterArray : State.BetweenElements;
          }
          break;
        }

        case State.AfterArray: {
          if (!isWhitespace(byte)) {
            throw new JsonArrayStreamError("Unexpected content after the end of the JSON array.");
          }
          break;
        }
      }
    }

    if (this.state === State.InElement && elementStart !== -1) {
      // Copy: the caller may reuse the chunk's underlying buffer.
      this.buffer(chunk.slice(elementStart));
    }
    this.bytesSeen += chunk.length;
    return completed;
  }

  /** Call after the last chunk. Throws if the document ended early. */
  end(): void {
    if (this.state === State.BeforeArray) {
      throw new JsonArrayStreamError("The file is empty.");
    }
    if (this.state !== State.AfterArray) {
      throw new JsonArrayStreamError("The file ended before the JSON array was closed.");
    }
  }

  private buffer(part: Uint8Array): void {
    if (part.length === 0) return;
    this.buffered += part.length;
    if (this.buffered > this.maxElementBytes) {
      throw new JsonArrayStreamError("A single conversation exceeds the size limit.");
    }
    this.parts.push(part);
    if (this.buffered > this.peakBufferedBytes) this.peakBufferedBytes = this.buffered;
  }

  private take(): Uint8Array {
    const [first] = this.parts;
    let element: Uint8Array;
    if (this.parts.length === 1 && first) {
      element = first;
    } else {
      element = new Uint8Array(this.buffered);
      let offset = 0;
      for (const part of this.parts) {
        element.set(part, offset);
        offset += part.length;
      }
    }
    this.parts = [];
    this.buffered = 0;
    return element;
  }
}
