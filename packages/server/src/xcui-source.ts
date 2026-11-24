import type { AxNode } from './types.ts';

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
  '\n': '&#10;',
  '\r': '&#13;',
  '\t': '&#9;',
};

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"'\n\r\t]/g, (char) => XML_ESCAPES[char] ?? char);
}

function attributes(node: AxNode): string {
  const pairs: Array<[string, string | undefined]> = [
    ['type', node.type],
    ['name', node.name],
    ['label', node.label],
    ['value', node.value],
    ['enabled', String(node.enabled)],
    ['visible', String(node.visible)],
    ['x', String(node.frame.x)],
    ['y', String(node.frame.y)],
    ['width', String(node.frame.width)],
    ['height', String(node.frame.height)],
  ];
  return pairs.flatMap(([key, value]) => (value === undefined ? [] : [`${key}="${escapeAttribute(value)}"`])).join(' ');
}

function element(node: AxNode, depth: number): string {
  const indent = '  '.repeat(depth);
  const open = `${indent}<${node.type} ${attributes(node)}`;
  if (node.children.length === 0) return `${open} />`;
  const children = node.children.map((child) => element(child, depth + 1)).join('\n');
  return `${open}>\n${children}\n${indent}</${node.type}>`;
}

/**
 * The XCUITest page source shape: an `AppiumAUT` wrapper around the element tree, one tag per
 * element named by its XCUIElementType, with geometry as `x`, `y`, `width` and `height`.
 * Absent `name`, `label` and `value` are omitted, as XCUITest omits null attributes.
 */
export function toXcuiSource(root: AxNode): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<AppiumAUT>\n${element(root, 1)}\n</AppiumAUT>`;
}
