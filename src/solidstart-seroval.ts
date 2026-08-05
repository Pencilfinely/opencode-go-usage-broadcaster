import { parse } from "acorn";

import { SourceError } from "./domain";

const MAX_STREAM_BYTES = 512 * 1024;
const FRAME_HEADER_BYTES = 12;
const MAX_AST_NODES = 10_000;
const MAX_AST_DEPTH = 64;
const MAX_REFERENCE_INDEX = 9_999;

type AstNode = {
  type: string;
  [key: string]: unknown;
};

function invalid(reason: string): never {
  throw new SourceError("schema", `SolidStart Seroval 响应无效：${reason}`);
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null &&
    typeof (value as { type?: unknown }).type === "string";
}

function requireNode(value: unknown, type: string, reason: string): AstNode {
  if (!isNode(value) || value.type !== type) invalid(reason);
  return value;
}

function requireAnyNode(value: unknown, reason: string): AstNode {
  if (!isNode(value)) invalid(reason);
  return value;
}

function isIdentifier(value: unknown, name: string): boolean {
  return isNode(value) && value.type === "Identifier" && value.name === name;
}

function isEmptyArray(value: unknown): boolean {
  return isNode(value) && value.type === "ArrayExpression" &&
    Array.isArray(value.elements) && value.elements.length === 0;
}

function isEmptyObject(value: unknown): boolean {
  return isNode(value) && value.type === "ObjectExpression" &&
    Array.isArray(value.properties) && value.properties.length === 0;
}

function isSelfRegistryMember(value: unknown): boolean {
  if (!isNode(value) || value.type !== "MemberExpression") return false;
  return value.computed === false && value.optional !== true &&
    isIdentifier(value.object, "self") && isIdentifier(value.property, "$R");
}

function literalValue(value: unknown): unknown {
  if (!isNode(value) || value.type !== "Literal") return undefined;
  return value.value;
}

function registryMemberProperty(value: unknown): unknown {
  if (!isNode(value) || value.type !== "MemberExpression") return undefined;
  if (value.computed !== true || value.optional === true || !isIdentifier(value.object, "$R")) {
    return undefined;
  }
  return literalValue(value.property);
}

function assertAstLimits(root: AstNode): void {
  const pending: Array<{ node: AstNode; depth: number }> = [{ node: root, depth: 1 }];
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    count += 1;
    if (count > MAX_AST_NODES) invalid("AST 节点过多");
    if (current.depth > MAX_AST_DEPTH) invalid("AST 嵌套过深");
    for (const value of Object.values(current.node)) {
      if (isNode(value)) {
        pending.push({ node: value, depth: current.depth + 1 });
      } else if (Array.isArray(value)) {
        for (const child of value) {
          if (isNode(child)) {
            pending.push({ node: child, depth: current.depth + 1 });
          }
        }
      }
    }
  }
}

function decodeSingleFrame(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  if (bytes.byteLength > MAX_STREAM_BYTES) invalid("响应体超过 512 KiB");
  if (bytes.byteLength <= FRAME_HEADER_BYTES) invalid("必须包含一个非空帧");
  if (
    bytes[0] !== 0x3b ||
    bytes[1] !== 0x30 ||
    bytes[2] !== 0x78 ||
    bytes[11] !== 0x3b
  ) {
    invalid("帧头格式无效");
  }
  let declaredLength = 0;
  for (let index = 3; index < 11; index += 1) {
    const byte = bytes[index]!;
    let digit: number;
    if (byte >= 0x30 && byte <= 0x39) digit = byte - 0x30;
    else if (byte >= 0x61 && byte <= 0x66) digit = byte - 0x61 + 10;
    else invalid("帧长度必须使用小写十六进制");
    declaredLength = declaredLength * 16 + digit;
  }
  const actualLength = bytes.byteLength - FRAME_HEADER_BYTES;
  if (declaredLength === 0 || declaredLength !== actualLength) {
    invalid("帧长度与数据不一致");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(FRAME_HEADER_BYTES)
    );
  } catch {
    invalid("帧数据不是有效 UTF-8");
  }
}

function parseCompleteExpression(source: string): AstNode {
  let program: AstNode;
  try {
    program = parse(source, {
      ecmaVersion: 2024,
      sourceType: "script"
    }) as unknown as AstNode;
  } catch {
    invalid("帧不是完整 JavaScript 表达式");
  }
  assertAstLimits(program);
  if (!Array.isArray(program.body) || program.body.length !== 1) {
    invalid("帧必须只含一个表达式");
  }
  const statement = requireNode(program.body[0], "ExpressionStatement", "帧必须是表达式");
  return requireNode(statement.expression, "SequenceExpression", "外层包装器无效");
}

function validateInitializer(value: unknown): string {
  const assignment = requireNode(value, "AssignmentExpression", "初始化器无效");
  if (assignment.operator !== "=" || !isEmptyArray(assignment.right)) {
    invalid("初始化器无效");
  }
  const target = requireNode(assignment.left, "MemberExpression", "初始化目标无效");
  if (target.computed !== true || target.optional === true) invalid("初始化目标无效");
  const instance = literalValue(target.property);
  if (typeof instance !== "string" || !/^server-fn:[0-9]+$/u.test(instance)) {
    invalid("实例名无效");
  }
  const registryAssignment = requireNode(
    target.object,
    "AssignmentExpression",
    "注册表初始化无效"
  );
  if (registryAssignment.operator !== "=" || !isSelfRegistryMember(registryAssignment.left)) {
    invalid("注册表初始化无效");
  }
  const fallback = requireNode(
    registryAssignment.right,
    "LogicalExpression",
    "注册表初始化无效"
  );
  if (
    fallback.operator !== "||" ||
    !isSelfRegistryMember(fallback.left) ||
    !isEmptyObject(fallback.right)
  ) {
    invalid("注册表初始化无效");
  }
  return instance;
}

function validateRootInvocation(value: unknown, instance: string): AstNode {
  const invocation = requireNode(value, "CallExpression", "根调用无效");
  if (invocation.optional === true || !Array.isArray(invocation.arguments) ||
      invocation.arguments.length !== 1) {
    invalid("根调用无效");
  }
  const argumentInstance = registryMemberProperty(invocation.arguments[0]);
  if (argumentInstance !== instance) invalid("根调用实例不匹配");

  const arrow = requireNode(invocation.callee, "ArrowFunctionExpression", "根函数无效");
  if (
    arrow.async === true ||
    arrow.generator === true ||
    arrow.expression !== true ||
    !Array.isArray(arrow.params) ||
    arrow.params.length !== 1 ||
    !isIdentifier(arrow.params[0], "$R")
  ) {
    invalid("根函数无效");
  }
  const assignment = requireNode(arrow.body, "AssignmentExpression", "根赋值无效");
  if (assignment.operator !== "=" || registryMemberProperty(assignment.left) !== 0) {
    invalid("根赋值无效");
  }
  return requireAnyNode(assignment.right, "根值无效");
}

function parseReferenceIndex(value: unknown): number | undefined {
  const property = registryMemberProperty(value);
  if (
    typeof property !== "number" ||
    !Number.isSafeInteger(property) ||
    property < 1 ||
    property > MAX_REFERENCE_INDEX
  ) {
    return undefined;
  }
  return property;
}

function decodeLiteral(node: AstNode): unknown {
  if (node.regex !== undefined || node.bigint !== undefined || typeof node.value === "bigint") {
    invalid("不支持的字面量");
  }
  const value = node.value;
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  invalid("只允许有限 JSON 字面量");
}

function decodePropertyKey(property: AstNode): string {
  const key = property.key;
  let decoded: string;
  if (isNode(key) && key.type === "Identifier" && typeof key.name === "string") {
    decoded = key.name;
  } else if (isNode(key) && key.type === "Literal") {
    const value = decodeLiteral(key);
    if (typeof value !== "string" && typeof value !== "number") {
      invalid("对象键必须是标识符、字符串或数字");
    }
    decoded = String(value);
  } else {
    invalid("对象键无效");
  }
  if (decoded === "__proto__" || decoded === "prototype" || decoded === "constructor") {
    invalid("对象键不安全");
  }
  return decoded;
}

function decodeValue(
  node: AstNode,
  references: Map<number, unknown>
): unknown {
  if (node.type === "Literal") return decodeLiteral(node);

  if (node.type === "UnaryExpression") {
    if (node.operator !== "-" || node.prefix !== true) invalid("不支持的运算符");
    const argument = requireNode(node.argument, "Literal", "负数格式无效");
    const value = decodeLiteral(argument);
    if (typeof value !== "number" || !Number.isFinite(-value)) invalid("负数格式无效");
    return -value;
  }

  if (node.type === "ArrayExpression") {
    if (!Array.isArray(node.elements) || node.elements.some((item) => item === null)) {
      invalid("数组不得包含空洞");
    }
    return node.elements.map((item) => decodeValue(
      requireAnyNode(item, "数组元素无效"),
      references
    ));
  }

  if (node.type === "ObjectExpression") {
    if (!Array.isArray(node.properties)) invalid("对象属性无效");
    const result = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    for (const rawProperty of node.properties) {
      const property = requireNode(rawProperty, "Property", "对象属性无效");
      if (
        property.kind !== "init" ||
        property.method !== false ||
        property.shorthand !== false ||
        property.computed !== false
      ) {
        invalid("对象属性形状无效");
      }
      const key = decodePropertyKey(property);
      if (keys.has(key)) invalid("对象键重复");
      keys.add(key);
      result[key] = decodeValue(
        requireAnyNode(property.value, "对象值无效"),
        references
      );
    }
    return result;
  }

  if (node.type === "AssignmentExpression") {
    if (node.operator !== "=") invalid("引用赋值运算符无效");
    const index = parseReferenceIndex(node.left);
    if (index === undefined) invalid("引用赋值目标无效");
    if (references.has(index)) invalid("引用重复赋值");
    const value = decodeValue(
      requireAnyNode(node.right, "引用值无效"),
      references
    );
    references.set(index, value);
    return value;
  }

  if (node.type === "MemberExpression") {
    const index = parseReferenceIndex(node);
    if (index === undefined || !references.has(index)) invalid("引用尚未赋值");
    return references.get(index);
  }

  if (node.type === "NewExpression") {
    if (!isIdentifier(node.callee, "Date") || !Array.isArray(node.arguments) ||
        node.arguments.length !== 1) {
      invalid("只允许 Date 构造器");
    }
    const argument = requireNode(node.arguments[0], "Literal", "日期参数无效");
    const value = decodeLiteral(argument);
    if (typeof value !== "string") invalid("日期参数必须是字符串");
    const date = new Date(value);
    if (!Number.isFinite(date.valueOf())) invalid("日期无效");
    return date.toISOString();
  }

  invalid(`不支持的 AST 节点 ${node.type}`);
}

export function parseSolidStartSerovalStream(input: string | Uint8Array): unknown {
  const expression = parseCompleteExpression(decodeSingleFrame(input));
  if (!Array.isArray(expression.expressions) || expression.expressions.length !== 2) {
    invalid("外层序列必须恰好包含初始化和根调用");
  }
  const instance = validateInitializer(expression.expressions[0]);
  const root = validateRootInvocation(expression.expressions[1], instance);
  return decodeValue(root, new Map());
}

export const SOLIDSTART_SEROVAL_LIMIT_BYTES = MAX_STREAM_BYTES;
