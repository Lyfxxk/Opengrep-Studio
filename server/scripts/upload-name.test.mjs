// multipart 文件名还原单测（node --test 运行，`npm test` 统一驱动）
// 历史 bug：busboy 默认按 latin1 解码 filename 参数，浏览器发的 UTF-8 中文名会变成
// 「è§åè§å.yaml」并原样进日志 / 默认包名 / 上传回显。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeUploadFileName } from '../src/routes/shared.ts';

test('latin1 乱码形态的中文文件名按 UTF-8 还原', () => {
  const original = 'E2E-JS规则包.yaml';
  const mojibake = Buffer.from(original, 'utf8').toString('latin1');
  assert.equal(decodeUploadFileName(mojibake), original);
});

test('已是正常 UTF-8 / ASCII 的文件名原样返回', () => {
  assert.equal(decodeUploadFileName('E2E-JS规则包.yaml'), 'E2E-JS规则包.yaml');
  assert.equal(decodeUploadFileName('report.sarif'), 'report.sarif');
  assert.equal(decodeUploadFileName('café.txt'), 'café.txt');
});
