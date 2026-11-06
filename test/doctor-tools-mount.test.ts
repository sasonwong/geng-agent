import { test } from "node:test";
import assert from "node:assert/strict";
import { toolMountVerdict } from "../internal/doctor.ts";

// `probe()` 要 docker，所以这张判定表只能在函数外单独测。这里的每一条都对着一个具体分支：
// 空串不是证据、零个不是证据、探针没回话也不是证据。

const HOST = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const OTHER = "f9e8d7c6b5a4f9e8d7c6b5a4f9e8d7c6b5a4f9e8";
// `sha1sum` 对空输入给的就是这一串：容器目录不在了、cksum 一个文件没吐，探针仍会报 40 位非空。
// 所以「容器里 0 个」不等于「摘要没算出来」，两者要分开验。
const SHA_OF_NOTHING = "da39a3ee5e6b4b0d3255bfef95601890afd80709";

test("两侧都空、容器里 0 个 —— 不说「挂载缺了」，说摘要没算出来（#60 的取捨）", () => {
  const v = toolMountVerdict(3, 0, "", "");
  assert.equal(v.mounted, false);
  assert.match(v.detail, /摘要没算出来/);
  assert.doesNotMatch(v.detail, /挂载缺了/);
});

test("两侧都空、个数还相同 —— 不许因为两个空串相等就判「一致」", () => {
  const v = toolMountVerdict(3, 3, "", "");
  assert.equal(v.mounted, false);
  assert.match(v.detail, /摘要没算出来/);
  assert.match(v.detail, /宿主那一侧是空的/);
});

test("只有容器侧空 —— 指认的是容器那一侧", () => {
  const v = toolMountVerdict(3, 3, HOST, "");
  assert.equal(v.mounted, false);
  assert.match(v.detail, /容器那一侧是空的/);
});

test("两侧摘要真的一样、宿主有货 —— 这才是挂载对上了", () => {
  const v = toolMountVerdict(3, 3, HOST, HOST);
  assert.equal(v.mounted, true);
  assert.match(v.detail, /内容与宿主一致（a1b2c3d4）/);
});

test("个数相同、内容不同 —— 这条就是这个检查存在的理由", () => {
  const v = toolMountVerdict(3, 3, HOST, OTHER);
  assert.equal(v.mounted, false);
  assert.match(v.detail, /个数相同但内容不同（a1b2c3d4 → f9e8d7c6）/);
});

test("容器里 0 个、但摘要是空输入的 sha1（非空）—— 这才叫挂载缺了，要说得像会死人", () => {
  const v = toolMountVerdict(3, 0, HOST, SHA_OF_NOTHING);
  assert.equal(v.mounted, false);
  assert.match(v.detail, /挂载缺了/);
  assert.match(v.detail, /exit\(1\)/);
});

test("探针没回话（-1）优先于其它一切 —— 连个数都没有就别谈内容", () => {
  const v = toolMountVerdict(3, -1, HOST, "");
  assert.equal(v.mounted, false);
  assert.match(v.detail, /探针没数出来/);
});

test("宿主侧空、容器计数也是 0 —— 先报摘要没算出来，不冒充「挂载缺了」", () => {
  const v = toolMountVerdict(3, 0, "", "");
  assert.equal(v.mounted, false);
  assert.match(v.detail, /摘要没算出来/);
});

test("探针没回话时，即便容器摘要那串「空输入 sha1」也在，也不许当成比对结果", () => {
  const v = toolMountVerdict(3, -1, HOST, SHA_OF_NOTHING);
  assert.equal(v.mounted, false);
  assert.match(v.detail, /探针没数出来/);
});

test("宿主一个 .ts 都没有 —— 检查无从比起", () => {
  const v = toolMountVerdict(0, 0, "", "");
  assert.equal(v.mounted, false);
  assert.match(v.detail, /检查无从比起/);
});

test("个数不同、两边摘要都算得出来 —— 两个数都报出来", () => {
  const v = toolMountVerdict(4, 2, HOST, OTHER);
  assert.equal(v.mounted, false);
  assert.match(v.detail, /宿主 image\/extensions 里 4 个（a1b2c3d4），容器里 2 个（f9e8d7c6）/);
});
