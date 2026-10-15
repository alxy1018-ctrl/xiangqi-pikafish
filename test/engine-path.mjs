/**
 * 测试用的引擎定位。
 *
 * 引擎默认在项目内的 engine/ 目录（随仓库分发），但允许用 XQ_ENGINE 环境变量覆盖，
 * 指向别处自己下载的 Pikafish。
 *
 * 注意 `dir` 的用途：Pikafish 启动时会**从工作目录**找 pikafish.nnue，
 * 所以 spawn 时必须把 cwd 设成引擎所在目录，否则它会报找不到权重。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const ENGINE_DIR = join(ROOT, 'engine');

export const EXE = process.env.XQ_ENGINE
  ?? (process.platform === 'win32'
    ? join(ENGINE_DIR, 'Pikafish-Windows-x86-64-universal.exe')
    : join(ENGINE_DIR, 'Pikafish-Linux-x86-64-universal'));

/** spawn 引擎时用的工作目录（必须与 exe 同目录，权重在那里） */
export const CWD = process.env.XQ_ENGINE ? dirname(process.env.XQ_ENGINE) : ENGINE_DIR;
