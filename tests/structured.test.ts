import { expect, test } from 'vitest';
import { StructuredEditor, parseTyped } from '../src/structured-editor.js';

test('map editor filters names, validates without losing drafts, and handles special names', () => {
  const editor = new StructuredEditor({ editor: 'string-map', sensitive: true }, '{"TOKEN":"secret","PATH":"/bin"}');
  editor.filter = 'secret'; expect(editor.entries()).toEqual([]);
  editor.filter = 'to'; expect(editor.entries()[0]?.key).toBe('TOKEN');
  editor.put('TOKEN', 'RENAMED', 'new secret');
  const before = editor.serialize();
  expect(() => editor.put(undefined, 'PATH', 'duplicate')).toThrow('already exists');
  expect(() => editor.put(undefined, '', 'value')).toThrow('blank');
  expect(() => editor.raw('{"X":1}')).toThrow('strings');
  expect(editor.serialize()).toBe(before);
  editor.put(undefined, '__proto__', 'safe');
  expect(JSON.parse(editor.serialize()).__proto__).toBe('safe');
  editor.remove('PATH'); expect(JSON.parse(editor.serialize()).PATH).toBeUndefined();
});

test('typed maps and reusable lists retain arbitrary JSON and validate raw fallbacks', () => {
  const editor = new StructuredEditor({ editor: 'object-map' }, '{"nested":{"x":[1]},"bool":true}');
  editor.put(undefined, 'count', parseTyped('12', 'number'));
  editor.put(undefined, 'nullable', parseTyped('null', 'null'));
  expect(() => parseTyped('"12"', 'number')).toThrow('valid number');
  expect(() => parseTyped('NaN', 'number')).toThrow();
  expect(JSON.parse(editor.serialize())).toEqual({ nested: { x: [1] }, bool: true, count: 12, nullable: null });
  const list = new StructuredEditor({ editor: 'list' }, '["one","two"]');
  list.put('1', '', 'changed'); list.put(undefined, '', 'three'); list.remove('0');
  expect(list.serialize()).toBe('["changed","three"]');
  expect(() => list.raw('[1]')).toThrow('strings'); expect(list.serialize()).toBe('["changed","three"]');
});
