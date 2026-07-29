export interface ParsedSseEvent {
  event?: string;
  data: string;
}

export class SseDecoder {
  private buffer = "";

  push(chunk: string): ParsedSseEvent[] {
    this.buffer += chunk.replaceAll("\r\n", "\n");
    const events: ParsedSseEvent[] = [];
    let boundary = this.buffer.indexOf("\n\n");

    while (boundary >= 0) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const parsed = this.parseBlock(block);
      if (parsed) events.push(parsed);
      boundary = this.buffer.indexOf("\n\n");
    }

    return events;
  }

  finish(): ParsedSseEvent[] {
    const parsed = this.parseBlock(this.buffer);
    this.buffer = "";
    return parsed ? [parsed] : [];
  }

  private parseBlock(block: string): ParsedSseEvent | null {
    if (!block.trim()) return null;
    const data: string[] = [];
    let event: string | undefined;

    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }

    return data.length ? { event, data: data.join("\n") } : null;
  }
}
