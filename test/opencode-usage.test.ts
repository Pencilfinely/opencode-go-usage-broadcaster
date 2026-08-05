import { describe, expect, it } from "vitest";
import { SourceError } from "../src/domain";
import { parseUsageListPage } from "../src/opencode-usage";

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "use_1",
  timeCreated: "2026-08-05T02:30:00.000Z",
  provider: "anthropic",
  model: "claude-sonnet",
  inputTokens: 10,
  outputTokens: 20,
  reasoningTokens: null,
  cacheReadTokens: null,
  cacheWrite5mTokens: null,
  cacheWrite1hTokens: null,
  cost: 25000000,
  ...overrides
});

const encoder = new TextEncoder();

function frame(expression: string): string {
  const length = encoder.encode(expression).byteLength.toString(16).padStart(8, "0");
  return `;0x${length};${expression}`;
}

function serovalRoot(root: string, instance = "server-fn:7"): string {
  return `((self.$R=self.$R||{})["${instance}"]=[],($R=>$R[0]=${root})($R["${instance}"]))`;
}

const SEROVAL_RECORD = '{id:"use_shared",timeCreated:new Date("2026-08-05T02:30:00.000Z"),provider:"anthropic",model:"claude-sonnet",inputTokens:10,outputTokens:20,reasoningTokens:null,cacheReadTokens:null,cacheWrite5mTokens:null,cacheWrite1hTokens:null,cost:25000000}';

function expectSchemaFailure(action: () => unknown): void {
  try {
    action();
    throw new Error("预期 schema 错误");
  } catch (error) {
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).kind).toBe("schema");
  }
}

describe("OpenCode 用量列表单页", () => {
  it("把空推理和缓存字段规范化为零", () => {
    expect(parseUsageListPage(
      JSON.stringify([row()]),
      "application/json; charset=utf-8"
    )).toEqual([expect.objectContaining({
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      costMicroCents: 25000000
    })]);
  });

  it("拒绝非倒序的单页", () => {
    expect(() => parseUsageListPage(JSON.stringify([
      row({ id: "use_old", timeCreated: "2026-08-05T01:00:00.000Z" }),
      row({ id: "use_new", timeCreated: "2026-08-05T02:00:00.000Z" })
    ]), "application/json")).toThrow("倒序");
  });

  it("按 UTF-8 字节长度解码真实 SolidStart Seroval 初始帧", () => {
    const expression = serovalRoot(
      '[$R[1]={id:"use_中文",timeCreated:$R[2]=new Date("2026-08-05T02:30:00.000Z"),provider:"anthropic",model:"claude-sonnet",inputTokens:10,outputTokens:20,reasoningTokens:null,cacheReadTokens:null,cacheWrite5mTokens:null,cacheWrite1hTokens:null,cost:25000000,enrichment:$R[3]={plan:"sub"}}]'
    );

    expect(parseUsageListPage(frame(expression), "text/javascript; charset=utf-8"))
      .toEqual([{
        id: "use_中文",
        occurredAt: Date.parse("2026-08-05T02:30:00.000Z"),
        provider: "anthropic",
        model: "claude-sonnet",
        plan: "sub",
        inputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        costMicroCents: 25000000
      }]);
  });

  it("解码 SolidStart Seroval 空数组初始帧", () => {
    expect(parseUsageListPage(
      frame(serovalRoot("[]", "server-fn:0")),
      "text/javascript"
    )).toEqual([]);
  });

  it("允许先赋值后复用相同的 Seroval 引用", () => {
    const result = parseUsageListPage(
      frame(serovalRoot(`[$R[1]=${SEROVAL_RECORD},$R[1]]`)),
      "text/javascript"
    );

    expect(result).toHaveLength(2);
    expect(result.map((item) => item.id)).toEqual(["use_shared", "use_shared"]);
  });

  it("有界拒绝共享容器组成的指数展开 DAG", () => {
    const assignments = [`$R[1]=[${SEROVAL_RECORD}]`];
    for (let index = 2; index <= 18; index += 1) {
      assignments.push(`$R[${index}]=[$R[${index - 1}],$R[${index - 1}]]`);
    }
    const expression = serovalRoot(`[${assignments.join(",")},$R[18]]`);

    expect(() => parseUsageListPage(frame(expression), "text/javascript"))
      .toThrow("重复容器引用");
  });

  it.each([
    ["函数调用", 'fetch("https://evil.invalid")'],
    ["模板字符串", "`evil`"],
    ["函数", "function () {}"],
    ["类", "class {}"],
    ["正则", "/evil/u"],
    ["BigInt", "1n"],
    ["非有限数字", "1e999"],
    ["全局成员访问", "self.$R"],
    ["前向引用", "$R[1]"],
    ["自引用或循环赋值", "$R[1]=[$R[1]]"],
    ["重复引用赋值", "[$R[1]={},$R[1]={}]"],
    ["越界引用", "$R[999999999]=1"],
    ["稀疏数组", "[,1]"],
    ["无效日期", 'new Date("not-a-date")'],
    ["其他构造器", "new Map()"],
    ["getter", "{get value(){return 1}}"],
    ["方法", "{method(){return 1}}"],
    ["简写属性", "{value}"],
    ["计算键", '{["value"]:1}'],
    ["spread", "{...{value:1}}"],
    ["重复对象键", '{"value":1,value:2}'],
    ["转义危险键", '{"__pro\\u0074o__":1}'],
    ["constructor 键", "{constructor:1}"],
    ["prototype 键", "{prototype:1}"]
  ])("拒绝 Seroval 根值中的恶意或越权语法：%s", (_name, root) => {
    expectSchemaFailure(() => parseUsageListPage(
      frame(serovalRoot(root)),
      "text/javascript"
    ));
  });

  it.each([
    ["初始化实例不匹配", serovalRoot("[]").replace(
      '$R["server-fn:7"]',
      '$R["server-fn:8"]'
    )],
    ["负数实例", serovalRoot("[]", "server-fn:-1")],
    ["多根赋值", '((self.$R=self.$R||{})["server-fn:7"]=[],($R=>($R[0]=[],$R[0]=[]))($R["server-fn:7"]))'],
    ["尾随语法", serovalRoot("[]") + ";globalThis.compromised=true"]
  ])("拒绝被篡改的 SolidStart 外层包装器：%s", (_name, expression) => {
    expectSchemaFailure(() => parseUsageListPage(frame(expression), "text/javascript"));
  });

  it("拒绝多个帧", () => {
    const valid = frame(serovalRoot("[]"));
    expectSchemaFailure(() => parseUsageListPage(valid + valid, "text/javascript"));
  });

  it("拒绝格式不精确、长度不符或超过限制的帧", () => {
    const valid = frame(serovalRoot("[]"));
    const declared = Number.parseInt(valid.slice(3, 11), 16);
    const wrongLength = `;0x${(declared + 1).toString(16).padStart(8, "0")};${valid.slice(12)}`;
    const cases: Array<string | Uint8Array> = [
      "",
      valid.slice(0, 2) + "X" + valid.slice(3),
      wrongLength,
      "garbage" + valid,
      valid + "garbage",
      new Uint8Array(512 * 1024 + 1)
    ];
    for (const input of cases) {
      expectSchemaFailure(() => parseUsageListPage(input, "text/javascript"));
    }
  });

  it("拒绝帧数据中的无效 UTF-8，而不先替换为 U+FFFD", () => {
    const header = encoder.encode(";0x00000001;");
    const bytes = new Uint8Array(header.byteLength + 1);
    bytes.set(header);
    bytes[header.byteLength] = 0xff;

    expectSchemaFailure(() => parseUsageListPage(bytes, "text/javascript"));
  });

  it("拒绝超过 AST 深度和节点数量上限的帧", () => {
    const tooDeep = "[".repeat(65) + "0" + "]".repeat(65);
    const tooManyNodes = `[${Array.from({ length: 10_001 }, () => "0").join(",")}]`;

    expectSchemaFailure(() => parseUsageListPage(
      frame(serovalRoot(tooDeep)),
      "text/javascript"
    ));
    expectSchemaFailure(() => parseUsageListPage(
      frame(serovalRoot(tooManyNodes)),
      "text/javascript"
    ));
  });
});
