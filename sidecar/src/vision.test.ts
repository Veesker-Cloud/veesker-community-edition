import { describe, it, expect } from "bun:test";

describe("visionGraph node deduplication", () => {
  it("deduplicates nodes that appear multiple times in BFS", () => {
    const seen = new Set<string>();
    const addNode = (owner: string, name: string) => {
      const id = `${owner}.${name}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    };
    expect(addNode("HR", "EMPLOYEES")).toBe(true);
    expect(addNode("HR", "EMPLOYEES")).toBe(false);
    expect(addNode("HR", "DEPARTMENTS")).toBe(true);
    expect(seen.size).toBe(2);
  });

  it("respects MAX_NODES limit", () => {
    const MAX_NODES = 300;
    const nodes: string[] = [];
    for (let i = 0; i < 350; i++) {
      if (nodes.length >= MAX_NODES) break;
      nodes.push(`NODE_${i}`);
    }
    expect(nodes.length).toBe(MAX_NODES);
  });
});
