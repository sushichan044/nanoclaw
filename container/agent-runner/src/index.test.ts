import { beforeEach, describe, expect, it, vi } from "vitest";

const existsSync = vi.fn<(path: string) => boolean>();
const readFileSync = vi.fn<(path: string, encoding: string) => string>();

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync,
      readFileSync,
      mkdirSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
      appendFileSync: vi.fn(),
    },
  };
});

const { buildContainerContext } = await import("./index.js");

describe("buildContainerContext", () => {
  beforeEach(() => {
    existsSync.mockReset();
    readFileSync.mockReset();
    existsSync.mockImplementation((target) =>
      [
        "/workspace/persona/PERSON.md",
        "/workspace/persona/RELATIONSHIPS.md",
        "/workspace/group/CLAUDE.md",
        "/workspace/global/CLAUDE.md",
      ].includes(target),
    );
    readFileSync.mockImplementation((target) => {
      switch (target) {
        case "/workspace/persona/PERSON.md":
          return "persona instructions";
        case "/workspace/persona/RELATIONSHIPS.md":
          return "relationship instructions";
        case "/workspace/group/CLAUDE.md":
          return "group instructions";
        case "/workspace/global/CLAUDE.md":
          return "global instructions";
        default:
          throw new Error(`Unexpected path: ${target}`);
      }
    });
  });

  it("includes persona, global, and group instructions for non-main groups", () => {
    expect(
      buildContainerContext({
        prompt: "hello",
        groupFolder: "g",
        chatJid: "jid",
        isMain: false,
      }),
    ).toEqual({
      persona: {
        personality: "persona instructions",
        relationships: "relationship instructions",
      },
      globalInstructions: "global instructions",
      groupInstructions: "group instructions",
    });
  });

  it("omits global instructions for the main group", () => {
    expect(
      buildContainerContext({
        prompt: "hello",
        groupFolder: "g",
        chatJid: "jid",
        isMain: true,
      }),
    ).toEqual({
      persona: {
        personality: "persona instructions",
        relationships: "relationship instructions",
      },
      groupInstructions: "group instructions",
    });
  });
});
