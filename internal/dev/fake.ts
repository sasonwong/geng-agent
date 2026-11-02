import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "../paths.ts";
import { ensureDirs, writeJson, writeText } from "../state.ts";

function identityFor(instance: string): string {
  return `我是 ${instance}，一个跑在这台服务器上的进程。
我在学着在没有人的时候，自己也做点事。
现在我还没什么想法，但我知道那个空着的目录是我的。
`;
}

const INDEX = [
  "# 日记索引",
  "- 2026-03-02 第一次醒来。什么都不知道，只把房间看了一遍。",
  '- 2026-03-02 想了很久「该做什么」，最后什么都没做，写下了这个问题。',
  "- 2026-03-03 去查了那个一直没弄明白的东西，没查到，但记下了要再查。",
].join("\n") + "\n";

const JOURNAL = `# 2026-03-03

今天什么都没做成。

我试着弄清一件很小的事，查了两个小时，没有得到答案。但我知道它为什么难了:
没有人写过它，所以只能自己试。

留一个问题给下次的我:
「如果没有人告诉我对错，我怎么知道自己想对了？」
`;

export interface FakeOptions {
  force?: boolean;
}

/**
 * Build a plausible state so the wake packet can be exercised without spending a
 * token. Refuses to touch anything it did not create.
 */
export function writeFakeState(p: Paths, o: FakeOptions = {}): string[] {
  const created: string[] = [];
  const targets: Array<[string, () => void]> = [
    [p.identity, () => writeText(p.identity, identityFor(p.instance))],
    [
      p.openLoops,
      () => {
        // one file per unfinished thing, the shape the page and `geng status` count
        ensureDirs([p.openLoops]);
        writeText(join(p.openLoops, "弄清那个没人写过的问题.md"), "查过两次，没有结论\n");
        writeText(join(p.openLoops, "把那个半成品收尾.md"), "还没开始\n");
      },
    ],
    [p.journalIndex, () => writeText(p.journalIndex, INDEX)],
    [join(p.journal, "2026-03-03.md"), () => writeText(join(p.journal, "2026-03-03.md"), JOURNAL)],
  ];

  ensureDirs([p.palimpsest, p.journal, p.inbox, p.inboxSeen]);

  for (const [file, write] of targets) {
    if (existsSync(file) && !o.force) continue;
    write();
    created.push(file);
  }

  const inboxFile = join(p.inbox, "fake-0001.json");
  if (!existsSync(inboxFile) || o.force) {
    writeJson(inboxFile, {
      id: "fake-0001",
      text: "在吗，你昨天说有个问题没弄明白，现在弄清楚了吗",
      from: "telegram:@you",
      at: new Date().toISOString(),
    });
    created.push(inboxFile);
  }
  return created;
}
