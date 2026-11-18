"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

// 通过 vm 加载 main.js 的纯逻辑：模拟 require，注入 obsidian / electron 的桩，
// 在不实例化插件的前提下，拿到顶层纯函数与教程常量。
const mainPath = path.join(__dirname, "..", "main.js");
const code = fs.readFileSync(mainPath, "utf8");

class StubModal {}
class StubPlugin {}
class StubItemView {}
class StubPluginSettingTab {}

const sandbox = {
  console,
  process,
  Buffer,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  module: { exports: {} },
  exports: {},
  require(id) {
    if (id === "obsidian") {
      return {
        Plugin: StubPlugin,
        ItemView: StubItemView,
        Notice: class {},
        PluginSettingTab: StubPluginSettingTab,
        Setting: class {},
        Menu: class {},
        Modal: StubModal,
        TFile: class {},
        TFolder: class {},
        requestUrl: () => {},
      };
    }
    if (id === "electron") {
      throw new Error("electron not available in unit test");
    }
    return require(id);
  },
};

vm.createContext(sandbox);
// 追加导出：把顶层纯函数与常量暴露出来，供测试断言（不修改 main.js 本体）。
vm.runInContext(
  code +
    "\n;module.exports.__test__ = { collectLevel, computeStreakDays, buildRecent14, dateKey, COMPUTE_GUIDE_STEPS };\n",
  sandbox
);
const t = sandbox.module.exports.__test__;

test("收集等级：按累计领取次数映射", () => {
  assert.equal(t.collectLevel(0).name, "青铜");
  assert.equal(t.collectLevel(9).name, "青铜");
  assert.equal(t.collectLevel(10).name, "白银");
  assert.equal(t.collectLevel(29).name, "白银");
  assert.equal(t.collectLevel(30).name, "黄金");
  assert.equal(t.collectLevel(59).name, "黄金");
  assert.equal(t.collectLevel(60).name, "铂金");
  assert.equal(t.collectLevel(99).name, "铂金");
  assert.equal(t.collectLevel(100).name, "钻石");
  assert.equal(t.collectLevel(150).name, "钻石");
});

test("连续打卡天数：整体连续计算", () => {
  const today = "2026-11-18";
  const d = (list) => new Set(list);
  assert.equal(t.computeStreakDays(d([]), today), 0);
  assert.equal(t.computeStreakDays(d(["2026-11-18"]), today), 1);
  assert.equal(t.computeStreakDays(d(["2026-11-18", "2026-11-17"]), today), 2);
  // 今天未打卡，从昨天起算（连续尚未中断）。
  assert.equal(t.computeStreakDays(d(["2026-11-17", "2026-11-16"]), today), 2);
  // 昨天断档，只算今天。
  assert.equal(t.computeStreakDays(d(["2026-11-18", "2026-11-16"]), today), 1);
  // 今天、昨天都没打卡。
  assert.equal(t.computeStreakDays(d(["2026-11-15"]), today), 0);
});

test("最近14天格子：生成顺序与状态", () => {
  const today = "2026-11-18";
  const days = t.buildRecent14(today, new Set(["2026-11-18", "2026-11-10"]));
  assert.equal(days.length, 14);
  assert.equal(days[0].key, "2026-11-05");
  assert.equal(days[0].day, 5);
  assert.equal(days[13].key, "2026-11-18");
  assert.equal(days[13].day, 18);
  assert.equal(days[13].isToday, true);
  assert.equal(days[13].checked, true);
  assert.equal(days[5].key, "2026-11-10");
  assert.equal(days[5].checked, true);
  assert.equal(days[6].checked, false);
  assert.equal(days[0].isToday, false);
});

test("领取教程：内容完整且覆盖关键说明", () => {
  const steps = t.COMPUTE_GUIDE_STEPS;
  assert.ok(Array.isArray(steps));
  assert.ok(steps.length >= 6);
  for (const [title, desc] of steps) {
    assert.equal(typeof title, "string");
    assert.ok(title.length > 0);
    assert.equal(typeof desc, "string");
    assert.ok(desc.length > 0);
  }
  const joined = steps.map((s) => s[0] + s[1]).join("");
  assert.ok(joined.includes("标记已收"));
  assert.ok(joined.includes("连续"));
  assert.ok(joined.includes("收集等级"));
  assert.ok(joined.includes("青铜"));
  assert.ok(joined.includes("钻石"));
});
