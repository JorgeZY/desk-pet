import { describe, expect, it, vi } from "vitest";
import { KnowledgeToolProvider } from "./knowledge-tool-provider";

describe("KnowledgeToolProvider", () => {
  it("exposes a read-only bounded local search tool", async () => {
    const search = vi.fn(() => [{
      chunkId: "doc-1:0",
      documentId: "doc-1",
      documentName: "材料说明.md",
      position: 0,
      score: 2,
      text: "碳纤维".repeat(500),
    }]);
    const provider = new KnowledgeToolProvider({
      listDocuments: () => [{
        id: "doc-1",
        path: "D:\\docs\\材料说明.md",
        name: "材料说明.md",
        mimeType: "text/plain",
        characterCount: 2_000,
        chunkCount: 2,
        createdAt: 1,
        updatedAt: 1,
      }],
      search,
    });

    await provider.start();
    const [descriptor] = provider.getDescriptors();
    expect(descriptor).toMatchObject({
      name: "search_local_knowledge",
      source: "knowledge",
      requiresApproval: false,
    });
    const execute = descriptor?.tool.execute;
    expect(execute).toBeTypeOf("function");
    const result = await execute?.(
      { query: "外壳材料", limit: 99 },
      { toolCallId: "call-1", messages: [], context: undefined },
    );
    expect(search).toHaveBeenCalledWith("外壳材料", 5);
    expect(String(result)).toContain("材料说明.md · 片段 1");
    expect(String(result).length).toBeLessThan(500);
  });

  it("explains how to add documents when the knowledge base is empty", async () => {
    const provider = new KnowledgeToolProvider({
      listDocuments: () => [],
      search: vi.fn(() => []),
    });
    const execute = provider.getDescriptors()[0]?.tool.execute;
    await expect(execute?.(
      { query: "项目规范" },
      { toolCallId: "call-1", messages: [], context: undefined },
    )).resolves.toContain("知识库为空");
  });

  it("awaits an asynchronous hybrid retriever", async () => {
    const search = vi.fn(async () => [{
      chunkId: "doc-1:0",
      documentId: "doc-1",
      documentName: "异步检索.md",
      position: 0,
      score: 0.03,
      text: "来自混合检索的结果。",
    }]);
    const provider = new KnowledgeToolProvider({
      listDocuments: async () => [{
        id: "doc-1",
        path: "D:\\docs\\异步检索.md",
        name: "异步检索.md",
        mimeType: "text/plain",
        characterCount: 10,
        chunkCount: 1,
        createdAt: 1,
        updatedAt: 1,
      }],
      search,
    });

    const result = await provider.getDescriptors()[0]?.tool.execute?.(
      { query: "混合检索" },
      { toolCallId: "call-async", messages: [], context: undefined },
    );
    expect(search).toHaveBeenCalledWith("混合检索", 3);
    expect(result).toContain("异步检索.md");
  });
});
