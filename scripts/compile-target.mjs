import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadImage } from 'canvas';
import { OfflineCompiler } from 'mind-ar/src/image-target/offline-compiler.js';

const input = resolve('public/targets/school-logo-target.jpg');
const output = resolve('public/targets/school-logo.mind');

console.log(`读取目标图：${input}`);
// 以 Buffer 读取，规避部分原生图像库在 Windows 中文路径下的 fopen 限制。
const image = await loadImage(await readFile(input));
const compiler = new OfflineCompiler();
let lastReported = -10;

await compiler.compileImageTargets([image], (progress) => {
  const rounded = Math.floor(progress / 10) * 10;
  if (rounded >= lastReported + 10) {
    lastReported = rounded;
    console.log(`编译进度：${Math.min(rounded, 100)}%`);
  }
});

await mkdir(resolve('public/targets'), { recursive: true });
await writeFile(output, compiler.exportData());
console.log(`已生成：${output}`);
