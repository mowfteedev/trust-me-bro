/** Real temporary files and ssh2 parsing; no deployment keys or network. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { utils } from 'ssh2';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { validateBastionKey } from '../src/services/bastion/key.js';

const pair = utils.generateKeyPairSync('ed25519');
let directory: string;
let keyPath: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-bastion-key-'));
  keyPath = path.join(directory, 'private-key');
  fs.writeFileSync(keyPath, pair.private, { mode: 0o400 });
});
afterEach(() => {
  fs.chmodSync(directory, 0o700);
  fs.rmSync(directory, { recursive: true, force: true });
});

it('accepts a readable private Ed25519 regular file with mode0400', () => {
  expect(() => validateBastionKey(keyPath)).not.toThrow();
});
it.each([0o600, 0o640, 0o644, 0o777, 0o440, 0o4400])('rejects mode %s rather than just group/other read bits', (mode) => {
  fs.chmodSync(keyPath, mode);
  expect(() => validateBastionKey(keyPath)).toThrow('chmod 400');
});
it.each(['missing', 'directory', 'symlink'])('rejects a %s path', (kind) => {
  const invalid = path.join(directory, 'invalid');
  if (kind === 'directory') fs.mkdirSync(invalid, { mode: 0o400 });
  if (kind === 'symlink') fs.symlinkSync(keyPath, invalid);
  expect(() => validateBastionKey(invalid)).toThrow('BASTION_SSH_KEY_PATH');
  if (kind === 'directory') fs.chmodSync(invalid, 0o700);
});
it.each(['not-a-private-key', pair.public, utils.generateKeyPairSync('ecdsa', { bits: 256 }).private])(
  'rejects malformed, public-only or non-Ed25519 material without including it in the error', (material) => {
    fs.chmodSync(keyPath, 0o600);
    fs.writeFileSync(keyPath, material);
    fs.chmodSync(keyPath, 0o400);
    expect(() => validateBastionKey(keyPath)).toThrow('khóa riêng Ed25519');
    try { validateBastionKey(keyPath); } catch (error) { expect(String(error)).not.toContain(material); }
  },
);
it.skipIf(process.getuid?.() === 0)('rejects an existing0400 key that the service cannot access', () => {
  fs.chmodSync(directory, 0o000);
  expect(() => validateBastionKey(keyPath)).toThrow('chủ sở hữu');
});
