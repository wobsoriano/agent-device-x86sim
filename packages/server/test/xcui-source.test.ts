import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import type { AxNode } from '../src/types.ts';
import { toXcuiSource } from '../src/xcui-source.ts';

const node = (overrides: Partial<AxNode> & Pick<AxNode, 'type'>): AxNode => ({
  frame: { x: 0, y: 0, width: 10, height: 10 },
  enabled: true,
  visible: true,
  children: [],
  ...overrides,
});

test('wraps the tree in AppiumAUT with one tag per element type', () => {
  const source = toXcuiSource(
    node({
      type: 'XCUIElementTypeApplication',
      name: 'Example',
      frame: { x: 0, y: 0, width: 390, height: 844 },
      children: [
        node({
          type: 'XCUIElementTypeButton',
          name: 'Continue',
          label: 'Continue',
          frame: { x: 24, y: 700, width: 160, height: 48 },
        }),
      ],
    }),
  );
  const lines = source.split('\n');
  assert.equal(lines[0], '<?xml version="1.0" encoding="UTF-8"?>');
  assert.equal(lines[1], '<AppiumAUT>');
  assert.match(
    lines[2] ?? '',
    /^ {2}<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Example" enabled="true" visible="true" x="0" y="0" width="390" height="844">$/,
  );
  assert.match(
    lines[3] ?? '',
    /^ {4}<XCUIElementTypeButton type="XCUIElementTypeButton" name="Continue" label="Continue" enabled="true" visible="true" x="24" y="700" width="160" height="48" \/>$/,
  );
  assert.equal(lines[4], '  </XCUIElementTypeApplication>');
  assert.equal(lines[5], '</AppiumAUT>');
});

test('omits name, label and value when the node has none', () => {
  const source = toXcuiSource(node({ type: 'XCUIElementTypeApplication' }));
  assert.doesNotMatch(source, /\bname=|\blabel=|\bvalue=/);
});

test('keeps an empty value, which a text field reports before it is filled', () => {
  const source = toXcuiSource(node({ type: 'XCUIElementTypeTextField', value: '' }));
  assert.match(source, /value=""/);
});

test('reports disabled and hidden nodes', () => {
  const source = toXcuiSource(node({ type: 'XCUIElementTypeButton', enabled: false, visible: false }));
  assert.match(source, /enabled="false" visible="false"/);
});

test('escapes attribute values', () => {
  const source = toXcuiSource(node({ type: 'XCUIElementTypeStaticText', label: `Tom & "Jerry" <3 it's\nhere` }));
  assert.match(source, /label="Tom &amp; &quot;Jerry&quot; &lt;3 it&apos;s&#10;here"/);
});
