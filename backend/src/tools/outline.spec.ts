import { describe, expect, it } from 'vitest';
import { extractImport, extractSymbol } from './outline.js';

describe('extractSymbol', () => {
  it.each([
    ['class Repo {', 'class', 'Repo'],
    ['export class Repo {', 'class', 'Repo'],
    ['export default abstract class Repo<T> {', 'class', 'Repo'],
    ['export interface UserRecord {', 'interface', 'UserRecord'],
    ['type Id = string;', 'type', 'Id'],
    ['export enum Color {', 'enum', 'Color'],
    ['export async function load(path: string) {', 'function', 'load'],
    ['function* walk() {', 'function', 'walk'],
    ['pub async fn run(input: &str) {', 'function', 'run'],
    ['pub struct Config {', 'class', 'Config'],
    ['def handler(request):', 'function', 'handler'],
    ['func Run(input string) error {', 'function', 'Run'],
    ['func (r *Repo) Save(ctx context.Context) error {', 'function', 'Save'],
    ['export const authenticate = async (token: string) => true;', 'function', 'authenticate'],
    ['const debounce = (fn) => fn;', 'function', 'debounce'],
  ])('reads %s as %s %s', (line, kind, name) => {
    expect(extractSymbol(line)).toEqual({ kind, name });
  });

  it.each([
    '',
    '// class Repo {',
    'return classify(value);',
    'const total = 1 + 2;',
    'const handler = createHandler();',
    'class',
    'export const',
    'someClass.method();',
  ])('ignores %s', (line) => {
    expect(extractSymbol(line)).toBeUndefined();
  });

  it('stays linear on a pathological line of modifiers', () => {
    // The regex version this replaced backtracked super-linearly on exactly this.
    const line = `${'export '.repeat(20_000)}class`;

    const startedAt = performance.now();
    expect(extractSymbol(line)).toBeUndefined();
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});

describe('extractImport', () => {
  it.each([
    ["import { readFile } from 'node:fs/promises';", 'node:fs/promises'],
    ['import React from "react";', 'react'],
    ["import './styles.css';", './styles.css'],
    ["const path = require('node:path');", 'node:path'],
    ['from django.db import models', 'django.db'],
    ['use std::collections::HashMap;', 'std::collections::HashMap'],
  ])('reads %s as %s', (line, expected) => {
    expect(extractImport(line)).toBe(expected);
  });

  it.each(['', 'const x = 1;', 'importantThing();', 'usefulHelper();'])('ignores %s', (line) => {
    expect(extractImport(line)).toBeUndefined();
  });
});
