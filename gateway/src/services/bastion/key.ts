import fs from 'node:fs';
import { utils } from 'ssh2';

export function validateBastionKey(keyPath: string): void {
  let fd: number | undefined;
  try {
    // Inspect the same file we parse; reject symlinks and never wait on a FIFO.
    fd = fs.openSync(keyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o400) {
      throw new Error('invalid-key-permissions');
    }
    const key = utils.parseKey(fs.readFileSync(fd));
    if (key instanceof Error || !key.isPrivateKey() || key.type !== 'ssh-ed25519') {
      throw new Error('invalid-private-key');
    }
  } catch {
    throw new Error('BASTION_SSH_KEY_PATH phải là tệp khóa riêng Ed25519 hợp lệ, Gateway đọc được, quyền chmod 400; kiểm tra đường dẫn và chủ sở hữu.');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
